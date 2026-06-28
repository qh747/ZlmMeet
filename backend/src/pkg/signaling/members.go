package signaling

// MemberSnapshot builds the admin member list from hub state and ZLM media list.
func (h *Hub) MemberSnapshot() (members []MemberRow, zlmError string) {
	online := make(map[string]struct{})
	media, err := h.zlm.GetMediaList()
	if err != nil {
		zlmError = err.Error()
	} else {
		for _, m := range media {
			online[m.App+"/"+m.Stream] = struct{}{}
		}
	}

	h.mu.RLock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.RUnlock()

	for _, r := range rooms {
		if !memberRoomVisible(r) {
			continue
		}
		appendRoomMemberRows(&members, r, online)
	}
	return members, zlmError
}

func streamOnline(online map[string]struct{}, roomID, streamID string) bool {
	if streamID == "" {
		return false
	}
	_, ok := online[roomID+"/"+streamID]
	return ok
}

func memberRoomVisible(r *Room) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	realCount := 0
	hasPush := false
	hasPlay := false
	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}
		realCount++
		if r.Mode == RoomModeSolo {
			c.mu.RLock()
			switch c.soloRole {
			case SoloRolePush:
				hasPush = true
			case SoloRolePlay:
				hasPlay = true
			}
			c.mu.RUnlock()
		}
	}
	if realCount == 0 {
		return false
	}
	if r.Mode == RoomModeSolo {
		return hasPush || hasPlay
	}
	return true
}

func appendRoomMemberRows(out *[]MemberRow, r *Room, online map[string]struct{}) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, c := range r.clients {
		if c.IsObserver() {
			continue
		}

		c.mu.RLock()
		nickname := c.Nickname
		userID := c.UserID
		clientPlatform := c.clientPlatform
		soloRole := c.soloRole
		plannedStream := c.plannedStreamID
		streams := make([]StreamInfo, 0, len(c.streams))
		for kind, sid := range c.streams {
			streams = append(streams, StreamInfo{Kind: kind, StreamID: sid})
		}
		pulls := make([]PullBrief, 0, len(c.pulling))
		for _, p := range c.pulling {
			pulls = append(pulls, PullBrief{
				Kind:         p.kind,
				StreamID:     p.streamID,
				TargetUserID: p.targetUserID,
			})
		}
		recordings := make(map[string]bool, len(c.recordings))
		for kind, on := range c.recordings {
			recordings[kind] = on
		}
		c.mu.RUnlock()

		isRecording := func(kind string) bool {
			return recordings[kind]
		}

		switch r.Mode {
		case RoomModeMeeting, RoomModeCall:
			if len(streams) == 0 {
				continue
			}
			for _, s := range streams {
				*out = append(*out, MemberRow{
					Biz:          r.Mode,
					RoomID:       r.ID,
					RoomDisplay:  r.ID,
					UserID:       userID,
					Nickname:     nickname,
					StreamKind:   s.Kind,
					StreamID:     s.StreamID,
					StreamLabel:  publishKindLabel(s.Kind),
					StreamOnline: streamOnline(online, r.ID, s.StreamID),
					Recording:      isRecording(s.Kind),
					ClientPlatform: clientPlatform,
				})
			}
		case RoomModeSolo:
			if soloRole == SoloRolePush {
				streamID := soloPublishStreamID(streams, plannedStream)
				*out = append(*out, MemberRow{
					Biz:          "push",
					RoomID:       r.ID,
					RoomDisplay:  pushRoomDisplay(r.ID, streamID),
					UserID:       userID,
					Nickname:     nickname,
					StreamKind:   "solo",
					StreamID:     streamID,
					StreamLabel:  "推流",
					StreamOnline: streamOnline(online, r.ID, streamID),
					Recording:      isRecording("solo"),
					ClientPlatform: clientPlatform,
				})
				continue
			}
			if soloRole != SoloRolePlay {
				continue
			}
			if len(pulls) == 0 {
				*out = append(*out, MemberRow{
					Biz:         "pull",
					RoomID:      r.ID,
					RoomDisplay: r.ID,
					UserID:      userID,
					Nickname:       nickname,
					StreamLabel:    "尚未拉流",
					ClientPlatform: clientPlatform,
				})
				continue
			}
			for _, p := range pulls {
				*out = append(*out, MemberRow{
					Biz:          "pull",
					RoomID:       r.ID,
					RoomDisplay:  r.ID,
					UserID:       userID,
					Nickname:     nickname,
					StreamKind:   p.Kind,
					StreamID:     p.StreamID,
					StreamLabel:  pullStreamLabel(p),
					StreamOnline:   streamOnline(online, r.ID, p.StreamID),
					ClientPlatform: clientPlatform,
				})
			}
		}
	}
}

func soloPublishStreamID(streams []StreamInfo, planned string) string {
	for _, s := range streams {
		if s.Kind == "solo" && s.StreamID != "" {
			return s.StreamID
		}
	}
	return planned
}

func pushRoomDisplay(roomID, streamID string) string {
	if streamID == "" {
		return roomID
	}
	return roomID + "/" + streamID
}

func publishKindLabel(kind string) string {
	switch kind {
	case "cam":
		return "摄像头"
	case "screen":
		return "屏幕共享"
	case "solo":
		return "推流"
	default:
		return kind
	}
}

func pullStreamLabel(p PullBrief) string {
	if p.Kind == "solo" {
		if p.StreamID == "" {
			return "拉流"
		}
		return "拉流 · " + p.StreamID
	}
	if p.StreamID != "" {
		return publishKindLabel(p.Kind) + " · " + p.StreamID
	}
	return publishKindLabel(p.Kind)
}
