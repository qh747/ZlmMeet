package main

import (
	"context"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/logger"
	"zlm_meet/backend/pkg/server"
	"zlm_meet/backend/pkg/signaling"
	"zlm_meet/backend/pkg/staticdir"
	"zlm_meet/backend/pkg/zlm"
)

func main() {
	logger.Init()

	cfgPath := flag.String("config", "config.yaml", "path to YAML config file")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatal().Err(err).Msg("load config")
	}
	logger.SetLevel(cfg.LogLevel)

	staticdir.WarnIfMisconfigured("static_dir", cfg.StaticDir, "index.html")
	if cfg.AdminListen != "" {
		staticdir.WarnIfMisconfigured("admin_static_dir", cfg.AdminStaticDir, "index.html")
	}

	zlmClient := zlm.New(cfg.ZLM)
	hub := signaling.NewHub(zlmClient, cfg.Token)
	handler := server.NewBusiness(cfg, hub)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	useTLS := cfg.TLSCert != "" && cfg.TLSKey != ""
	businessScheme := "HTTP"
	if useTLS {
		businessScheme = "HTTPS"
	}

	log.Info().Msg("listening:")
	log.Info().Str("port", cfg.Listen).Str("scheme", businessScheme).Msg("business")
	if cfg.AdminListen != "" {
		if !useTLS {
			log.Fatal().Msg("admin_listen is set but tls_cert/tls_key are missing")
		}
		log.Info().Str("port", cfg.AdminListen).Str("scheme", "HTTPS").Msg("admin")
	}
	log.Info().Str("api_base", cfg.ZLM.APIBase).Msg("zlm api")

	go func() {
		var err error
		if useTLS {
			err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("listen")
		}
	}()

	// Admin HTTPS server (optional second listener).
	var adminSrv *http.Server
	if cfg.AdminListen != "" {
		adminHandler := server.NewAdmin(cfg, hub)
		adminSrv = &http.Server{
			Addr:              cfg.AdminListen,
			Handler:           adminHandler,
			ReadHeaderTimeout: 10 * time.Second,
		}
		go func() {
			if err := adminSrv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey); err != nil && err != http.ErrServerClosed {
				log.Fatal().Err(err).Msg("admin listen")
			}
		}()
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	log.Info().Msg("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if adminSrv != nil {
		_ = adminSrv.Shutdown(ctx)
	}
	_ = srv.Shutdown(ctx)
}
