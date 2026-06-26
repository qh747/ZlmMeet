package signaling

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/zlm"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 1 << 20 // 1MB to accommodate SDP payloads
)

// Client wraps a single WebSocket connection.
type Client struct {
	UserID   string
	Nickname string

	hub  *Hub
	room *Room

	conn   *websocket.Conn
	sendCh chan []byte

	mu         sync.RWMutex
	micOn      bool
	camOn      bool
	streams    map[string]string // kind -> streamId currently published
	recordings map[string]bool   // kind -> recording on/off
	closed     bool
}

func newClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		UserID:     uuid.NewString(),
		hub:        hub,
		conn:       conn,
		sendCh:     make(chan []byte, 32),
		streams:    make(map[string]string),
		recordings: make(map[string]bool),
		micOn:      true,
		camOn:      true,
	}
}

// ServeWS upgrades an HTTP connection and runs read/write loops.
func ServeWS(hub *Hub, upgrader *websocket.Upgrader, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Warn().Err(err).Msg("ws upgrade")
		return
	}
	c := newClient(conn, hub)
	go c.writeLoop()
	c.readLoop()
}

func (c *Client) readLoop() {
	defer c.cleanup()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Debug().Err(err).Str("user_id", c.UserID).Msg("client read")
			}
			return
		}
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			c.sendError(fmt.Sprintf("bad envelope: %v", err))
			continue
		}
		if err := c.dispatch(&env); err != nil {
			c.replyError(&env, err)
		}
	}
}

func (c *Client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.sendCh:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) cleanup() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	close(c.sendCh)
	c.mu.Unlock()

	if c.room != nil {
		c.room.removeClient(c)
	}
	_ = c.conn.Close()
}

// send marshals the envelope and pushes to the writer. Drops the message if
// the client is already disconnected or its outbound buffer is full (to keep
// one slow client from blocking the room).
func (c *Client) send(msgType, reqID string, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Warn().Err(err).Str("user_id", c.UserID).Msg("marshal payload")
		return
	}
	env := Envelope{Type: msgType, ReqID: reqID, Payload: body}
	raw, err := json.Marshal(env)
	if err != nil {
		log.Warn().Err(err).Str("user_id", c.UserID).Msg("marshal envelope")
		return
	}
	c.mu.RLock()
	closed := c.closed
	c.mu.RUnlock()
	if closed {
		return
	}
	select {
	case c.sendCh <- raw:
	default:
		log.Warn().Str("user_id", c.UserID).Str("type", msgType).Msg("send buffer full, dropping")
	}
}

func (c *Client) sendError(msg string) {
	c.send(TypeError, "", ErrorPayload{Message: msg})
}

// replyError responds to a client request. When reqId is present the client
// correlates via its pending map; otherwise fall back to a fire-and-forget error.
func (c *Client) replyError(env *Envelope, err error) {
	if env != nil && env.ReqID != "" {
		c.send(TypeError, env.ReqID, ErrorPayload{Message: err.Error()})
		return
	}
	c.sendError(err.Error())
}

// dispatch routes incoming messages by type. Returns an error to be sent back
// to the client as a TypeError reply.
func (c *Client) dispatch(env *Envelope) error {
	switch env.Type {
	case TypeJoin:
		return c.handleJoin(env)
	case TypeLeave:
		// Trigger cleanup; the read loop will exit on next iteration.
		_ = c.conn.Close()
		return nil
	case TypeChat:
		return c.handleChat(env)
	case TypeMediaState:
		return c.handleMediaState(env)
	case TypeWebRTCOffer:
		return c.handleWebRTCOffer(env)
	case TypeStreamStarted:
		return c.handleStreamStarted(env)
	case TypeStreamStopped:
		return c.handleStreamStopped(env)
	case TypeRecordStart:
		return c.handleRecordControl(env, true)
	case TypeRecordStop:
		return c.handleRecordControl(env, false)
	default:
		return fmt.Errorf("unknown message type %q", env.Type)
	}
}

func (c *Client) requireRoom() error {
	if c.room == nil {
		return errors.New("not joined to a room")
	}
	return nil
}

func decodePayload[T any](env *Envelope, dst *T) error {
	if len(env.Payload) == 0 {
		return nil
	}
	return json.Unmarshal(env.Payload, dst)
}

// --- handlers -----------------------------------------------------------------

func (c *Client) handleJoin(env *Envelope) error {
	if c.room != nil {
		return errors.New("already joined a room")
	}
	var p JoinPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode join: %w", err)
	}
	if err := c.hub.ValidateToken(p.Token); err != nil {
		return err
	}
	if p.Room == "" {
		return errors.New("room is required")
	}
	if p.Nickname == "" {
		p.Nickname = "anon-" + c.UserID[:6]
	}
	mode := p.Mode
	if mode == "" {
		mode = RoomModeMeeting
	}
	switch mode {
	case RoomModeMeeting, RoomModeCall, RoomModeSolo:
	default:
		return fmt.Errorf("invalid mode: %q", mode)
	}
	c.Nickname = p.Nickname
	if p.MicOn != nil {
		c.mu.Lock()
		c.micOn = *p.MicOn
		c.mu.Unlock()
	}
	if p.CamOn != nil {
		c.mu.Lock()
		c.camOn = *p.CamOn
		c.mu.Unlock()
	}
	room := c.hub.GetOrCreateRoom(p.Room, mode)
	if err := room.addClient(c, mode); err != nil {
		// Drop the empty room we may have just created.
		c.hub.removeRoomIfEmpty(room)
		return err
	}
	c.room = room
	return nil
}

func (c *Client) handleChat(env *Envelope) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p ChatPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode chat: %w", err)
	}
	if p.Text == "" {
		return nil
	}
	c.room.broadcastChat(c, p.Text)
	return nil
}

func (c *Client) handleMediaState(env *Envelope) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p MediaStatePayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode media-state: %w", err)
	}
	c.mu.Lock()
	c.micOn = p.MicOn
	c.camOn = p.CamOn
	c.mu.Unlock()
	c.room.broadcastMediaState(c)
	return nil
}

func (c *Client) handleWebRTCOffer(env *Envelope) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p WebRTCOfferPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode webrtc-offer: %w", err)
	}
	if p.SDP == "" {
		return errors.New("sdp is required")
	}

	var (
		streamID string
		rtcType  zlm.WebRTCType
	)

	switch p.Mode {
	case "publish":
		if p.Kind != "cam" && p.Kind != "screen" {
			return fmt.Errorf("invalid kind for publish: %q", p.Kind)
		}
		streamID = buildStreamID(c.UserID, p.Kind)
		rtcType = zlm.WebRTCPush
	case "play":
		if p.TargetUserID == "" {
			return errors.New("targetUserId is required for play")
		}
		if p.Kind != "cam" && p.Kind != "screen" {
			return fmt.Errorf("invalid kind for play: %q", p.Kind)
		}
		streamID = c.room.targetStreamID(p.TargetUserID, p.Kind)
		if streamID == "" {
			// Publisher may still be negotiating push. Fall back to the
			// deterministic stream name so watchers can retry play in parallel
			// with push setup instead of waiting for stream-started.
			streamID = buildStreamID(p.TargetUserID, p.Kind)
		}
		rtcType = zlm.WebRTCPlay
	case "publish-solo":
		if p.StreamID == "" {
			return errors.New("streamId is required for publish-solo")
		}
		if !isSafeStreamName(p.StreamID) {
			return errors.New("streamId contains unsupported characters")
		}
		streamID = p.StreamID
		rtcType = zlm.WebRTCPush
	case "play-solo":
		if p.StreamID == "" {
			return errors.New("streamId is required for play-solo")
		}
		if !isSafeStreamName(p.StreamID) {
			return errors.New("streamId contains unsupported characters")
		}
		if !c.room.hasStreamID(p.StreamID) {
			return errors.New(ErrStreamNotFound)
		}
		streamID = p.StreamID
		rtcType = zlm.WebRTCPlay
	default:
		return fmt.Errorf("invalid mode: %q", p.Mode)
	}

	// The room id doubles as the ZLM "app" — every interaction with ZLM goes
	// through this scoping value. Same room ⇔ same ZLM app, so peers and
	// solo publishers/players line up automatically.
	answerSDP, err := c.hub.zlm.ExchangeSDP(rtcType, c.room.ID, streamID, p.SDP)
	if err != nil {
		return fmt.Errorf("zlm sdp exchange: %w", err)
	}

	// Register published streams so entry-check and play can resolve them.
	switch p.Mode {
	case "publish":
		c.mu.Lock()
		c.streams[p.Kind] = streamID
		c.mu.Unlock()
		// Always notify peers so they (re)pull — needed when a joiner publishes
		// late or republishes after adding tracks.
		c.room.broadcastStreamStarted(c, p.Kind, streamID)
	case "publish-solo":
		c.mu.Lock()
		c.streams["solo"] = streamID
		c.mu.Unlock()
		c.room.broadcastStreamStarted(c, "solo", streamID)
	}

	c.send(TypeWebRTCAnswer, env.ReqID, WebRTCAnswerPayload{
		Mode:         p.Mode,
		Kind:         p.Kind,
		TargetUserID: p.TargetUserID,
		StreamID:     streamID,
		SDP:          answerSDP,
	})
	return nil
}

func (c *Client) handleStreamStarted(env *Envelope) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p StreamStartedPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode stream-started: %w", err)
	}
	if p.Kind == "" || p.StreamID == "" {
		return errors.New("kind and streamId are required")
	}
	c.mu.Lock()
	c.streams[p.Kind] = p.StreamID
	c.mu.Unlock()
	c.room.broadcastStreamStarted(c, p.Kind, p.StreamID)
	return nil
}

func (c *Client) handleStreamStopped(env *Envelope) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p StreamStoppedPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode stream-stopped: %w", err)
	}
	if p.Kind == "" {
		return errors.New("kind is required")
	}

	c.mu.Lock()
	sid := c.streams[p.Kind]
	delete(c.streams, p.Kind)
	c.mu.Unlock()

	if sid != "" {
		// Broadcast first so watching clients tear down immediately — don't
		// wait for the ZLM HTTP call to complete.
		c.room.broadcastStreamStopped(c, p.Kind, sid)
		go func(app, streamID string) {
			if err := c.hub.zlm.CloseStream(app, streamID); err != nil {
				log.Warn().Err(err).Str("user_id", c.UserID).Str("stream", streamID).Msg("close stream")
			}
		}(c.room.ID, sid)
	}
	return nil
}

// buildStreamID assembles a deterministic stream name for a (user, kind)
// pair. The ZLM "app" already isolates rooms, so the stream name doesn't
// need to repeat the room id. Format: user_<userId>_<kind>
func buildStreamID(userID, kind string) string {
	return fmt.Sprintf("user_%s_%s", userID, kind)
}

// zlmRecordType returns the fixed MP4 record container used by all flows.
// Centralised so room cleanup can also reference it.
func zlmRecordType() zlm.RecordType { return zlm.RecordMP4 }

// isSafeStreamName limits solo-mode stream names to safe ASCII so they can be
// used directly in ZLM stream paths without escaping surprises.
func isSafeStreamName(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-' || r == '.':
		default:
			return false
		}
	}
	return true
}

// handleRecordControl starts or stops ZLM recording for a stream this client
// currently publishes. The lookup goes by `kind` for room streams, or by
// `streamId` for solo publishers. The server only allows clients to control
// streams they own.
func (c *Client) handleRecordControl(env *Envelope, start bool) error {
	if err := c.requireRoom(); err != nil {
		return err
	}
	var p RecordControlPayload
	if err := decodePayload(env, &p); err != nil {
		return fmt.Errorf("decode record-control: %w", err)
	}

	// Resolve the target stream + kind, validating ownership.
	var (
		kind     string
		streamID string
	)
	c.mu.RLock()
	switch {
	case p.Kind != "":
		if sid, ok := c.streams[p.Kind]; ok {
			kind = p.Kind
			streamID = sid
		}
	case p.StreamID != "":
		// Match by streamId — must belong to this client.
		for k, sid := range c.streams {
			if sid == p.StreamID {
				kind = k
				streamID = sid
				break
			}
		}
	}
	c.mu.RUnlock()

	switch {
	case p.Kind == "" && p.StreamID == "":
		return errors.New("kind or streamId is required")
	case streamID == "" && p.Kind != "":
		return fmt.Errorf("you do not publish kind %q", p.Kind)
	case streamID == "":
		return errors.New("stream not owned by this client")
	}

	// Issue the ZLM REST call (room.ID == ZLM app).
	if start {
		if err := c.hub.zlm.StartRecord(c.room.ID, streamID, zlmRecordType()); err != nil {
			return fmt.Errorf("zlm record: %w", err)
		}
	} else {
		if err := c.hub.zlm.StopRecord(c.room.ID, streamID, zlmRecordType()); err != nil {
			return fmt.Errorf("zlm record: %w", err)
		}
	}

	// Persist state on the client.
	c.mu.Lock()
	c.recordings[kind] = start
	c.mu.Unlock()

	state := RecordStatePayload{
		UserID:    c.UserID,
		Kind:      kind,
		StreamID:  streamID,
		Recording: start,
	}

	// When stopping, resolve the recorded file URL from ZLM (with retries).
	if !start {
		if url, err := c.hub.zlm.ResolveLatestRecordURL(c.room.ID, streamID); err != nil {
			log.Warn().Err(err).Str("room", c.room.ID).Str("stream", streamID).Msg("record resolve url")
		} else {
			state.RecordFileURL = url
		}
	}

	// Ack to the controlling client (with reqId).
	c.send(TypeRecordState, env.ReqID, state)
	// Broadcast to other peers in the room (no-op for solo rooms).
	c.room.broadcastRecordState(c, kind, streamID, start)
	return nil
}
