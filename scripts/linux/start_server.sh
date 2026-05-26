#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${SATGPT_APP_DIR:-/opt/satgpt}"
ENV_FILE="$APP_DIR/.env"
RUN_DIR="$APP_DIR/run"
LOG_DIR="$APP_DIR/logs"
MIHOMO_CONFIG_DIR="${MIHOMO_CONFIG_DIR:-$HOME/.config/mihomo}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() {
  printf '[satgpt] %s\n' "$*"
}

fail() {
  printf '[satgpt][error] %s\n' "$*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "Missing required file: $path"
}

require_file "$ENV_FILE"
require_file "$APP_DIR/flood-venv/bin/activate"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

AGENT_PORT="${AGENT_PORT:-8000}"
RUNTIME_PORT="${RUNTIME_PORT:-5000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
SATGPT_SERVICE_HOST="${SATGPT_SERVICE_HOST:-127.0.0.1}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
REACT_APP_COPILOTKIT_URL="${REACT_APP_COPILOTKIT_URL:-/copilotkit}"

is_port_listening() {
  local port="$1"
  ss -lnt "( sport = :$port )" | tail -n +2 | grep -q .
}

wait_for_port() {
  local name="$1"
  local port="$2"
  local attempts="${3:-30}"

  for _ in $(seq 1 "$attempts"); do
    if is_port_listening "$port"; then
      log "$name is listening on port $port"
      return 0
    fi
    sleep 1
  done

  fail "$name did not start on port $port. Check logs in $LOG_DIR"
}

start_process() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  shift 3

  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      log "$name already running, pid=$old_pid"
      return 0
    fi
  fi

  log "Starting $name ..."
  nohup "$@" > "$log_file" 2>&1 &
  echo "$!" > "$pid_file"
  log "$name pid=$(cat "$pid_file"), log=$log_file"
}

ensure_nvm_node() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [[ -s "$NVM_DIR/nvm.sh" ]] || fail "nvm not found at $NVM_DIR/nvm.sh"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use 22.16.0 >/dev/null
}

sync_frontend_env() {
  log "Syncing frontend/.env.local"
  cat > "$APP_DIR/frontend/.env.local" <<EOF
HOST=$FRONTEND_HOST
PORT=$FRONTEND_PORT
SATGPT_SERVICE_HOST=$SATGPT_SERVICE_HOST
AGENT_PORT=$AGENT_PORT
RUNTIME_PORT=$RUNTIME_PORT
GENERATE_SOURCEMAP=${GENERATE_SOURCEMAP:-false}
REACT_APP_MAPBOX_ACCESS_KEY=${REACT_APP_MAPBOX_ACCESS_KEY:-}
REACT_APP_API_URL=${REACT_APP_API_URL:-}
REACT_APP_COPILOTKIT_URL=$REACT_APP_COPILOTKIT_URL
EOF
}

start_mihomo() {
  if ! command -v mihomo >/dev/null 2>&1; then
    log "mihomo not found; skip proxy startup"
    return 0
  fi

  if is_port_listening 7890; then
    log "mihomo proxy already listening on 7890"
    return 0
  fi

  require_file "$MIHOMO_CONFIG_DIR/config.yaml"
  start_process \
    "mihomo" \
    "$RUN_DIR/mihomo.pid" \
    "$LOG_DIR/mihomo.log" \
    mihomo -d "$MIHOMO_CONFIG_DIR"
  wait_for_port "mihomo" 7890 10
}

cd "$APP_DIR"
sync_frontend_env
start_mihomo

start_process \
  "agent" \
  "$RUN_DIR/agent.pid" \
  "$LOG_DIR/agent.log" \
  bash -lc "cd '$APP_DIR' && source flood-venv/bin/activate && python agent/server.py"
wait_for_port "agent" "$AGENT_PORT" 45

ensure_nvm_node

start_process \
  "runtime" \
  "$RUN_DIR/runtime.pid" \
  "$LOG_DIR/runtime.log" \
  bash -lc "cd '$APP_DIR/runtime' && export NVM_DIR='$NVM_DIR' && source '$NVM_DIR/nvm.sh' && nvm use 22.16.0 >/dev/null && npm start"
wait_for_port "runtime" "$RUNTIME_PORT" 30

start_process \
  "frontend" \
  "$RUN_DIR/frontend.pid" \
  "$LOG_DIR/frontend.log" \
  bash -lc "cd '$APP_DIR/frontend' && export NVM_DIR='$NVM_DIR' && source '$NVM_DIR/nvm.sh' && nvm use 22.16.0 >/dev/null && export BROWSER=none && npm start"
wait_for_port "frontend" "$FRONTEND_PORT" 45

log "All services started."
log "Frontend: http://${SATGPT_PUBLIC_HOST:-127.0.0.1}:$FRONTEND_PORT"
log "Health:   curl http://127.0.0.1:$AGENT_PORT/health"
