package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/hoststats"
	"zlm_meet/backend/pkg/signaling"
)

const (
	adminWSWriteWait     = 10 * time.Second
	adminWSPongWait      = 60 * time.Second
	adminWSPingPeriod    = 30 * time.Second
	adminStatsDebounce   = 200 * time.Millisecond
	adminWSOutboundQueue = 8
)

type adminDashboardHub struct {
	hub      *signaling.Hub
	auth     *adminauth.Auth
	observe  *observeSessionManager
	audit    *AuditLog
	mu       sync.Mutex
	clients  map[*adminWSClient]struct{}
	debounce *time.Timer
}

type adminWSClient struct {
	parent *adminDashboardHub
	conn   *websocket.Conn
	send   chan []byte
	token  string
}

func newAdminDashboardHub(hub *signaling.Hub, auth *adminauth.Auth, observe *observeSessionManager, audit *AuditLog) *adminDashboardHub {
	d := &adminDashboardHub{
		hub:     hub,
		auth:    auth,
		observe: observe,
		audit:   audit,
		clients: make(map[*adminWSClient]struct{}),
	}
	auth.SetKickHandler(d.kickByToken)
	hub.SetStatsChangeHook(d.scheduleHubPush)
	if audit != nil {
		audit.SetChangeHook(d.broadcastAudit)
	}
	return d
}

func buildDashboardPayload(hub *signaling.Hub, audit *AuditLog, includeMedia bool) map[string]any {
	hubStats := hub.StatsSnapshot()
	hs := hoststats.Sample()
	payload := map[string]any{
		"type": "dashboard",
		"hub":  hubStats,
		"signaling": map[string]any{
			"status":                 "running",
			"cpuUsagePercent":        hs.CPUUsagePercent,
			"memUsedBytes":           hs.MemUsedBytes,
			"memTotalBytes":          hs.MemTotalBytes,
			"memUsagePercent":        hs.MemUsagePercent,
			"processCpuUsagePercent": hs.ProcessCPUUsagePercent,
			"processRssBytes":        hs.ProcessRSSBytes,
			"goHeapBytes":            hs.GoHeapBytes,
			"goroutineCount":         hs.GoroutineCount,
			"openFdCount":            hs.OpenFDCount,
			"uptimeSeconds":          hs.UptimeSeconds,
			"supported":              hs.Supported,
		},
	}
	if audit != nil {
		payload["audit"] = audit.Recent(50)
	}
	if includeMedia {
		payload["media"] = hub.ZLM().MonitorSnapshot()
	}
	return payload
}

func (d *adminDashboardHub) scheduleHubPush() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.debounce != nil {
		return
	}
	d.debounce = time.AfterFunc(adminStatsDebounce, func() {
		d.mu.Lock()
		d.debounce = nil
		d.mu.Unlock()
		d.broadcastHub()
	})
}

func (d *adminDashboardHub) broadcastHub() {
	raw, err := json.Marshal(buildDashboardPayload(d.hub, d.audit, false))
	if err != nil {
		log.Warn().Err(err).Msg("admin dashboard marshal")
		return
	}
	d.broadcast(raw)
}

func (d *adminDashboardHub) broadcastAudit() {
	if d.audit == nil {
		return
	}
	raw, err := json.Marshal(map[string]any{
		"type":    "audit",
		"entries": d.audit.Recent(50),
	})
	if err != nil {
		log.Warn().Err(err).Msg("admin audit marshal")
		return
	}
	d.broadcast(raw)
}

func (d *adminDashboardHub) broadcast(raw []byte) {
	d.mu.Lock()
	clients := make([]*adminWSClient, 0, len(d.clients))
	for c := range d.clients {
		clients = append(clients, c)
	}
	d.mu.Unlock()

	for _, c := range clients {
		select {
		case c.send <- raw:
		default:
		}
	}
}

func (d *adminDashboardHub) kickByToken(token string) {
	if d.observe != nil {
		d.observe.leaveAllByToken(token, "账号已在其它地方登录")
	}
	d.mu.Lock()
	var victims []*adminWSClient
	for c := range d.clients {
		if c.token == token {
			victims = append(victims, c)
		}
	}
	d.mu.Unlock()

	for _, c := range victims {
		c.kick("账号已在其它地方登录")
	}
}

func (d *adminDashboardHub) handleWS(w http.ResponseWriter, r *http.Request, checkOrigin func(*http.Request) bool) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get(adminTokenHeader))
	}
	if _, err := d.auth.ValidateToken(token); err != nil {
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
		log.Warn().Err(err).Msg("admin ws upgrade")
		return
	}

	client := &adminWSClient{
		parent: d,
		conn:   conn,
		send:   make(chan []byte, adminWSOutboundQueue),
		token:  token,
	}
	d.register(client)
	go client.writeLoop()
	client.readLoop()
}

func (d *adminDashboardHub) register(c *adminWSClient) {
	d.mu.Lock()
	d.clients[c] = struct{}{}
	d.mu.Unlock()
}

func (d *adminDashboardHub) unregister(c *adminWSClient) {
	d.mu.Lock()
	delete(d.clients, c)
	d.mu.Unlock()
}

func (c *adminWSClient) readLoop() {
	defer c.close()

	c.conn.SetReadLimit(1 << 16)
	_ = c.conn.SetReadDeadline(time.Now().Add(adminWSPongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(adminWSPongWait))
	})

	c.pushSnapshot(true)

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Debug().Err(err).Msg("admin ws read")
			}
			return
		}

		var msg struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg.Type == "refresh" {
			c.pushSnapshot(true)
		}
	}
}

func (c *adminWSClient) writeLoop() {
	ticker := time.NewTicker(adminWSPingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(adminWSWriteWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(adminWSWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *adminWSClient) pushSnapshot(includeMedia bool) {
	raw, err := json.Marshal(buildDashboardPayload(c.parent.hub, c.parent.audit, includeMedia))
	if err != nil {
		log.Warn().Err(err).Msg("admin dashboard marshal")
		return
	}
	select {
	case c.send <- raw:
	default:
	}
}

func (c *adminWSClient) kick(message string) {
	raw, err := json.Marshal(map[string]any{
		"type":    "kick",
		"message": message,
	})
	if err == nil {
		_ = c.conn.SetWriteDeadline(time.Now().Add(adminWSWriteWait))
		_ = c.conn.WriteMessage(websocket.TextMessage, raw)
	}
	_ = c.conn.Close()
}

func (c *adminWSClient) close() {
	c.parent.unregister(c)
	close(c.send)
	_ = c.conn.Close()
}
