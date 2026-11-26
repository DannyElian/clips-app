#!/usr/bin/env bash
# Enciende o apaga CLIPS en http://localhost:8787, con Postgres y Ollama.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8787}"
PID_FILE="$ROOT/data/server.pid"
LOG_FILE="$ROOT/data/server.log"
OLLAMA_PID_FILE="$ROOT/data/ollama.pid"
OLLAMA_LOG="$ROOT/data/ollama.log"
URL="http://localhost:${PORT}"
OLLAMA_BIN="${OLLAMA_BIN:-$HOME/.local/ollama/ollama}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
PG_PORT="${PG_PORT:-5432}"
PG_SOCKET="/tmp/.s.PGSQL.${PG_PORT}"
PSQL="/Applications/Postgres.app/Contents/Versions/latest/bin/psql"

cd "$ROOT"

env_value() {
  local key="$1" default="$2" line
  line="$(grep -E "^${key}=" "$ROOT/.env" 2>/dev/null | tail -1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  if [[ -n "$line" ]]; then
    printf '%s' "$line"
  else
    printf '%s' "$default"
  fi
}

OLLAMA_MODEL="$(env_value OLLAMA_MODEL llama3.2)"

pids_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

postgres_up() {
  [[ -S "$PG_SOCKET" ]] || [[ -n "$(pids_on_port "$PG_PORT")" ]]
}

ollama_up() {
  [[ -n "$(pids_on_port "$OLLAMA_PORT")" ]]
}

# Sale del grupo de este script para que siga vivo al cerrar la terminal.
spawn_detached() {
  local pid_file="$1" log_file="$2" workdir="$3"
  shift 3
  python3 - "$pid_file" "$log_file" "$workdir" "$@" <<'PY'
import os, sys
pid_file, log_file, workdir, *cmd = sys.argv[1:]
if os.fork() > 0:
    raise SystemExit(0)
os.setsid()
if os.fork() > 0:
    raise SystemExit(0)
fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
if fd > 2:
    os.close(fd)
os.chdir(workdir)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(os.getpid()))
os.execvp(cmd[0], cmd)
PY
}

wait_until() {
  local tries="$1"
  shift
  local _
  for _ in $(seq 1 "$tries"); do
    if "$@"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stop_pids() {
  local pids="$1"
  [[ -z "$pids" ]] && return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    local still="" pid
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        still="$still $pid"
      fi
    done
    [[ -z "${still// /}" ]] && return 0
    sleep 0.25
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

ensure_postgres() {
  if postgres_up; then
    echo "Postgres ya esta encendido."
  elif [[ -d "/Applications/Postgres.app" ]]; then
    echo "Encendiendo Postgres..."
    open -a Postgres
    if ! wait_until 80 postgres_up; then
      echo "Postgres no arranco. Abre Postgres.app y vuelve a intentar."
      return 1
    fi
    echo "Postgres encendido."
  else
    echo "Postgres no esta encendido y no esta Postgres.app."
    return 1
  fi

  if [[ -x "$PSQL" ]]; then
    if ! "$PSQL" -h /tmp -p "$PG_PORT" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='clips'" | grep -q 1; then
      echo "Creando la base clips..."
      "$PSQL" -h /tmp -p "$PG_PORT" -d postgres -c "CREATE DATABASE clips" >/dev/null
    fi
  fi
}

ensure_ollama() {
  if [[ ! -x "$OLLAMA_BIN" ]]; then
    echo "No esta Ollama en $OLLAMA_BIN"
    return 1
  fi
  mkdir -p "$ROOT/data" "$HOME/.ollama"
  if ollama_up; then
    echo "Ollama ya esta encendido."
  else
    echo "Encendiendo Ollama..."
    spawn_detached "$OLLAMA_PID_FILE" "$OLLAMA_LOG" "$ROOT" "$OLLAMA_BIN" serve
    if ! wait_until 40 ollama_up; then
      echo "Ollama no arranco. Mira $OLLAMA_LOG"
      return 1
    fi
    echo "Ollama encendido."
  fi
  if ! "$OLLAMA_BIN" list 2>/dev/null | awk '{print $1}' | grep -Eq "^${OLLAMA_MODEL}(:|$)"; then
    echo "Bajando el modelo ${OLLAMA_MODEL}..."
    "$OLLAMA_BIN" pull "$OLLAMA_MODEL"
  fi
}

stop_ollama() {
  local pids
  pids="$(pids_on_port "$OLLAMA_PORT")"
  if [[ -z "$pids" && -f "$OLLAMA_PID_FILE" ]]; then
    pids="$(cat "$OLLAMA_PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]]; then
    rm -f "$OLLAMA_PID_FILE"
    echo "Ollama ya estaba apagado."
    return 0
  fi
  echo "Apagando Ollama ($pids)..."
  stop_pids "$pids"
  rm -f "$OLLAMA_PID_FILE"
  echo "Ollama apagado."
}

status() {
  local ok=0 pids
  pids="$(pids_on_port "$PORT")"
  if [[ -n "$pids" ]]; then
    echo "CLIPS: Encendido - ${URL} - pid ${pids//$'\n'/, }"
  else
    echo "CLIPS: Apagado - ${URL}"
    ok=1
  fi
  if postgres_up; then
    echo "Postgres: Encendido - puerto ${PG_PORT}"
  else
    echo "Postgres: Apagado - puerto ${PG_PORT}"
    ok=1
  fi
  if ollama_up; then
    echo "Ollama: Encendido - puerto ${OLLAMA_PORT} - modelo ${OLLAMA_MODEL}"
  else
    echo "Ollama: Apagado - puerto ${OLLAMA_PORT}"
    ok=1
  fi
  return "$ok"
}

stop() {
  local pids
  pids="$(pids_on_port "$PORT")"
  if [[ -z "$pids" ]]; then
    rm -f "$PID_FILE"
    echo "CLIPS ya estaba apagado."
  else
    echo "Apagando CLIPS ($pids)..."
    stop_pids "$pids"
    rm -f "$PID_FILE"
    echo "CLIPS apagado."
  fi
  stop_ollama
}

start() {
  local pids
  mkdir -p "$ROOT/data"
  ensure_postgres
  ensure_ollama
  pids="$(pids_on_port "$PORT")"
  if [[ -n "$pids" ]]; then
    echo "CLIPS ya esta encendido - ${URL} - pid ${pids//$'\n'/, }"
    return 0
  fi
  echo "Encendiendo ${URL}..."
  spawn_detached "$PID_FILE" "$LOG_FILE" "$ROOT" npm start
  if wait_until 80 bash -c "lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1"; then
    echo "Encendido - ${URL}"
    echo "Log: $LOG_FILE"
    return 0
  fi
  echo "No arranco a tiempo. Mira $LOG_FILE"
  return 1
}

cmd="${1:-}"
case "$cmd" in
  on) start ;;
  off) stop ;;
  restart)
    stop
    start
    ;;
  state) status ;;
  *)
    echo "Uso: $0 on | off | restart | state"
    exit 1
    ;;
esac
