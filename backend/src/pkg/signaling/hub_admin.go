package signaling

import "errors"

// KickMember force-disconnects one business client from a room.
// On success it returns the member nickname for audit display.
func (h *Hub) KickMember(roomID, userID, reason string) (string, error) {
	r, ok := h.GetRoom(roomID)
	if !ok {
		return "", errors.New("room not found")
	}
	r.mu.RLock()
	c, ok := r.clients[userID]
	r.mu.RUnlock()
	if !ok {
		return "", errors.New("member not found")
	}
	if c.IsObserver() {
		return "", errors.New("cannot kick observer")
	}
	nickname := c.Nickname
	c.ForceKick(reason)
	return nickname, nil
}

// DissolveRoom force-disconnects all business clients in a room.
func (h *Hub) DissolveRoom(roomID, reason string) error {
	r, ok := h.GetRoom(roomID)
	if !ok {
		return errors.New("room not found")
	}
	r.mu.RLock()
	victims := make([]*Client, 0, len(r.clients))
	for _, c := range r.clients {
		if !c.IsObserver() {
			victims = append(victims, c)
		}
	}
	r.mu.RUnlock()
	if len(victims) == 0 {
		return errors.New("room has no members")
	}
	if reason == "" {
		reason = "房间已被管理员解散"
	}
	for _, c := range victims {
		c.ForceKick(reason)
	}
	return nil
}
