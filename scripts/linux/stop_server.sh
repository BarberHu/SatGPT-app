#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${SATGPT_APP_DIR:-/opt/satgpt}"
RUN_DIR="$APP_DIR/run"
ENV_FILE="$APP_DIR/.env"

log() {
  printf '[satgpt] %s\n' "$*"
}

stop_pid_file() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    log "$name pid file not found; skip"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    log "$name is not running"
    return 0
  fi

  log "Stopping $name, pid=$pid"
  kill "$pid" 2>/dev/null || true

  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "$name stopped"
      return 0
    fi
    sleep 1
  done

  log "$name did not stop gracefully; killing"
  kill -9 "$pid" 2>/dev/null || true
}

stop_port() {
  local name="$1"
  local port="$2"
  local pids

  pids="$(ss -lntp "( sport = :$port )" 2>/dev/null \
    | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
    | sort -u)"

  if [[ -z "$pids" ]]; then
    log "$name port $port is not listening"
    return 0
  fi

  log "Stopping $name process(es) on port $port: $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  sleep 2

  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      log "$name pid=$pid still alive; killing"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

stop_pid_file "frontend" "$RUN_DIR/frontend.pid"
stop_pid_file "runtime" "$RUN_DIR/runtime.pid"
stop_pid_file "agent" "$RUN_DIR/agent.pid"
stop_pid_file "mihomo" "$RUN_DIR/mihomo.pid"

stop_port "frontend" "${FRONTEND_PORT:-3000}"
stop_port "runtime" "${RUNTIME_PORT:-5000}"
stop_port "agent" "${AGENT_PORT:-8000}"
stop_port "mihomo" 7890

# Fallback for manually started processes in this deployment directory.
pkill -f "cd '$APP_DIR/frontend'.*npm start" 2>/dev/null || true
pkill -f "cd '$APP_DIR/runtime'.*npm start" 2>/dev/null || true
pkill -f "cd '$APP_DIR'.*python agent/server.py" 2>/dev/null || true

log "Stop complete."
