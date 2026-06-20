package signaling

import (
	"errors"
	"log"
	"sync"
	"time"
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
// 0 means unlimited.
func (r *Room) capacity() int {
	switch r.Mode {
	case RoomModeCall:
		return 2
	case RoomModeSolo:
		return 1
	default:
		return 0
	}
}

// isBroadcast reports whether peer-* / chat events should be relayed within
// this room. Solo rooms are private contexts and skip all broadcasts.
func (r *Room) isBroadcast() bool {
	return r.Mode != RoomModeSolo
}

func (r *Room) size() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}

// snapshotPeers returns the metadata other peers should see when joining.
// Excludes the caller (passed in as `excludeID`).
func (r *Room) snapshotPeers(excludeID string) []PeerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PeerInfo, 0, len(r.clients))
	for id, c := range r.clients {
		if id == excludeID {
			continue
		}
		c.mu.RLock()
		info := PeerInfo{
			UserID:   c.UserID,
			Nickname: c.Nickname,
			MicOn:    c.micOn,
			CamOn:    c.camOn,
			Streams:  make([]StreamInfo, 0, len(c.streams)),
		}
		for kind, sid := range c.streams {
			info.Streams = append(info.Streams, StreamInfo{Kind: kind, StreamID: sid})
		}
		c.mu.RUnlock()
		out = append(out, info)
	}
	return out
}

// addClient registers a client and notifies others. Returns an error if the
// room is full or if the requested mode conflicts with the existing room mode.
func (r *Room) addClient(c *Client, requestedMode string) error {
	r.mu.Lock()
	if requestedMode != "" && requestedMode != r.Mode {
		r.mu.Unlock()
		return errors.New("room mode mismatch (already " + r.Mode + ")")
	}
	if cap := r.capacity(); cap > 0 && len(r.clients) >= cap {
		r.mu.Unlock()
		return errors.New("room is full")
	}
	r.clients[c.UserID] = c
	r.mu.Unlock()

	log.Printf("[room %s mode=%s] join: %s (%s)", r.ID, r.Mode, c.UserID, c.Nickname)

	// Tell the joiner who is already here.
	peers := r.snapshotPeers(c.UserID)
	c.send(TypeJoined, "", JoinedPayload{
		UserID: c.UserID,
		Room:   r.ID,
		Peers:  peers,
	})

	// Solo rooms are private; skip peer broadcast entirely.
	if !r.isBroadcast() {
		return nil
	}

	// Tell others a new peer joined.
	r.broadcastExcept(c.UserID, TypePeerJoined, PeerJoinedPayload{
		UserID:   c.UserID,
		Nickname: c.Nickname,
	})
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

	log.Printf("[room %s] leave: %s", r.ID, c.UserID)

	// Collect streams + active recordings under client lock.
	c.mu.Lock()
	streams := make([]string, 0, len(c.streams))
	recording := make([]string, 0, len(c.recordings))
	for kind, sid := range c.streams {
		streams = append(streams, sid)
		if c.recordings[kind] {
			recording = append(recording, sid)
		}
	}
	c.streams = make(map[string]string)
	c.recordings = make(map[string]bool)
	c.mu.Unlock()

	// Stop recording then close streams on ZLM, off the hot path.
	go func(recordSids, sids []string) {
		for _, sid := range recordSids {
			if err := r.hub.zlm.StopRecord(sid, zlmRecordType()); err != nil {
				log.Printf("[room %s] stop record %s: %v", r.ID, sid, err)
			}
		}
		for _, sid := range sids {
			if err := r.hub.zlm.CloseStream(sid); err != nil {
				log.Printf("[room %s] close stream %s: %v", r.ID, sid, err)
			}
		}
	}(recording, streams)

	if r.isBroadcast() {
		r.broadcastExcept(c.UserID, TypePeerLeft, PeerLeftPayload{UserID: c.UserID})
	}

	r.hub.removeRoomIfEmpty(r)
}

// broadcastExcept sends a message to every client except the one with the given ID.
func (r *Room) broadcastExcept(exceptID, msgType string, payload any) {
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
	if !r.isBroadcast() {
		return
	}
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
	if !r.isBroadcast() {
		return
	}
	r.broadcastExcept(c.UserID, TypePeerStreamStarted, PeerStreamPayload{
		UserID:   c.UserID,
		Kind:     kind,
		StreamID: streamID,
	})
}

func (r *Room) broadcastStreamStopped(c *Client, kind, streamID string) {
	if !r.isBroadcast() {
		return
	}
	r.broadcastExcept(c.UserID, TypePeerStreamStopped, PeerStreamPayload{
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
