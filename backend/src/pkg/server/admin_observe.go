package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/signaling"
)

type observeConn struct {
	mgr       *observeSessionManager
	conn      *websocket.Conn
	send      chan []byte
	token     string
	username  string
	client    *signaling.Client
	roomID    string
	closeOnce sync.Once
}

type observeSessionManager struct {
	hub   *signaling.Hub
	auth  *adminauth.Auth
	audit *AuditLog
	mu    sync.Mutex
	conns map[*observeConn]struct{}
}

func newObserveSessionManager(hub *signaling.Hub, auth *adminauth.Auth, audit *AuditLog) *observeSessionManager {
	return &observeSessionManager{
		hub:   hub,
		auth:  auth,
		audit: audit,
		conns: make(map[*observeConn]struct{}),
	}
}

func (m *observeSessionManager) handleWS(w http.ResponseWriter, r *http.Request, checkOrigin func(*http.Request) bool) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get(adminTokenHeader))
	}
	username, err := m.auth.ValidateToken(token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	upgrader := &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     checkOrigin,
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Warn().Err(err).Msg("observe ws upgrade")
		return
	}

	oc := &observeConn{
		mgr:      m,
		conn:     conn,
		send:     make(chan []byte, 16),
		token:    token,
		username: username,
	}
	m.register(oc)
	go oc.writeLoop()
	oc.readLoop()
}

func (m *observeSessionManager) register(oc *observeConn) {
	m.mu.Lock()
	m.conns[oc] = struct{}{}
	m.mu.Unlock()
}

func (m *observeSessionManager) unregister(oc *observeConn) {
	m.mu.Lock()
	delete(m.conns, oc)
	m.mu.Unlock()
}

func (m *observeSessionManager) leaveAllByToken(token, reason string) {
	m.mu.Lock()
	var victims []*observeConn
	for oc := range m.conns {
		if oc.token == token {
			victims = append(victims, oc)
		}
	}
	m.mu.Unlock()

	for _, oc := range victims {
		if reason != "" {
			oc.pushRaw(map[string]any{"type": signaling.TypeObserveEnded, "message": reason})
		}
		oc.closeConn()
	}
}

func (m *observeSessionManager) roomHasRealMembers(roomID string) bool {
	for _, rs := range m.hub.StatsSnapshot().Rooms {
		if rs.ID == roomID {
			return rs.RealMembers > 0
		}
	}
	return false
}

func (m *observeSessionManager) roomHasPushMember(roomID string) bool {
	for _, rs := range m.hub.StatsSnapshot().Rooms {
		if rs.ID != roomID {
			continue
		}
		for _, c := range rs.Clients {
			if c.IsObserver || c.SoloRole == signaling.SoloRolePlay {
				continue
			}
			return true
		}
	}
	return false
}

func (oc *observeConn) readLoop() {
	defer oc.closeConn()

	oc.conn.SetReadLimit(1 << 20)
	_ = oc.conn.SetReadDeadline(time.Now().Add(adminWSPongWait))
	oc.conn.SetPongHandler(func(string) error {
		return oc.conn.SetReadDeadline(time.Now().Add(adminWSPongWait))
	})

	for {
		_, raw, err := oc.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Debug().Err(err).Msg("observe ws read")
			}
			return
		}

		var env signaling.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			oc.sendError("bad envelope")
			continue
		}

		switch env.Type {
		case signaling.TypeObserveJoin:
			if err := oc.handleObserveJoin(&env); err != nil {
				oc.sendError(err.Error())
			}
		case signaling.TypeObserveLeave:
			oc.leaveRoom()
			oc.pushRaw(map[string]any{"type": "observe-left", "ok": true})
		case signaling.TypeObserveWatchStop:
			if oc.client == nil || oc.roomID == "" {
				continue
			}
			var p signaling.ObserveWatchStopPayload
			if len(env.Payload) > 0 {
				if err := json.Unmarshal(env.Payload, &p); err != nil {
					oc.sendError("bad observe-watch-stop payload")
					continue
				}
			}
			detail := strings.TrimSpace(p.Detail)
			if detail != "" {
				oc.mgr.audit.Record(oc.username, "observe_stop", oc.roomID, detail)
			}
		case signaling.TypeWebRTCOffer:
			if oc.client == nil {
				oc.sendError("not observing a room")
				continue
			}
			if err := oc.client.Dispatch(&env); err != nil {
				oc.replyError(&env, err)
			}
		default:
			oc.sendError("unknown message type: " + env.Type)
		}
	}
}

func (oc *observeConn) handleObserveJoin(env *signaling.Envelope) error {
	if oc.client != nil {
		return errors.New("already observing a room")
	}
	var p signaling.ObserveJoinPayload
	if len(env.Payload) > 0 {
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return err
		}
	}
	p.Room = strings.TrimSpace(p.Room)
	if p.Room == "" {
		return errors.New("room is required")
	}

	room, ok := oc.mgr.hub.GetRoom(p.Room)
	if !ok {
		return errors.New("room not found")
	}
	if p.Mode != "" && p.Mode != room.Mode {
		return errors.New("room mode mismatch")
	}
	if !oc.mgr.roomHasRealMembers(room.ID) {
		return errors.New("room has no active members")
	}
	if room.Mode == signaling.RoomModeSolo && !oc.mgr.roomHasPushMember(room.ID) {
		return errors.New("room has no push stream")
	}

	client := signaling.NewObserveClient(oc.mgr.hub, oc.deliver)
	client.SetObserver(oc.token, oc.username, func(action, room, detail string) {
		oc.mgr.audit.Record(oc.username, action, room, detail)
	})
	if err := oc.mgr.hub.AddObserverClient(room.ID, client); err != nil {
		return err
	}
	oc.client = client
	oc.roomID = room.ID
	return nil
}

func (oc *observeConn) deliver(msgType, reqID string, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	oc.pushRaw(signaling.Envelope{Type: msgType, ReqID: reqID, Payload: body})
}

func (oc *observeConn) leaveRoom() {
	if oc.client == nil {
		return
	}
	oc.client.LeaveRoom()
	oc.client = nil
	oc.roomID = ""
}

func (oc *observeConn) closeConn() {
	oc.closeOnce.Do(func() {
		oc.leaveRoom()
		oc.mgr.unregister(oc)
		close(oc.send)
		_ = oc.conn.Close()
	})
}

func (oc *observeConn) writeLoop() {
	ticker := time.NewTicker(adminWSPingPeriod)
	defer func() {
		ticker.Stop()
		_ = oc.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-oc.send:
			_ = oc.conn.SetWriteDeadline(time.Now().Add(adminWSWriteWait))
			if !ok {
				_ = oc.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := oc.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = oc.conn.SetWriteDeadline(time.Now().Add(adminWSWriteWait))
			if err := oc.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (oc *observeConn) pushRaw(v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case oc.send <- raw:
	default:
	}
}

func (oc *observeConn) sendError(msg string) {
	oc.pushRaw(map[string]any{"type": signaling.TypeObserveError, "message": msg})
}

func (oc *observeConn) replyError(env *signaling.Envelope, err error) {
	if env != nil && env.ReqID != "" {
		body, _ := json.Marshal(signaling.ErrorPayload{Message: err.Error()})
		oc.pushRaw(signaling.Envelope{Type: signaling.TypeError, ReqID: env.ReqID, Payload: body})
		return
	}
	oc.sendError(err.Error())
}
