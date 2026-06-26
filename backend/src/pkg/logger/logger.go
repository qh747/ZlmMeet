package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// Init configures the global zerolog logger and default level (info).
func Init() {
	zerolog.CallerMarshalFunc = func(_ uintptr, file string, line int) string {
		return filepath.Base(file) + fmt.Sprintf(":%d", line)
	}

	output := zerolog.ConsoleWriter{
		Out:        os.Stdout,
		TimeFormat: "2006-01-02 15:04:05",
		PartsOrder: []string{
			zerolog.TimestampFieldName,
			zerolog.LevelFieldName,
			zerolog.CallerFieldName,
			zerolog.MessageFieldName,
		},
	}
	log.Logger = zerolog.New(output).With().Timestamp().Caller().Logger()
	zerolog.SetGlobalLevel(zerolog.InfoLevel)
}

// SetLevel applies a log level from config (debug/info/warn/error).
// Empty or invalid values fall back to info with a warning.
func SetLevel(level string) {
	if level == "" {
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
		return
	}
	lvl, err := zerolog.ParseLevel(strings.ToLower(strings.TrimSpace(level)))
	if err != nil {
		log.Warn().Str("log_level", level).Msg("无效的日志级别，已使用 info")
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
		return
	}
	zerolog.SetGlobalLevel(lvl)
}
