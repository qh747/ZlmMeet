package signaling

import "errors"

// NewTestClient builds a client for tests under backend/test.
func NewTestClient(userID, nickname string, streams map[string]string) *Client {
	if streams == nil {
		streams = make(map[string]string)
	}
	return &Client{
		UserID:     userID,
		Nickname:   nickname,
		streams:    streams,
		pulling:    make(map[string]pullEntry),
		recordings: make(map[string]bool),
	}
}

// AddTestSoloClient registers a synthetic solo-room client (for external tests).
func (h *Hub) AddTestSoloClient(roomID, soloRole string, c *Client) error {
	c.soloRole = soloRole
	return h.AddTestClient(roomID, RoomModeSolo, c)
}

// AddTestClient registers a synthetic client in the hub (for external tests).
func (h *Hub) AddTestClient(roomID, mode string, c *Client) error {
	r := h.GetOrCreateRoom(roomID, mode)
	c.hub = h
	if err := r.addClient(c, mode); err != nil {
		return err
	}
	c.room = r
	return nil
}

// AddTestObserverClient registers a synthetic observer in an existing room.
func (h *Hub) AddTestObserverClient(roomID string, c *Client) error {
	r, ok := h.GetRoom(roomID)
	if !ok {
		return errors.New("room not found")
	}
	c.hub = h
	c.room = r
	return r.addObserverClient(c)
}
