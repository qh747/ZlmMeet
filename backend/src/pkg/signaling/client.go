package signaling

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
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
	soloRole         string // SoloRolePush | SoloRolePlay when in a solo room
	plannedStreamID  string // intended stream name for solo push before publish
	clientPlatform   string // ios | android | desktop — for viewer mirror correction

	hub  *Hub
	room *Room

	conn   *websocket.Conn
	sendCh chan []byte
	deliver func(msgType, reqID string, payload any) // admin observe WS bridge

	mu         sync.RWMutex
	micOn      bool
	camOn      bool
	streams    map[string]string // kind -> streamId currently published
	pulling    map[string]pullEntry
	recordings map[string]bool   // kind -> recording on/off
	isObserver bool
	adminToken string
	adminUser  string
	observeAudit func(action, room, detail string)
	closed     bool
}

type pullEntry struct {
	streamID     string
	kind         string
	targetUserID string
}

func newClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		UserID:     uuid.NewString(),
		hub:        hub,
		conn:       conn,
		sendCh:     make(chan []byte, 32),
		streams:    make(map[string]string),
		pulling:    make(map[string]pullEntry),
		recordings: make(map[string]bool),
		micOn:      true,
		camOn:      true,
	}
}

// NewObserveClient builds a client backed by a custom deliver callback (admin observe WS).
func NewObserveClient(hub *Hub, deliver func(msgType, reqID string, payload any)) *Client {
	return &Client{
		UserID:     uuid.NewString(),
		hub:        hub,
		deliver:    deliver,
		streams:    make(map[string]string),
		pulling:    make(map[string]pullEntry),
		recordings: make(map[string]bool),
	}
}

// LeaveRoom removes this client from its room without closing a WebSocket.
func (c *Client) LeaveRoom() {
	if c.room != nil {
		r := c.room
		c.room = nil
		r.removeClient(c)
	}
}

// ForceKick notifies the client and closes its WebSocket, or removes it directly.
func (c *Client) ForceKick(reason string) {
	if reason == "" {
		reason = "您已被管理员移出"
	}
	c.mu.RLock()
	hasConn := c.conn != nil
	c.mu.RUnlock()
	if hasConn {
		c.send(TypeAdminKicked, "", AdminKickedPayload{Message: reason})
		_ = c.conn.Close()
		return
	}
	c.LeaveRoom()
}

func (c *Client) recordPull(streamID, kind, targetUserID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pulling == nil {
		c.pulling = make(map[string]pullEntry)
	}
	key := kind
	if kind == "solo" {
		key = "solo:" + streamID
	}
	c.pulling[key] = pullEntry{
		streamID:     streamID,
		kind:         kind,
		targetUserID: targetUserID,
	}
}

// PullSnapshot returns active pull sessions for admin dashboards.
func (c *Client) PullSnapshot() []PullBrief {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.pulling) == 0 {
		return nil
	}
	out := make([]PullBrief, 0, len(c.pulling))
	for _, p := range c.pulling {
		out = append(out, PullBrief{
			Kind:         p.kind,
			StreamID:     p.streamID,
			TargetUserID: p.targetUserID,
		})
	}
	return out
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
	if c.deliver != nil {
		c.deliver(msgType, reqID, payload)
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

// IsObserver reports whether this client joined as an admin silent observer.
func (c *Client) IsObserver() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.isObserver
}

// SetObserver marks the client as an admin observer for session tracking.
func (c *Client) SetObserver(adminToken, adminUser string, auditFn func(action, room, detail string)) {
	c.mu.Lock()
	c.isObserver = true
	c.adminToken = adminToken
	c.adminUser = adminUser
	c.observeAudit = auditFn
	suffix := c.UserID
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	c.Nickname = "observer-" + suffix
	c.mu.Unlock()
}

func (c *Client) recordObserveAudit(action, detail string) {
	c.mu.RLock()
	fn := c.observeAudit
	room := c.room
	c.mu.RUnlock()
	if fn == nil || room == nil || detail == "" {
		return
	}
	fn(action, room.ID, detail)
}

func (c *Client) observePlayDetail(p WebRTCOfferPayload) string {
	if c.room == nil {
		return ""
	}
	switch p.Mode {
	case "play":
		return c.room.ClientNickname(p.TargetUserID)
	case "play-solo":
		if nick := c.room.StreamOwnerNickname(p.StreamID); nick != "" {
			return nick
		}
		return p.StreamID
	default:
		return ""
	}
}

// AdminToken returns the admin session token when this is an observer client.
func (c *Client) AdminToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.adminToken
}

// Dispatch routes an envelope (used by admin observe WebSocket).
func (c *Client) Dispatch(env *Envelope) error {
	return c.dispatch(env)
}

func decodePayload[T any](env *Envelope, dst *T) error {
	if len(env.Payload) == 0 {
		return nil
	}
	return json.Unmarshal(env.Payload, dst)
}

// --- handlers -----------------------------------------------------------------

func normalizeClientPlatform(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "ios", "iphone", "ipad", "ipod":
		return "ios"
	case "android":
		return "android"
	default:
		return "desktop"
	}
}

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
	if mode == RoomModeSolo {
		switch p.SoloRole {
		case SoloRolePush, "":
			c.soloRole = SoloRolePush
		case SoloRolePlay:
			c.soloRole = SoloRolePlay
		default:
			return fmt.Errorf("invalid soloRole: %q", p.SoloRole)
		}
		if c.soloRole == SoloRolePush {
			streamID := strings.TrimSpace(p.StreamID)
			if streamID == "" {
				return errors.New("streamId is required")
			}
			if !isSafeStreamName(streamID) {
				return errors.New("streamId contains unsupported characters")
			}
			c.plannedStreamID = streamID
		}
	}
	c.Nickname = p.Nickname
	c.clientPlatform = normalizeClientPlatform(p.ClientPlatform)
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
	if c.IsObserver() {
		return errors.New("observers cannot send chat")
	}
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
	if c.IsObserver() {
		return errors.New("observers cannot change media state")
	}
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

	if c.IsObserver() {
		switch p.Mode {
		case "play", "play-solo":
		default:
			return errors.New("observers can only play streams")
		}
	}

	var (
		streamID string
		rtcType  zlm.WebRTCType
	)

	switch p.Mode {
	case "publish":
		if c.IsObserver() {
			return errors.New("observers cannot publish")
		}
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
		if c.IsObserver() {
			return errors.New("observers cannot publish")
		}
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
		c.hub.notifyStatsChanged()
	case "publish-solo":
		c.mu.Lock()
		c.streams["solo"] = streamID
		c.mu.Unlock()
		c.room.broadcastStreamStarted(c, "solo", streamID)
		c.hub.notifyStatsChanged()
	case "play":
		c.recordPull(streamID, p.Kind, p.TargetUserID)
		c.hub.notifyStatsChanged()
		if c.IsObserver() {
			c.recordObserveAudit("observe_start", c.observePlayDetail(p))
		}
	case "play-solo":
		c.recordPull(streamID, "solo", "")
		c.hub.notifyStatsChanged()
		if c.IsObserver() {
			c.recordObserveAudit("observe_start", c.observePlayDetail(p))
		}
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
	if c.IsObserver() {
		return errors.New("observers cannot publish streams")
	}
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
	if c.IsObserver() {
		return errors.New("observers cannot stop streams")
	}
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
		c.hub.notifyStatsChanged()
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
	if c.IsObserver() {
		return errors.New("observers cannot control recording")
	}
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
	c.hub.notifyStatsChanged()
	return nil
}
