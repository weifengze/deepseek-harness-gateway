#!/usr/bin/env bash
# 一体化镜像入口：DSH + 网关同一个容器。
#
# 这里必须自己做「令牌桥」：dsh web 的启动令牌每个进程随机、只打印在 stdout 一次，
# 而网关只会从文件读。二者同容器时，抓一次落盘即可。
set -euo pipefail

DSH_PORT="${DSH_PORT:-3080}"
GATEWAY_PORT="${PORT:-8787}"
DSH_HOME="${DSH_HOME:-/home/dsh/.dsh}"
STATE_DIR="${STATE_DIR:-/var/lib/dsh-gateway}"
TOKEN_FILE="$STATE_DIR/dsh-token"
DSH_LOG="$STATE_DIR/dsh-web.log"
WORKSPACE="${WORKSPACE:-/workspace}"

mkdir -p "$DSH_HOME" "$STATE_DIR" "$WORKSPACE"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---------------------------------------------------------------- 权限模式
# DSH 的沙箱链是 bwrap → landlock → seatbelt，取第一个探测通过的。
# 容器里 bwrap 通常不可用（需要 user namespace），但 landlock 是**非特权**的，
# 一般仍然可用——实测写入边界照旧成立。所以这里只做诊断，不擅自降级：
# 擅自切成 danger-full-access 才是真的把边界拆了。
if [ -z "${DSH_PERMISSION_MODE:-}" ]; then
  DSH_PERMISSION_MODE=workspace-write
  if bwrap --ro-bind / / --dev /dev --proc /proc true >/dev/null 2>&1; then
    log "沙箱后端：bwrap 可用（完整强制）→ DSH_PERMISSION_MODE=workspace-write"
  else
    LANDLOCK=$(find /usr/local/lib/node_modules /usr/lib/node_modules \
      -path '*node-addon-system-linux-*/bin/landlock-run' -type f 2>/dev/null | head -1 || true)
    if [ -n "${LANDLOCK:-}" ]; then
      log "沙箱后端：bwrap 不可用（容器内常见），回退 landlock（部分强制，边界仍生效）"
      log "  → DSH_PERMISSION_MODE=workspace-write（写入限制在工作区）"
    else
      log "!! 未找到可用沙箱后端（bwrap 与 landlock 都不可用）。"
      log "!! 工具会以拒绝方式关闭（fail closed），而不是静默放开。"
      log "!! 若你的边界完全由容器承担，可显式设置 DSH_PERMISSION_MODE=danger-full-access。"
    fi
  fi
fi
export DSH_PERMISSION_MODE

# ---------------------------------------------------------------- 审批策略
# 无人值守必须关掉审批：approval/asked 没有应答者时会让整轮永久挂起。
PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  mkdir -p "$(dirname "$PATCH")"
  cat > "$PATCH" <<'YAML'
# 由容器入口生成：无人值守部署，审批一律确定性拒绝。
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high

- id: approval
  name: "@deepseek-ai/dsh-user-approval"
  config:
    policy: never

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: never
      workspace-write:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write
YAML
  log "已写入 profile 补丁：$PATCH（审批 never）"
fi

# ---------------------------------------------------------------- 网关配置
CONFIG=/opt/dsh-gateway/config.json
if [ ! -f "$CONFIG" ]; then
  log "!! 缺少 $CONFIG（镜像内应自带），使用内置默认"
  cat > "$CONFIG" <<JSON
{
  "server": { "host": "0.0.0.0", "port": $GATEWAY_PORT, "runTimeoutMs": 300000 },
  "dsh": { "baseUrl": "http://127.0.0.1:$DSH_PORT" },
  "agents": [{ "id": "assistant", "preset": "standard", "cwd": "$WORKSPACE" }],
  "storage": {
    "conversationsFile": "$STATE_DIR/conversations.json",
    "usageFile": "$STATE_DIR/usage.json"
  }
}
JSON
fi

# ---------------------------------------------------------------- API key
# 只有当配置里没有 auth.keys 时才生成一次性 key。
# 否则环境变量会**整体覆盖**配置里的 keys 数组，把用户挂进来的 admin key 冲掉。
HAS_CONFIG_KEYS=0
if [ -f "$CONFIG" ] && grep -q '"auth"' "$CONFIG" 2>/dev/null; then
  HAS_CONFIG_KEYS=1
fi

if [ -z "${DSH_GATEWAY_API_KEYS:-}" ] && [ "$HAS_CONFIG_KEYS" = "0" ]; then
  DSH_GATEWAY_API_KEYS="default:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
  export DSH_GATEWAY_API_KEYS
  # 单行输出，方便 `docker logs | grep` 直接取；重启会变，生产请显式传 DSH_GATEWAY_API_KEYS。
  log "未提供 DSH_GATEWAY_API_KEYS，本次启动生成一次性 key：${DSH_GATEWAY_API_KEYS#*:}"
elif [ "$HAS_CONFIG_KEYS" = "1" ]; then
  log "使用配置文件中已有的 auth.keys（未生成一次性 key）"
fi

# ---------------------------------------------------------------- 启动 dsh
log "启动 dsh web → 127.0.0.1:$DSH_PORT（权限模式 $DSH_PERMISSION_MODE）"
: > "$DSH_LOG"

DSH_PID=""
GATEWAY_PID=""
cleanup() {
  local code="${1:-0}"
  trap - TERM INT
  [ -n "$GATEWAY_PID" ] && kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  [ -n "$DSH_PID" ] && kill -TERM "$DSH_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$code"
}
trap cleanup TERM INT

dsh web --no-open --host 127.0.0.1 --port "$DSH_PORT" >>"$DSH_LOG" 2>&1 &
DSH_PID=$!

# ---------------------------------------------------------------- 令牌桥
for _ in $(seq 1 120); do
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    log "dsh 在拿到令牌前退出，日志尾部："
    tail -n 30 "$DSH_LOG" >&2 || true
    exit 1
  fi
  TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$DSH_LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)
  if [ -n "${TOKEN:-}" ]; then
    printf '%s' "$TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    break
  fi
  sleep 1
done

if [ ! -s "$TOKEN_FILE" ]; then
  log "120 秒内没拿到启动令牌，日志尾部："
  tail -n 30 "$DSH_LOG" >&2 || true
  exit 1
fi
log "dsh ready（token 已落盘）"

# ---------------------------------------------------------------- 启动网关
export DSH_BASE_URL="http://127.0.0.1:$DSH_PORT"
export DSH_TOKEN_FILE="$TOKEN_FILE"
export HOST="${HOST:-0.0.0.0}"
export PORT="$GATEWAY_PORT"
export DSH_GATEWAY_CONFIG="$CONFIG"

log "启动网关 → 0.0.0.0:$GATEWAY_PORT"
dsh-gateway &
GATEWAY_PID=$!

# 任一进程退出就整体退出，交给容器的 restart policy 处理，避免半死状态。
wait -n "$GATEWAY_PID" "$DSH_PID"
CODE=$?
log "有进程退出（code=$CODE），容器收尾"
cleanup "$CODE"
