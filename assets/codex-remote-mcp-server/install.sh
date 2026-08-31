#!/usr/bin/env bash
set -euo pipefail

INSTALL_START_MS="$(date +%s%3N)"
trace_phase() {
  if [[ "${REMOTE_MCP_TIMING:-0}" == "1" ]]; then
    echo "remote_install $1=$(( $(date +%s%3N) - INSTALL_START_MS ))ms" >&2
  fi
}

INSTALL_DIR="${REMOTE_MCP_INSTALL_DIR:-$HOME/.local/share/codex-remote-mcp}"
SOURCE_BINARY="${REMOTE_MCP_BINARY:-$(cd "$(dirname "$0")" && pwd)/codex-remote-mcp-server}"
if [[ -n "${REMOTE_MCP_WORKDIR:-}" ]]; then
  WORKDIR="$REMOTE_MCP_WORKDIR"
elif [[ -f "$PWD/project/package.json" ]]; then
  WORKDIR="$PWD/project"
else
  WORKDIR="$PWD"
fi
LISTEN="${REMOTE_MCP_LISTEN:-127.0.0.1:7890}"
LOG_DIR="$INSTALL_DIR/logs"
PID_FILE="${REMOTE_MCP_PID_FILE:-$INSTALL_DIR/server.pid}"
MACHINE_CODE_FILE="${REMOTE_MCP_MACHINE_CODE_FILE:-$INSTALL_DIR/machine-code}"
DEPLOYMENT_KEY="${REMOTE_MCP_DEPLOY_KEY:-}"
BEARER_TOKEN_FILE="${REMOTE_MCP_BEARER_TOKEN_FILE:-$INSTALL_DIR/bearer-token}"
BEARER_TOKEN_SOURCE="${REMOTE_MCP_BEARER_TOKEN_SOURCE:-}"
CURL_AUTH_CONFIG="${REMOTE_MCP_CURL_AUTH_CONFIG:-$INSTALL_DIR/curl-auth.conf}"
SERVICE_MODE="${REMOTE_MCP_SERVICE_MODE:-auto}"
SERVICE_NAME="${REMOTE_MCP_SERVICE_NAME:-codex-remote-mcp}"

[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != *$'\n'* && "$INSTALL_DIR" != *$'\r'* ]] \
  || { echo "REMOTE_MCP_INSTALL_DIR must be an absolute single-line path" >&2; exit 2; }
[[ "$WORKDIR" == /* && "$WORKDIR" != *$'\n'* && "$WORKDIR" != *$'\r'* ]] \
  || { echo "REMOTE_MCP_WORKDIR must be an absolute single-line path" >&2; exit 2; }
[[ "$LISTEN" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]] \
  && (( BASH_REMATCH[1] >= 1 && BASH_REMATCH[1] <= 65535 )) \
  || { echo "REMOTE_MCP_LISTEN must be 127.0.0.1:<port>" >&2; exit 2; }
[[ "$BEARER_TOKEN_FILE" == /* ]] || { echo "REMOTE_MCP_BEARER_TOKEN_FILE must be absolute" >&2; exit 2; }
[[ "$CURL_AUTH_CONFIG" == /* ]] || { echo "REMOTE_MCP_CURL_AUTH_CONFIG must be absolute" >&2; exit 2; }
[[ "$SERVICE_MODE" =~ ^(auto|detached|systemd-system)$ ]] || { echo "invalid REMOTE_MCP_SERVICE_MODE" >&2; exit 2; }
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$ ]] || { echo "invalid REMOTE_MCP_SERVICE_NAME" >&2; exit 2; }

if [[ ! -f "$SOURCE_BINARY" ]]; then
  echo "precompiled remote MCP binary not found: $SOURCE_BINARY" >&2
  exit 1
fi
umask 077
if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
  [[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" && -O "$INSTALL_DIR" ]] || {
    echo "install directory must be a user-owned, non-symlink directory: $INSTALL_DIR" >&2
    exit 2
  }
else
  mkdir -p "$INSTALL_DIR"
fi
chmod 700 "$INSTALL_DIR"
mkdir -p "$WORKDIR"
printf '%s\n' "$WORKDIR" > "$INSTALL_DIR/workspace-root.next"
chmod 600 "$INSTALL_DIR/workspace-root.next"
mv -f "$INSTALL_DIR/workspace-root.next" "$INSTALL_DIR/workspace-root"
if [[ -e "$LOG_DIR" || -L "$LOG_DIR" ]]; then
  [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" && -O "$LOG_DIR" ]] || {
    echo "log directory must be a user-owned, non-symlink directory: $LOG_DIR" >&2
    exit 2
  }
else
  mkdir "$LOG_DIR"
fi
chmod 700 "$LOG_DIR"

if [[ -n "$BEARER_TOKEN_SOURCE" ]]; then
  [[ -f "$BEARER_TOKEN_SOURCE" && ! -L "$BEARER_TOKEN_SOURCE" ]] || {
    echo "REMOTE_MCP_BEARER_TOKEN_SOURCE must be a regular non-symlink file" >&2
    exit 2
  }
  bearer_token="$(cat "$BEARER_TOKEN_SOURCE")"
elif [[ -f "$BEARER_TOKEN_FILE" && ! -L "$BEARER_TOKEN_FILE" ]]; then
  bearer_token="$(cat "$BEARER_TOKEN_FILE")"
else
  if command -v openssl >/dev/null 2>&1; then
    bearer_token="$(openssl rand -hex 32)"
  else
    bearer_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
fi
(( ${#bearer_token} >= 32 && ${#bearer_token} <= 512 )) \
  && [[ "$bearer_token" =~ ^[A-Za-z0-9._~-]+$ ]] || {
  echo "remote MCP bearer token must be 32-512 URL-safe ASCII characters" >&2
  exit 2
}
printf '%s\n' "$bearer_token" > "$BEARER_TOKEN_FILE.next"
chmod 600 "$BEARER_TOKEN_FILE.next"
mv -f "$BEARER_TOKEN_FILE.next" "$BEARER_TOKEN_FILE"
printf 'header = "Authorization: Bearer %s"\n' "$bearer_token" > "$CURL_AUTH_CONFIG.next"
chmod 600 "$CURL_AUTH_CONFIG.next"
mv -f "$CURL_AUTH_CONFIG.next" "$CURL_AUTH_CONFIG"
unset bearer_token

effective_service_mode="$SERVICE_MODE"
if [[ "$effective_service_mode" == auto ]]; then
  if [[ "$(id -u)" == 0 && -d /run/systemd/system ]] \
      && command -v systemctl >/dev/null 2>&1 \
      && systemctl show-environment >/dev/null 2>&1; then
    effective_service_mode=systemd-system
  else
    effective_service_mode=detached
  fi
fi
if [[ "$effective_service_mode" == systemd-system ]]; then
  [[ "$(id -u)" == 0 ]] || { echo "systemd-system service mode requires root" >&2; exit 2; }
  [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 \
    && systemctl show-environment >/dev/null 2>&1 || {
      echo "systemd-system service mode requires a running systemd manager" >&2
      exit 2
    }
  [[ "$INSTALL_DIR$WORKDIR" != *[$'\n\r\t %']* ]] || {
    echo "systemd-system service mode requires paths without whitespace or percent signs" >&2
    exit 2
  }
  systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
fi

process_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] \
    && kill -0 "$pid" 2>/dev/null \
    && ps -p "$pid" -o stat= 2>/dev/null | grep -Eqv '^[[:space:]]*Z'
}

process_has_argument_pair() {
  local pid="$1"
  local expected_key="$2"
  local expected_value="$3"
  local previous=""
  local argument
  while IFS= read -r -d '' argument; do
    if [[ "$previous" == "$expected_key" && "$argument" == "$expected_value" ]]; then
      return 0
    fi
    previous="$argument"
  done < "/proc/$pid/cmdline"
  return 1
}

process_has_argument() {
  local pid="$1"
  local expected="$2"
  local argument
  while IFS= read -r -d '' argument; do
    [[ "$argument" == "$expected" ]] && return 0
  done < "/proc/$pid/cmdline"
  return 1
}

process_is_managed_server() {
  local pid="$1"
  process_is_running "$pid" || return 1
  [[ -r "/proc/$pid/cmdline" && -e "$INSTALL_DIR/codex-remote-mcp-server" ]] || return 1
  if [[ ! "$INSTALL_DIR/codex-remote-mcp-server" -ef "/proc/$pid/exe" ]]; then
    # Test and development fixtures may be shebang executables, in which case
    # /proc/<pid>/exe is the interpreter. Still require the exact installed
    # path in argv before treating the process as owned by this install.
    process_has_argument "$pid" "$INSTALL_DIR/codex-remote-mcp-server" || return 1
  fi
  # Root and bearer-token paths are mutable deployment configuration. Requiring
  # the new values here makes a legitimate reconfiguration unable to stop the
  # previous instance, which then keeps the loopback port occupied. Executable
  # inode plus the exact listener uniquely identifies the server owned by this
  # install directory without trusting a stale PID file.
  process_has_argument_pair "$pid" --listen "$LISTEN"
}

previous_pids="$(cat "$PID_FILE" 2>/dev/null || true)"
if command -v pgrep >/dev/null 2>&1; then
  discovered_pids="$(pgrep -f -- "$INSTALL_DIR/[c]odex-remote-mcp-server.*--listen $LISTEN" 2>/dev/null || true)"
  previous_pids="$(printf '%s\n%s\n' "$previous_pids" "$discovered_pids")"
fi
previous_pids="$(printf '%s\n' "$previous_pids" | awk '/^[0-9]+$/ && !seen[$0]++')"
for previous_pid in $previous_pids; do
  if process_is_managed_server "$previous_pid"; then
    kill "$previous_pid" 2>/dev/null || true
  fi
done
for _ in $(seq 1 10); do
  any_running=0
  for previous_pid in $previous_pids; do
    process_is_managed_server "$previous_pid" && any_running=1
  done
  (( any_running == 0 )) && break
  sleep 0.05
done
for previous_pid in $previous_pids; do
  if process_is_managed_server "$previous_pid"; then
    kill -KILL "$previous_pid" 2>/dev/null || true
  fi
done
rm -f "$PID_FILE"
trace_phase previous_stopped

install -m 700 "$SOURCE_BINARY" "$INSTALL_DIR/codex-remote-mcp-server.next"
mv -f "$INSTALL_DIR/codex-remote-mcp-server.next" "$INSTALL_DIR/codex-remote-mcp-server"
trace_phase binary_replaced

{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf 'export REMOTE_ROOT=%q\n' "$WORKDIR"
  printf 'export REMOTE_MCP_LISTEN=%q\n' "$LISTEN"
  printf 'export REMOTE_MCP_MACHINE_CODE_FILE=%q\n' "$MACHINE_CODE_FILE"
  printf 'export REMOTE_MCP_BEARER_TOKEN_FILE=%q\n' "$BEARER_TOKEN_FILE"
  printf 'cd %q\n' "$WORKDIR"
  printf '%s %q\n' 'printf '\''%s\n'\'' "$$" >' "$PID_FILE.next"
  printf 'chmod 600 %q\n' "$PID_FILE.next"
  printf 'mv -f %q %q\n' "$PID_FILE.next" "$PID_FILE"
  printf 'exec %q --root %q --listen %q --bearer-token-file %q\n' \
    "$INSTALL_DIR/codex-remote-mcp-server" "$WORKDIR" "$LISTEN" "$BEARER_TOKEN_FILE"
} > "$INSTALL_DIR/start.sh"
chmod 700 "$INSTALL_DIR/start.sh"
trace_phase launcher_prepared
if [[ "$effective_service_mode" == systemd-system ]]; then
  UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
  cat > "$UNIT_FILE.next" <<EOF
[Unit]
Description=Codex Remote MCP Server
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$WORKDIR
ExecStart=$INSTALL_DIR/start.sh
Restart=always
RestartSec=2
KillMode=control-group
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT_FILE.next"
  mv -f "$UNIT_FILE.next" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME.service" >/dev/null
  printf '%s\n' "$SERVICE_NAME.service" > "$INSTALL_DIR/service-name.next"
  chmod 600 "$INSTALL_DIR/service-name.next"
  mv -f "$INSTALL_DIR/service-name.next" "$INSTALL_DIR/service-name"
  launcher_pid="$(systemctl show -p MainPID --value "$SERVICE_NAME.service")"
else
  rm -f "$INSTALL_DIR/service-name"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$INSTALL_DIR/start.sh" >"$LOG_DIR/server.log" 2>&1 </dev/null &
  else
    nohup "$INSTALL_DIR/start.sh" >"$LOG_DIR/server.log" 2>&1 </dev/null &
  fi
  launcher_pid=$!
fi
for _ in $(seq 1 500); do
  [[ -s "$PID_FILE" ]] && break
  kill -0 "$launcher_pid" 2>/dev/null || true
  sleep 0.01
done
server_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ ! "$server_pid" =~ ^[0-9]+$ ]]; then
  sed -n '1,160p' "$LOG_DIR/server.log" >&2 || true
  echo "codex-remote-mcp-server did not publish its pid" >&2
  exit 1
fi
trace_phase process_started

deadline=$((SECONDS + 30))
headers_file="$INSTALL_DIR/readiness-headers.$$.tmp"
server_is_running() {
  process_is_running "$server_pid"
}
until server_is_running && curl -fsS -D "$headers_file" -o /dev/null \
    --config "$CURL_AUTH_CONFIG" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"installer","version":"1"}}}' \
    "http://127.0.0.1:${LISTEN##*:}/mcp" \
    && grep -qi '^mcp-session-id:' "$headers_file"; do
  if ! server_is_running; then
    sed -n '1,160p' "$LOG_DIR/server.log" >&2 || true
    rm -f "$headers_file"
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    sed -n '1,160p' "$LOG_DIR/server.log" >&2 || true
    echo "timed out waiting for codex-remote-mcp-server" >&2
    if process_is_managed_server "$server_pid"; then
      kill "$server_pid" 2>/dev/null || true
    fi
    rm -f "$headers_file"
    exit 1
  fi
  sleep 0.05
done
trace_phase initialized

session_id="$(awk -F ': *' 'tolower($1) == "mcp-session-id" { gsub("\\r", "", $2); print $2; exit }' "$headers_file")"
rm -f "$headers_file"
if [[ -n "$session_id" ]]; then
  curl -fsS -X DELETE --config "$CURL_AUTH_CONFIG" -H "Mcp-Session-Id: $session_id" \
    "http://127.0.0.1:${LISTEN##*:}/mcp" >/dev/null
fi
trace_phase session_deleted

if [[ -n "$DEPLOYMENT_KEY" ]]; then
  printf '%s\n' "$DEPLOYMENT_KEY" > "$INSTALL_DIR/deployment-key.next"
  chmod 600 "$INSTALL_DIR/deployment-key.next"
  mv -f "$INSTALL_DIR/deployment-key.next" "$INSTALL_DIR/deployment-key"
fi
trace_phase deployment_key_written

echo "installed codex-remote-mcp-server"
echo "listen: $LISTEN"
echo "root: $WORKDIR"
echo "binary: $INSTALL_DIR/codex-remote-mcp-server"
echo "pid: $server_pid"
echo "log: $LOG_DIR/server.log"
echo "service-mode: $effective_service_mode"
