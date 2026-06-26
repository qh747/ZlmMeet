package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/signaling"
)

const adminTokenHeader = "X-Admin-Token"

// NewAdmin builds the HTTPS admin handler (API + static admin UI).
func NewAdmin(cfg *config.Config, hub *signaling.Hub) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/admin/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := hub.ValidateToken(req.Token); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"message": err.Error(),
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})

	mux.Handle("/api/admin/dashboard", requireAdmin(hub, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hubStats := hub.StatsSnapshot()

		var zlmStreams []interface{}
		var zlmError string
		media, err := hub.ZLM().GetMediaList()
		if err != nil {
			zlmError = err.Error()
			log.Warn().Err(err).Msg("admin getMediaList")
		} else {
			zlmStreams = make([]interface{}, len(media))
			for i, m := range media {
				zlmStreams[i] = m
			}
		}

		// Count unique app/stream pairs (ZLM may list multiple schemas per stream).
		uniqueStreams := make(map[string]struct{})
		for _, m := range media {
			uniqueStreams[m.App+"/"+m.Stream] = struct{}{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hub": hubStats,
			"zlm": map[string]any{
				"streamCount": len(uniqueStreams),
				"mediaCount":  len(media),
				"streams":     zlmStreams,
				"error":       zlmError,
			},
		})
	}))

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	// Admin UI lives under admin_static_dir but reuses shared css/assets from the
	// business frontend tree (see frontend/admin/index.html).
	sharedRoot := cfg.StaticDir
	if sharedRoot == "" && cfg.AdminStaticDir != "" {
		sharedRoot = filepath.Dir(cfg.AdminStaticDir)
	}
	if sharedRoot != "" {
		mux.Handle("/css/", cssHandler(cfg.AdminStaticDir, sharedRoot))
		mux.Handle("/assets/", assetsHandler(cfg.AdminStaticDir, sharedRoot))
	} else if cfg.AdminStaticDir != "" {
		mux.Handle("/assets/", assetsHandler(cfg.AdminStaticDir, ""))
	}

	if cfg.AdminStaticDir != "" {
		adminFS := http.FileServer(http.Dir(cfg.AdminStaticDir))
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			if strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/css/") || strings.HasPrefix(p, "/api/") {
				http.NotFound(w, r)
				return
			}
			adminFS.ServeHTTP(w, r)
		}))
		log.Info().Str("path", cfg.AdminStaticDir).Msg("serving admin static files")
	}

	return mux
}

// cssHandler serves admin-local styles first, then falls back to the shared frontend css dir.
func cssHandler(adminStaticDir, sharedRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/css/")
		if name == "" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if adminStaticDir != "" {
			adminPath := filepath.Join(adminStaticDir, "css", name)
			if info, err := os.Stat(adminPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, adminPath)
				return
			}
		}
		sharedPath := filepath.Join(sharedRoot, "css", name)
		if info, err := os.Stat(sharedPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, sharedPath)
			return
		}
		http.NotFound(w, r)
	})
}

// assetsHandler serves admin-local assets first, then falls back to the shared frontend assets dir.
func assetsHandler(adminStaticDir, sharedRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/assets/")
		if name == "" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		var filePath string
		if adminStaticDir != "" {
			adminPath := filepath.Join(adminStaticDir, "assets", name)
			if info, err := os.Stat(adminPath); err == nil && !info.IsDir() {
				filePath = adminPath
			}
		}
		if filePath == "" && sharedRoot != "" {
			sharedPath := filepath.Join(sharedRoot, "assets", name)
			if info, err := os.Stat(sharedPath); err == nil && !info.IsDir() {
				filePath = sharedPath
			}
		}
		if filePath == "" {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(strings.ToLower(name), ".svg") {
			w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		}
		http.ServeFile(w, r, filePath)
	})
}

func requireAdmin(hub *signaling.Hub, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(r.Header.Get(adminTokenHeader))
		if err := hub.ValidateToken(token); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"message": err.Error(),
			})
			return
		}
		next(w, r)
	})
}
