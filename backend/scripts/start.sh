#!/usr/bin/env bash
# start.sh — 启动 zlm_meet 信令服务。
# 用法：在任意位置执行。
#   bash backend/scripts/start.sh

set -euo pipefail

# ── 路径定位 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BACKEND_DIR/bin"
BINARY="$BIN_DIR/zlm_meet"
CONFIG="$BIN_DIR/conf/config.yaml"

# ── 前置检查 ─────────────────────────────────────────────────────────────────
if [[ ! -f "$BINARY" ]]; then
    echo "[错误] 未找到可执行文件: $BINARY" >&2
    echo "       请先执行: bash $SCRIPT_DIR/build.sh" >&2
    exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
    echo "[错误] 未找到配置文件: $CONFIG" >&2
    echo "       请先执行: bash $SCRIPT_DIR/build.sh" >&2
    exit 1
fi

# ── 启动 ─────────────────────────────────────────────────────────────────────
echo "==> 启动 zlm_meet"
echo "    二进制: $BINARY"
echo "    配置:   $CONFIG"
echo "    工作目录: $BIN_DIR"
echo ""

# 切换到 bin/ 目录运行，保证 static_dir / cert 等相对路径正确解析
cd "$BIN_DIR"
exec ./zlm_meet -config conf/config.yaml
