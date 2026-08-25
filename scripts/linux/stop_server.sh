#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
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

[[ -f "$ENV_FILE" ]] || { log "Missing required file: $ENV_FILE"; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for variable_name in FRONTEND_PORT RUNTIME_PORT AGENT_PORT; do
  [[ -v "$variable_name" ]] || { log "Missing required environment variable: $variable_name"; exit 1; }
  [[ -n "${!variable_name}" ]] || { log "Environment variable must not be empty: $variable_name"; exit 1; }
done

stop_pid_file "frontend" "$RUN_DIR/frontend.pid"
stop_pid_file "runtime" "$RUN_DIR/runtime.pid"
stop_pid_file "agent" "$RUN_DIR/agent.pid"
stop_pid_file "mihomo" "$RUN_DIR/mihomo.pid"

stop_port "frontend" "$FRONTEND_PORT"
stop_port "runtime" "$RUNTIME_PORT"
stop_port "agent" "$AGENT_PORT"
stop_port "mihomo" 7890

# Fallback for manually started processes in this deployment directory.
pkill -f "cd '$APP_DIR/frontend'.*npm start" 2>/dev/null || true
pkill -f "cd '$APP_DIR/runtime'.*npm start" 2>/dev/null || true
pkill -f "cd '$APP_DIR'.*python agent/server.py" 2>/dev/null || true

log "Stop complete."
