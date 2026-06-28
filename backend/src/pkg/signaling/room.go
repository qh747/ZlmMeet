package signaling

import (
	"errors"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// Room maintains the membership and broadcast logic for a single meeting room.
type Room struct {
	ID   string
	Mode string // RoomModeMeeting | RoomModeCall | RoomModeSolo
	hub  *Hub

	mu      sync.RWMutex
	clients map[string]*Client // keyed by userId
}

func newRoom(id, mode string, hub *Hub) *Room {
	return &Room{
		ID:      id,
		Mode:    mode,
		hub:     hub,
		clients: make(map[string]*Client),
	}
}

// capacity returns the max number of clients allowed in this room.
// 0 means unlimited. Solo rooms now allow multiple clients (publishers and
// players sharing the same ZLM app) so a publisher and one or more players
// can co-exist without spinning up extra rooms.
func (r *Room) capacity() int {
	if r.Mode == RoomModeCall {
		return 2
	}
	return 0
}

// isBroadcast reports whether peer-* events should be relayed within this room.
// Chat is always broadcast to all room members, including solo (push/play) rooms.
func (r *Room) isBroadcast() bool {
	return r.Mode != RoomModeSolo
}

func (r *Room) size() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}

// hasNickname reports whether a connected client already uses the nickname.
func (r *Room) hasNickname(nickname string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clients {
		if c.Nickname == nickname {
			return true
		}
	}
	return false
}

// hasStreamID reports whether any client in the room is publishing streamID.
func (r *Room) hasStreamID(streamID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clients {
		c.mu.RLock()
		for _, sid := range c.streams {
			if sid == streamID {
				c.mu.RUnlock()
				return true
			}
		}
		c.mu.RUnlock()
	}
	return false
}

// ClientNickname returns the nickname of a connected client, or userID if unknown.
func (r *Room) ClientNickname(userID string) string {
	r.mu.RLock()
	c, ok := r.clients[userID]
	r.mu.RUnlock()
	if !ok || c.Nickname == "" {
		return userID
	}
	return c.Nickname
}

// StreamOwnerNickname returns the nickname of whoever publishes streamID.
func (r *Room) StreamOwnerNickname(streamID string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}
		c.mu.RLock()
		for _, sid := range c.streams {
			if sid == streamID {
				nick := c.Nickname
				c.mu.RUnlock()
				if nick == "" {
					return c.UserID
				}
				return nick
			}
		}
		c.mu.RUnlock()
	}
	return ""
}

// hasPushMember reports whether a solo push publisher is already in the room.
func (r *Room) hasPushMember() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.hasPushMemberLocked()
}

func (r *Room) hasPushMemberLocked() bool {
	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}
		c.mu.RLock()
		role := c.soloRole
		c.mu.RUnlock()
		if role == SoloRolePush {
			return true
		}
	}
	return false
}

// snapshotPeers returns the metadata other peers should see when joining.
// Excludes the caller (passed in as `excludeID`).
func (r *Room) snapshotPeers(excludeID string) []PeerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PeerInfo, 0, len(r.clients))
	for id, c := range r.clients {
		if id == excludeID || c.IsObserver() {
			continue
		}
		c.mu.RLock()
		info := PeerInfo{
			UserID:         c.UserID,
			Nickname:       c.Nickname,
			MicOn:          c.micOn,
			CamOn:          c.camOn,
			ClientPlatform: c.clientPlatform,
			Streams:        make([]StreamInfo, 0, len(c.streams)),
		}
		for kind, sid := range c.streams {
			info.Streams = append(info.Streams, StreamInfo{Kind: kind, StreamID: sid})
		}
		c.mu.RUnlock()
		out = append(out, info)
	}
	return out
}

// realMemberCountLocked counts connected clients excluding admin observers.
func (r *Room) realMemberCountLocked() int {
	n := 0
	for _, c := range r.clients {
		if !c.IsObserver() {
			n++
		}
	}
	return n
}

// addClient registers a client and notifies others. Returns an error if the
// room is full or if the requested mode conflicts with the existing room mode.
func (r *Room) addClient(c *Client, requestedMode string) error {
	r.mu.Lock()
	if requestedMode != "" && requestedMode != r.Mode {
		r.mu.Unlock()
		return errors.New("room mode mismatch (already " + r.Mode + ")")
	}
	if cap := r.capacity(); cap > 0 && r.realMemberCountLocked() >= cap {
		r.mu.Unlock()
		return errors.New("room is full")
	}
	if r.Mode == RoomModeSolo && c.soloRole == SoloRolePush && r.hasPushMemberLocked() {
		r.mu.Unlock()
		return errors.New(ErrRoomInUse)
	}
	for _, existing := range r.clients {
		if existing.IsObserver() {
			continue
		}
		if existing.Nickname == c.Nickname {
			r.mu.Unlock()
			if r.Mode == RoomModeSolo {
				return errors.New(ErrMemberNameInUse)
			}
			return errors.New(ErrUserInUse)
		}
	}
	r.clients[c.UserID] = c
	r.mu.Unlock()

	log.Info().Str("room", r.ID).Str("mode", r.Mode).Str("user_id", c.UserID).Str("nickname", c.Nickname).Msg("join")

	// Tell the joiner who is already here.
	peers := r.snapshotPeers(c.UserID)
	c.send(TypeJoined, "", JoinedPayload{
		UserID: c.UserID,
		Room:   r.ID,
		Peers:  peers,
	})

	// Solo rooms are private; skip peer broadcast entirely.
	if !r.isBroadcast() {
		r.hub.notifyStatsChanged()
		return nil
	}

	// Tell others a new peer joined.
	c.mu.RLock()
	joinedPayload := PeerJoinedPayload{
		UserID:         c.UserID,
		Nickname:       c.Nickname,
		MicOn:          c.micOn,
		CamOn:          c.camOn,
		ClientPlatform: c.clientPlatform,
	}
	c.mu.RUnlock()
	r.broadcastExcept(c.UserID, TypePeerJoined, joinedPayload)
	r.hub.notifyStatsChanged()
	return nil
}

// addObserverClient registers a silent admin observer. Observers do not
// broadcast peer-joined, do not count toward room capacity, and are omitted
// from peer snapshots visible to business clients.
func (r *Room) addObserverClient(c *Client) error {
	if !c.IsObserver() {
		return errors.New("not an observer client")
	}
	r.mu.Lock()
	r.clients[c.UserID] = c
	r.mu.Unlock()

	c.room = r

	log.Info().Str("room", r.ID).Str("mode", r.Mode).Str("user_id", c.UserID).Msg("observe-join")

	peers := r.snapshotPeers(c.UserID)
	c.send(TypeObserveJoined, "", JoinedPayload{
		UserID: c.UserID,
		Room:   r.ID,
		Peers:  peers,
	})
	r.hub.notifyStatsChanged()
	return nil
}

// removeClient unregisters and notifies. Also stops any active recordings and
// closes all streams the client was publishing on ZLM, since RTC peer
// connections may not tear down immediately.
func (r *Room) removeClient(c *Client) {
	r.mu.Lock()
	if _, ok := r.clients[c.UserID]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.clients, c.UserID)
	r.mu.Unlock()

	log.Info().Str("room", r.ID).Str("user_id", c.UserID).Msg("leave")

	if c.IsObserver() {
		r.hub.removeRoomIfEmpty(r)
		r.hub.notifyStatsChanged()
		return
	}

	// Collect streams + active recordings under client lock. We also keep the
	// kind→sid mapping so we can broadcast peer-stream-stopped before the
	// peer-left event, giving remaining clients an immediate signal to tear
	// down their RTCPeerConnection (avoiding the multi-second ICE timeout).
	c.mu.Lock()
	type streamEntry struct{ Kind, StreamID string }
	entries := make([]streamEntry, 0, len(c.streams))
	sids := make([]string, 0, len(c.streams))
	recordSids := make([]string, 0, len(c.recordings))
	for kind, sid := range c.streams {
		entries = append(entries, streamEntry{Kind: kind, StreamID: sid})
		sids = append(sids, sid)
		if c.recordings[kind] {
			recordSids = append(recordSids, sid)
		}
	}
	c.streams = make(map[string]string)
	c.recordings = make(map[string]bool)
	c.mu.Unlock()

	// Broadcast peer-stream-stopped for every stream BEFORE peer-left, so
	// watching clients clean up immediately instead of waiting for ICE timeout.
	for _, e := range entries {
		r.broadcastStreamStopped(c, e.Kind, e.StreamID)
	}
	if r.isBroadcast() {
		r.broadcastExcept(c.UserID, TypePeerLeft, PeerLeftPayload{UserID: c.UserID})
	}

	// Stop recording then close streams on ZLM, off the hot path.
	app := r.ID
	go func(recordSids, sids []string) {
		for _, sid := range recordSids {
			if err := r.hub.zlm.StopRecord(app, sid, zlmRecordType()); err != nil {
				log.Warn().Err(err).Str("room", r.ID).Str("stream", sid).Msg("stop record")
			}
		}
		for _, sid := range sids {
			if err := r.hub.zlm.CloseStream(app, sid); err != nil {
				log.Warn().Err(err).Str("room", r.ID).Str("stream", sid).Msg("close stream")
			}
		}
	}(recordSids, sids)

	if !r.isBusinessActive() {
		r.dismissObservers("业务已结束")
	}

	r.hub.removeRoomIfEmpty(r)
	r.hub.notifyStatsChanged()
}

// isBusinessActive reports whether real business clients remain (mirrors admin UI).
func (r *Room) isBusinessActive() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	realCount := 0
	hasPush := false
	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}
		realCount++
		if r.Mode == RoomModeSolo && c.soloRole != SoloRolePlay {
			hasPush = true
		}
	}
	if realCount == 0 {
		return false
	}
	if r.Mode == RoomModeSolo {
		return hasPush
	}
	return true
}

// dismissObservers notifies admin watchers and removes them from the room.
func (r *Room) dismissObservers(message string) {
	r.mu.RLock()
	observers := make([]*Client, 0)
	for _, c := range r.clients {
		if c.IsObserver() {
			observers = append(observers, c)
		}
	}
	r.mu.RUnlock()

	payload := ObserveEndedPayload{Message: message}
	for _, c := range observers {
		c.send(TypeObserveEnded, "", payload)
		c.LeaveRoom()
	}
}

// broadcastExcept sends a message to every non-observer client except exceptID.
func (r *Room) broadcastExcept(exceptID, msgType string, payload any) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, c := range r.clients {
		if id == exceptID || c.IsObserver() {
			continue
		}
		c.send(msgType, "", payload)
	}
}

// broadcastToAllExcept sends to every client (including observers) except exceptID.
func (r *Room) broadcastToAllExcept(exceptID, msgType string, payload any) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, c := range r.clients {
		if id == exceptID {
			continue
		}
		c.send(msgType, "", payload)
	}
}

// === Specific broadcasts ======================================================

func (r *Room) broadcastChat(from *Client, text string) {
	payload := ChatPayload{
		From:     from.UserID,
		Nickname: from.Nickname,
		Text:     text,
		TS:       time.Now().UnixMilli(),
	}
	// chat is broadcast to everyone, including the sender, so all peers see
	// a uniform log.
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}
		c.send(TypeChat, "", payload)
	}
}

func (r *Room) broadcastMediaState(c *Client) {
	if !r.isBroadcast() {
		return
	}
	c.mu.RLock()
	payload := PeerStatePayload{
		UserID: c.UserID,
		MicOn:  c.micOn,
		CamOn:  c.camOn,
	}
	c.mu.RUnlock()
	r.broadcastExcept(c.UserID, TypePeerState, payload)
}

func (r *Room) broadcastStreamStarted(c *Client, kind, streamID string) {
	r.broadcastToAllExcept(c.UserID, TypePeerStreamStarted, PeerStreamPayload{
		UserID:   c.UserID,
		Kind:     kind,
		StreamID: streamID,
	})
}

func (r *Room) broadcastStreamStopped(c *Client, kind, streamID string) {
	r.broadcastToAllExcept(c.UserID, TypePeerStreamStopped, PeerStreamPayload{
		UserID:   c.UserID,
		Kind:     kind,
		StreamID: streamID,
	})
}

// targetStreamID looks up the published stream id for (userId, kind) so other
// peers can ask for a play. Returns "" if not found.
func (r *Room) targetStreamID(userID, kind string) string {
	r.mu.RLock()
	c, ok := r.clients[userID]
	r.mu.RUnlock()
	if !ok {
		return ""
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.streams[kind]
}

// broadcastRecordState broadcasts a record-state change to the room (no-op for
// solo rooms — caller already sends an ack to the controlling client).
func (r *Room) broadcastRecordState(c *Client, kind, streamID string, recording bool) {
	if !r.isBroadcast() {
		return
	}
	r.broadcastExcept(c.UserID, TypeRecordState, RecordStatePayload{
		UserID:    c.UserID,
		Kind:      kind,
		StreamID:  streamID,
		Recording: recording,
	})
}
