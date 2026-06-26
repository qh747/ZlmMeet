package staticdir

import (
	"os"
	"path/filepath"

	"github.com/rs/zerolog/log"
)

// WarnIfMisconfigured logs a warning when a frontend static directory is missing,
// invalid, or does not contain the expected entry page.
func WarnIfMisconfigured(field, dir, indexFile string) {
	label := staticLabel(field)
	if dir == "" {
		log.Warn().Str("field", field).Msg(label + "未配置，页面将无法访问")
		return
	}

	info, err := os.Stat(dir)
	if err != nil {
		log.Warn().Err(err).Str("field", field).Str("path", dir).
			Msg(label + "路径无效或不存在")
		return
	}
	if !info.IsDir() {
		log.Warn().Str("field", field).Str("path", dir).
			Msg(label + "路径不是目录")
		return
	}

	index := filepath.Join(dir, indexFile)
	if _, err := os.Stat(index); err != nil {
		log.Warn().Err(err).Str("field", field).Str("path", dir).Str("index", indexFile).
			Msg(label + "目录缺少入口页，路径可能配置错误")
	}
}

func staticLabel(field string) string {
	switch field {
	case "static_dir":
		return "业务前端静态目录"
	case "admin_static_dir":
		return "管理后台静态目录"
	default:
		return "前端静态目录"
	}
}
