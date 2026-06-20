package signaling

import (
	"log"
	"sync"

	"zlm_meet/backend/pkg/zlm"
)

// Hub keeps the global table of rooms.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
	zlm   *zlm.Client
}

func NewHub(z *zlm.Client) *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
		zlm:   z,
	}
}

// GetOrCreateRoom returns an existing room or creates a new one with the
// requested mode. If the room already exists with a different mode, the
// existing room is returned unchanged — the caller is responsible for
// rejecting the mismatch.
func (h *Hub) GetOrCreateRoom(id, mode string) *Room {
	if mode == "" {
		mode = RoomModeMeeting
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[id]; ok {
		return r
	}
	r := newRoom(id, mode, h)
	h.rooms[id] = r
	return r
}

// removeRoomIfEmpty drops a room from the table if it has no clients left.
func (h *Hub) removeRoomIfEmpty(r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.size() == 0 {
		delete(h.rooms, r.ID)
		log.Printf("[hub] room %s removed (empty)", r.ID)
	}
}
