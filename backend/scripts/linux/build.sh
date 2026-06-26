#!/usr/bin/env bash
# build.sh — 初始化目录结构、编译 ZLMeetServer，并准备运行时配置。
# 用法：在任意位置执行，脚本自动定位到项目根。
#   bash backend/scripts/linux/build.sh

set -euo pipefail

# ── 路径定位 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_DIR="$BACKEND_DIR/src"
BIN_DIR="$BACKEND_DIR/bin"
CONF_DIR="$BIN_DIR/conf"
CERT_DIR="$BIN_DIR/cert"
BINARY="$BIN_DIR/ZLMeetServer"
CONFIG_EXAMPLE="$BACKEND_DIR/conf/config-example.yaml"
CONFIG_DST="$CONF_DIR/config.yaml"

echo "==> 后端源码目录: $SRC_DIR"
echo "==> 输出目录:     $BIN_DIR"

# ── 检查 Go 版本（要求 >= 1.21）─────────────────────────────────────────────
if ! command -v go &>/dev/null; then
    echo "[错误] 未找到 go 命令，请先安装 Go 1.21+" >&2
    exit 1
fi

GO_VERSION=$(go version | grep -oP 'go\K[0-9]+\.[0-9]+' | head -1)
GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

if [[ "$GO_MAJOR" -lt 1 || ("$GO_MAJOR" -eq 1 && "$GO_MINOR" -lt 21) ]]; then
    echo "[错误] 需要 Go 1.21+，当前版本：$(go version)" >&2
    exit 1
fi
echo "==> Go 版本: $(go version)"

# ── 创建目录结构 ─────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR" "$CONF_DIR" "$CERT_DIR"
echo "==> 目录已就绪: bin/  bin/conf/  bin/cert/"

# ── 生成运行时配置（已存在则跳过，避免覆盖用户修改）────────────────────────
if [[ ! -f "$CONFIG_DST" ]]; then
    if [[ ! -f "$CONFIG_EXAMPLE" ]]; then
        echo "[错误] 找不到配置模板: $CONFIG_EXAMPLE" >&2
        exit 1
    fi
    cp "$CONFIG_EXAMPLE" "$CONFIG_DST"
    sed -i 's|static_dir:.*|static_dir: "../../frontend"|' "$CONFIG_DST"
    sed -i 's|tls_cert:.*|tls_cert: "cert/cert.pem"|' "$CONFIG_DST"
    sed -i 's|tls_key:.*|tls_key:  "cert/key.pem"|' "$CONFIG_DST"
    sed -i 's|admin_static_dir:.*|admin_static_dir: "../../frontend/admin"|' "$CONFIG_DST"
    echo "==> 已生成配置文件: $CONFIG_DST"
    echo "    请按需修改 zlm.api_base 和 zlm.secret"
else
    echo "==> 配置文件已存在，跳过生成: $CONFIG_DST"
fi

# ── 拉取依赖 ─────────────────────────────────────────────────────────────────
echo "==> 正在执行 go mod tidy ..."
(cd "$SRC_DIR" && go mod tidy)

# ── 编译 ─────────────────────────────────────────────────────────────────────
echo "==> 正在编译..."
(cd "$SRC_DIR" && go build -trimpath -ldflags="-s -w" -o "$BINARY" ./cmd)

echo ""
echo "✓ 编译完成: $BINARY"
echo ""
echo "后续步骤："
echo "  1. 编辑配置:  vi $CONFIG_DST"
echo "  2. 如需 HTTPS，将证书放入: $CERT_DIR/"
echo "     文件名: cert.pem  key.pem（业务与管理端口共用）"
echo "  3. 启动服务:  bash $SCRIPT_DIR/start.sh"
