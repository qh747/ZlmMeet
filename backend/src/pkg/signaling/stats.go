package signaling

import "time"

// ClientBrief is a lightweight view of a connected client for admin dashboards.
type ClientBrief struct {
	UserID    string       `json:"userId"`
	Nickname  string       `json:"nickname"`
	MicOn     bool         `json:"micOn"`
	CamOn     bool         `json:"camOn"`
	Streams   []StreamInfo `json:"streams"`
	Recording bool         `json:"recording"`
}

// RoomStats summarizes one active room.
type RoomStats struct {
	ID      string        `json:"id"`
	Mode    string        `json:"mode"`
	Members int           `json:"members"`
	Clients []ClientBrief `json:"clients"`
}

// HubStats is a point-in-time snapshot of signaling state.
type HubStats struct {
	TotalRooms    int            `json:"totalRooms"`
	TotalClients  int            `json:"totalClients"`
	RoomsByMode   map[string]int `json:"roomsByMode"`
	ClientsByMode map[string]int `json:"clientsByMode"`
	Rooms         []RoomStats    `json:"rooms"`
	ServerTime    int64          `json:"serverTime"`
}

// StatsSnapshot returns current hub statistics for the admin dashboard.
func (h *Hub) StatsSnapshot() HubStats {
	h.mu.RLock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.RUnlock()

	out := HubStats{
		RoomsByMode:   make(map[string]int),
		ClientsByMode: make(map[string]int),
		ServerTime:    time.Now().UnixMilli(),
	}

	for _, r := range rooms {
		out.TotalRooms++
		out.RoomsByMode[r.Mode]++

		rs := RoomStats{
			ID:   r.ID,
			Mode: r.Mode,
		}

		r.mu.RLock()
		rs.Members = len(r.clients)
		out.TotalClients += rs.Members
		out.ClientsByMode[r.Mode] += rs.Members

		for _, c := range r.clients {
			c.mu.RLock()
			recording := false
			for _, on := range c.recordings {
				if on {
					recording = true
					break
				}
			}
			brief := ClientBrief{
				UserID:    c.UserID,
				Nickname:  c.Nickname,
				MicOn:     c.micOn,
				CamOn:     c.camOn,
				Recording: recording,
				Streams:   make([]StreamInfo, 0, len(c.streams)),
			}
			for kind, sid := range c.streams {
				brief.Streams = append(brief.Streams, StreamInfo{Kind: kind, StreamID: sid})
			}
			c.mu.RUnlock()
			rs.Clients = append(rs.Clients, brief)
		}
		r.mu.RUnlock()

		out.Rooms = append(out.Rooms, rs)
	}

	return out
}
