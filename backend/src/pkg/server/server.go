package server

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"

	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/signaling"
)

// New builds an http.Handler with WebSocket signaling and static file serving.
func New(cfg *config.Config, hub *signaling.Hub) http.Handler {
	mux := http.NewServeMux()

	upgrader := &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     buildOriginChecker(cfg.AllowedOrigins),
	}

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		signaling.ServeWS(hub, upgrader, w, r)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/debug/rooms", func(w http.ResponseWriter, r *http.Request) {
		// Lightweight introspection; do not expose in production.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"note": "see logs for details"})
	})

	if cfg.StaticDir != "" {
		fs := http.FileServer(http.Dir(cfg.StaticDir))
		mux.Handle("/", fs)
		log.Printf("[server] serving static files from %s", cfg.StaticDir)
	}

	return mux
}

func buildOriginChecker(allowed []string) func(r *http.Request) bool {
	if len(allowed) == 0 {
		// No allow-list configured: permit all (dev mode).
		return func(_ *http.Request) bool { return true }
	}
	allowSet := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		allowSet[o] = struct{}{}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		_, ok := allowSet[u.Scheme+"://"+u.Host]
		return ok
	}
}
