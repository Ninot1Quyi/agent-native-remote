#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: add-ssh-server.sh <ref> <host> <port> <user> [--name DISPLAY_NAME] [--alias NAME] [--binary PATH] [--remote-workdir PATH] [--ssh-alias NAME] [--host-key-sha256 SHA256:...] [--trust-on-first-use]" >&2
  exit 2
fi

REF="$1"
HOST="$2"
PORT="$3"
USER_NAME="$4"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_BINARY="$SKILL_DIR/assets/codex-remote-mcp-server/prebuilt/x86_64-unknown-linux-gnu/codex-remote-mcp-server"
BINARY="${AGENT_REMOTE_MCP_LOCAL_BINARY:-$DEFAULT_BINARY}"
REMOTE_WORKDIR=""
DISPLAY_NAME=""
TARGET_ALIASES=()
TARGET_ALIAS_COUNT=0
SSH_ALIAS="codex-remote-$REF"
HOST_KEY_SHA256="${AGENT_REMOTE_MCP_HOST_KEY_SHA256:-}"
TRUST_ON_FIRST_USE=false

shift 4
while (( $# > 0 )); do
  case "$1" in
    --name|--alias|--binary|--remote-workdir|--ssh-alias|--host-key-sha256)
      (( $# >= 2 )) || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --name) DISPLAY_NAME="$2" ;;
        --alias) TARGET_ALIASES+=("$2"); TARGET_ALIAS_COUNT=$((TARGET_ALIAS_COUNT + 1)) ;;
        --binary) BINARY="$2" ;;
        --remote-workdir) REMOTE_WORKDIR="$2" ;;
        --ssh-alias) SSH_ALIAS="$2" ;;
        --host-key-sha256) HOST_KEY_SHA256="$2" ;;
      esac
      shift 2
      ;;
    --trust-on-first-use)
      TRUST_ON_FIRST_USE=true
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "invalid ref" >&2; exit 2; }
[[ -z "$DISPLAY_NAME" || ( ${#DISPLAY_NAME} -le 128 && "$DISPLAY_NAME" != *$'\n'* && "$DISPLAY_NAME" != *$'\r'* ) ]] \
  || { echo "invalid display name" >&2; exit 2; }
for ((target_alias_index = 0; target_alias_index < TARGET_ALIAS_COUNT; target_alias_index += 1)); do
  target_alias="${TARGET_ALIASES[$target_alias_index]}"
  [[ -n "$target_alias" && ${#target_alias} -le 128 && "$target_alias" != *$'\n'* && "$target_alias" != *$'\r'* ]] \
    || { echo "invalid target alias" >&2; exit 2; }
done
[[ "$SSH_ALIAS" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "invalid SSH alias" >&2; exit 2; }
[[ "$HOST" =~ ^[A-Za-z0-9._:-]+$ && "$HOST" != -* ]] || { echo "invalid SSH host" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { echo "invalid SSH port" >&2; exit 2; }
[[ "$USER_NAME" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$ ]] || { echo "invalid SSH user" >&2; exit 2; }
[[ -z "$REMOTE_WORKDIR" || ( "$REMOTE_WORKDIR" == /* && "$REMOTE_WORKDIR" != *$'\n'* && "$REMOTE_WORKDIR" != *$'\r'* ) ]] \
  || { echo "remote workdir must be an absolute single-line path" >&2; exit 2; }
[[ -z "$HOST_KEY_SHA256" || "$HOST_KEY_SHA256" =~ ^SHA256:[A-Za-z0-9+/]{43}=?$ ]] \
  || { echo "host-key fingerprint must use OpenSSH SHA256:... form" >&2; exit 2; }
[[ -z "$HOST_KEY_SHA256" || "$TRUST_ON_FIRST_USE" == false ]] \
  || { echo "choose either --host-key-sha256 or --trust-on-first-use" >&2; exit 2; }
[[ -x "$BINARY" ]] || { echo "precompiled Linux binary not found: $BINARY" >&2; exit 2; }
for command_name in node ssh ssh-keygen ssh-keyscan ssh-copy-id scp shasum; do
  command -v "$command_name" >/dev/null || { echo "required local command not found: $command_name" >&2; exit 1; }
done

ONBOARD_START_MS=''
trace_phase() {
  [[ "${AGENT_REMOTE_MCP_TIMING:-0}" == 1 ]] || return 0
  local now_ms
  now_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  if [[ -z "$ONBOARD_START_MS" ]]; then ONBOARD_START_MS="$now_ms"; fi
  echo "ssh_onboarding $1=$((now_ms - ONBOARD_START_MS))ms" >&2
}
trace_phase started

SSH_DIR="$HOME/.ssh"
IDENTITY_FILE="$SSH_DIR/${REF}_remote_mcp_ed25519"
KNOWN_HOSTS_FILE="$SSH_DIR/${REF}_remote_mcp_known_hosts"
CONFIG_DIR="$SSH_DIR/codex-remote-mcp.d"
CONTROL_DIR="$SSH_DIR/cm"
CONFIG_FILE="$CONFIG_DIR/$REF.conf"
INCLUDE_LINE='Include ~/.ssh/codex-remote-mcp.d/*.conf'
RETIRED_INCLUDE_LINE='Include ~/.ssh/codex-remote-mcp.d/*'

mkdir -p "$SSH_DIR" "$CONFIG_DIR" "$CONTROL_DIR"
chmod 700 "$SSH_DIR" "$CONFIG_DIR" "$CONTROL_DIR"
for existing_config in "$CONFIG_DIR"/*.conf; do
  [[ -f "$existing_config" && "$existing_config" != "$CONFIG_FILE" ]] || continue
  if awk -v expected="$SSH_ALIAS" '
    tolower($1) == "host" {
      for (i = 2; i <= NF; i += 1) if ($i == expected) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "$existing_config"; then
    echo "SSH alias is already owned by another remote MCP target: $SSH_ALIAS" >&2
    exit 2
  fi
done
if [[ ! -f "$IDENTITY_FILE" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "codex-remote-mcp/$REF" -f "$IDENTITY_FILE"
fi
if [[ ! -f "$IDENTITY_FILE.pub" ]]; then
  ssh-keygen -y -f "$IDENTITY_FILE" > "$IDENTITY_FILE.pub"
fi
chmod 600 "$IDENTITY_FILE"
chmod 644 "$IDENTITY_FILE.pub"

known_hosts_tmp="$(mktemp "$SSH_DIR/.${REF}.known-hosts.XXXXXX")"
host_scan_tmp="$(mktemp "$SSH_DIR/.${REF}.host-scan.XXXXXX")"
host_candidate_tmp="$(mktemp "$SSH_DIR/.${REF}.host-candidate.XXXXXX")"
global_match_tmp="$(mktemp "$SSH_DIR/.${REF}.global-match.XXXXXX")"
config_tmp="$(mktemp "$CONFIG_DIR/.${REF}.config.XXXXXX")"
ssh_config_tmp=''
REMOTE_BOOTSTRAP=''
cleanup() {
  rm -f "$known_hosts_tmp" "$host_scan_tmp" "$host_candidate_tmp" "$global_match_tmp" "$config_tmp"
  [[ -z "$ssh_config_tmp" ]] || rm -f "$ssh_config_tmp"
  if [[ -n "$REMOTE_BOOTSTRAP" ]]; then
    ssh -T -o BatchMode=yes "$SSH_ALIAS" \
      "rm -rf -- $(printf '%q' "$REMOTE_BOOTSTRAP")" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

file_has_fingerprint() {
  ssh-keygen -lf "$1" -E sha256 2>/dev/null | awk '{print $2}' | grep -Fqx -- "$2"
}

KNOWN_HOST_TARGET="$HOST"
if [[ "$PORT" != 22 ]]; then
  KNOWN_HOST_TARGET="[$HOST]:$PORT"
fi

if [[ -s "$KNOWN_HOSTS_FILE" ]]; then
  if [[ -n "$HOST_KEY_SHA256" ]] && ! file_has_fingerprint "$KNOWN_HOSTS_FILE" "$HOST_KEY_SHA256"; then
    echo "the pinned host key does not match --host-key-sha256; refusing to replace it" >&2
    exit 1
  fi
else
  ssh-keyscan -p "$PORT" -T 10 "$HOST" > "$host_scan_tmp" 2>/dev/null
  [[ -s "$host_scan_tmp" ]] || { echo "SSH host-key scan returned no keys" >&2; exit 1; }

  if [[ -n "$HOST_KEY_SHA256" ]]; then
    : > "$known_hosts_tmp"
    while IFS= read -r host_key_line; do
      printf '%s\n' "$host_key_line" > "$host_candidate_tmp"
      if file_has_fingerprint "$host_candidate_tmp" "$HOST_KEY_SHA256"; then
        printf '%s\n' "$host_key_line" >> "$known_hosts_tmp"
      fi
    done < "$host_scan_tmp"
    [[ -s "$known_hosts_tmp" ]] || {
      echo "the server did not present the trusted host-key fingerprint: $HOST_KEY_SHA256" >&2
      exit 1
    }
  elif [[ -s "$HOME/.ssh/known_hosts" ]] && \
    ssh-keygen -F "$KNOWN_HOST_TARGET" -f "$HOME/.ssh/known_hosts" 2>/dev/null \
      | sed '/^#/d; /^[[:space:]]*$/d' > "$global_match_tmp" && [[ -s "$global_match_tmp" ]]; then
    cp "$global_match_tmp" "$known_hosts_tmp"
  elif [[ "$TRUST_ON_FIRST_USE" == true ]]; then
    echo "Warning: accepting the first SSH handshake host key with native OpenSSH TOFU." >&2
    : > "$known_hosts_tmp"
    ssh -p "$PORT" \
      -o "UserKnownHostsFile=$known_hosts_tmp" \
      -o GlobalKnownHostsFile=/dev/null \
      -o StrictHostKeyChecking=accept-new \
      -o BatchMode=yes \
      -o PubkeyAuthentication=no \
      -o PasswordAuthentication=no \
      -o KbdInteractiveAuthentication=no \
      -o ConnectTimeout=10 \
      "$USER_NAME@$HOST" true >/dev/null 2>&1 || true
    [[ -s "$known_hosts_tmp" ]] || {
      echo "native SSH did not record a host key" >&2
      exit 1
    }
  else
    echo "No independently trusted SSH host key is available; the password has not been requested." >&2
    echo "Verify one fingerprint through the server provider, then rerun with --host-key-sha256:" >&2
    ssh-keygen -lf "$host_scan_tmp" -E sha256 >&2
    echo "For standard SSH trust-on-first-use semantics, explicitly pass --trust-on-first-use." >&2
    exit 3
  fi

  mv -f "$known_hosts_tmp" "$KNOWN_HOSTS_FILE"
  chmod 600 "$KNOWN_HOSTS_FILE"
fi

SSH_BASE=(
  -p "$PORT"
  -i "$IDENTITY_FILE"
  -o "UserKnownHostsFile=$KNOWN_HOSTS_FILE"
  -o GlobalKnownHostsFile=/dev/null
  -o StrictHostKeyChecking=yes
  -o IdentitiesOnly=yes
  -o ConnectTimeout=10
)
if ssh "${SSH_BASE[@]}" -o BatchMode=yes -o PasswordAuthentication=no \
  "$USER_NAME@$HOST" true 2>/dev/null; then
  :
else
  echo "Installing the generated SSH public key; enter the server password once." >&2
  ssh-copy-id -i "$IDENTITY_FILE.pub" -p "$PORT" \
    -o "UserKnownHostsFile=$KNOWN_HOSTS_FILE" \
    -o GlobalKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=yes \
    "$USER_NAME@$HOST"
  ssh "${SSH_BASE[@]}" -o BatchMode=yes -o PasswordAuthentication=no \
    "$USER_NAME@$HOST" true
fi
trace_phase public_key_ready

cat > "$config_tmp" <<EOF
Host $SSH_ALIAS
    HostName $HOST
    Port $PORT
    User $USER_NAME
    IdentityFile $IDENTITY_FILE
    UserKnownHostsFile $KNOWN_HOSTS_FILE
    IdentitiesOnly yes
    PreferredAuthentications publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    StrictHostKeyChecking yes
    ControlMaster auto
    ControlPersist 30
    ControlPath $CONTROL_DIR/rmc-%C
EOF
mv -f "$config_tmp" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

SSH_CONFIG="$SSH_DIR/config"
touch "$SSH_CONFIG"
chmod 600 "$SSH_CONFIG"
if grep -Fqx "$RETIRED_INCLUDE_LINE" "$SSH_CONFIG" || ! grep -Fqx "$INCLUDE_LINE" "$SSH_CONFIG"; then
  if [[ ! -f "$SSH_CONFIG.backup-before-remote-mcp" ]]; then
    cp "$SSH_CONFIG" "$SSH_CONFIG.backup-before-remote-mcp"
  fi
  chmod 600 "$SSH_CONFIG.backup-before-remote-mcp"
  ssh_config_tmp="$(mktemp "$SSH_DIR/.config.remote-mcp.XXXXXX")"
  {
    printf '%s\n\n' "$INCLUDE_LINE"
    awk -v current="$INCLUDE_LINE" -v retired="$RETIRED_INCLUDE_LINE" \
      '$0 != current && $0 != retired { print }' "$SSH_CONFIG"
  } > "$ssh_config_tmp"
  mv -f "$ssh_config_tmp" "$SSH_CONFIG"
  chmod 600 "$SSH_CONFIG"
fi
trace_phase ssh_alias_ready
if ! REMOTE_PROBE="$(ssh -T -o BatchMode=yes "$SSH_ALIAS" '
  set -e
  for command_name in bash curl sha256sum mktemp install date dirname uname mkdir chmod mv rm cat id ps grep awk sed nohup seq sleep; do
    command -v "$command_name" >/dev/null || {
      printf "missing required remote command: %s\n" "$command_name" >&2
      exit 1
    }
  done
  case "$HOME" in
    /*) ;;
    *) printf "remote HOME is not absolute\n" >&2; exit 1 ;;
  esac
  case "$HOME" in
    *$'\''\n'\''*|*$'\''\r'\''*) printf "remote HOME is not single-line\n" >&2; exit 1 ;;
  esac
  printf "%s %s\n%s\n" "$(uname -s)" "$(uname -m)" "$HOME"
')"; then
  echo "remote server is missing required Linux userland commands" >&2
  exit 1
fi
[[ "$REMOTE_PROBE" == *$'\n'* ]] || { echo "remote probe returned incomplete output" >&2; exit 1; }
REMOTE_PLATFORM="${REMOTE_PROBE%%$'\n'*}"
REMOTE_PROBE_REST="${REMOTE_PROBE#*$'\n'}"
REMOTE_HOME="$REMOTE_PROBE_REST"
trace_phase remote_probed
[[ "$REMOTE_PLATFORM" == "Linux x86_64" || "$REMOTE_PLATFORM" == "Linux amd64" ]] || {
  echo "bundled binary requires a Linux x86_64 server; detected: $REMOTE_PLATFORM" >&2
  exit 1
}
[[ "$REMOTE_HOME" == /* && "$REMOTE_HOME" != *$'\n'* && "$REMOTE_HOME" != *$'\r'* ]] \
  || { echo "remote HOME must be an absolute single-line path" >&2; exit 1; }
if [[ -z "$REMOTE_WORKDIR" ]]; then
  REMOTE_WORKDIR="$REMOTE_HOME"
fi
REMOTE_INSTALL_DIR="$REMOTE_HOME/.local/share/codex-remote-mcp"
REGISTER_ARGS=("$REF" "$SSH_ALIAS" --remote-install-dir "$REMOTE_INSTALL_DIR")
[[ -z "$DISPLAY_NAME" ]] || REGISTER_ARGS+=(--name "$DISPLAY_NAME")
for ((target_alias_index = 0; target_alias_index < TARGET_ALIAS_COUNT; target_alias_index += 1)); do
  REGISTER_ARGS+=(--alias "${TARGET_ALIASES[$target_alias_index]}")
done
node "$SKILL_DIR/scripts/register-ssh-server.mjs" "${REGISTER_ARGS[@]}"
trace_phase target_registered

TOKEN_ENV="AGENT_REMOTE_MCP_SSH_$(printf '%s' "$REF" | tr '[:lower:].-' '[:upper:]__')_TOKEN"
set -a
# shellcheck disable=SC1090
source "$SKILL_DIR/.env"
set +a
BEARER_TOKEN="${!TOKEN_ENV:-}"
(( ${#BEARER_TOKEN} >= 32 && ${#BEARER_TOKEN} <= 512 )) \
  && [[ "$BEARER_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] || {
  echo "registered SSH remote bearer token is missing or invalid" >&2
  exit 1
}

REMOTE_BOOTSTRAP="$(ssh -T -o BatchMode=yes "$SSH_ALIAS" \
  'umask 077; mktemp -d /tmp/codex-remote-mcp-bootstrap.XXXXXXXXXX')"
[[ "$REMOTE_BOOTSTRAP" =~ ^/tmp/codex-remote-mcp-bootstrap\.[A-Za-z0-9]{8,}$ \
  && "$REMOTE_BOOTSTRAP" != *$'\n'* && "$REMOTE_BOOTSTRAP" != *$'\r'* ]] || {
  echo "remote mktemp returned an unsafe bootstrap path" >&2
  exit 1
}
EXPECTED_SHA="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
scp -q "$BINARY" "$SKILL_DIR/assets/codex-remote-mcp-server/install.sh" \
  "$SSH_ALIAS:$REMOTE_BOOTSTRAP/"
trace_phase payload_uploaded
REMOTE_SCRIPT="set -euo pipefail; umask 077;"
REMOTE_SCRIPT+=" cat > $(printf '%q' "$REMOTE_BOOTSTRAP/bearer-token.next");"
REMOTE_SCRIPT+=" mv -f $(printf '%q' "$REMOTE_BOOTSTRAP/bearer-token.next") $(printf '%q' "$REMOTE_BOOTSTRAP/bearer-token");"
REMOTE_SCRIPT+=" actual_sha=\$(sha256sum $(printf '%q' "$REMOTE_BOOTSTRAP/codex-remote-mcp-server") | awk '{print \$1}');"
REMOTE_SCRIPT+=" [[ \"\$actual_sha\" == $(printf '%q' "$EXPECTED_SHA") ]] || { echo 'remote binary checksum mismatch' >&2; exit 1; };"
REMOTE_SCRIPT+=" cd $(printf '%q' "$REMOTE_BOOTSTRAP"); chmod 700 install.sh codex-remote-mcp-server; env"
REMOTE_SCRIPT+=" $(printf '%q' "REMOTE_MCP_WORKDIR=$REMOTE_WORKDIR")"
REMOTE_SCRIPT+=" $(printf '%q' "REMOTE_MCP_INSTALL_DIR=$REMOTE_INSTALL_DIR")"
REMOTE_SCRIPT+=" REMOTE_MCP_LISTEN=127.0.0.1:7890"
REMOTE_SCRIPT+=" $(printf '%q' "REMOTE_MCP_BEARER_TOKEN_SOURCE=$REMOTE_BOOTSTRAP/bearer-token")"
REMOTE_SCRIPT+=" REMOTE_MCP_SERVICE_MODE=auto"
REMOTE_SCRIPT+=" $(printf '%q' "REMOTE_MCP_SERVICE_NAME=codex-remote-mcp-$REF")"
REMOTE_SCRIPT+=" $(printf '%q' "REMOTE_MCP_DEPLOY_KEY=$EXPECTED_SHA")"
REMOTE_SCRIPT+=" bash install.sh; rm -rf -- $(printf '%q' "$REMOTE_BOOTSTRAP")"
printf '%s\n' "$BEARER_TOKEN" | ssh -T -o BatchMode=yes "$SSH_ALIAS" \
  "bash -c $(printf '%q' "$REMOTE_SCRIPT")"
unset BEARER_TOKEN REMOTE_SCRIPT
REMOTE_BOOTSTRAP=''
trace_phase remote_installed

node "$SKILL_DIR/scripts/configure-codex.mjs"
trace_phase codex_configured
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
trace_phase router_started

echo "SSH server target ready: $REF"
echo "SSH alias: $SSH_ALIAS"
echo "Remote MCP: 127.0.0.1:7890"
echo "Codex Router: 127.0.0.1:7891"
