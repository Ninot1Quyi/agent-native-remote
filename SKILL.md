---
name: agent-native-remote
description: Use when an AI coding agent must directly operate a remote computer through a local Router and structured MCP tools, including an existing HTTP(S) MCP endpoint or a managed self-hosted Linux server reached over SSH.
---

# Agent-Native Remote

Use this skill when an agent needs structured remote control instead of
terminal-text mediation. Codex connects to one stable local MCP endpoint; target
selection, credentials, tunnel details, and remote endpoints stay inside the
local Router registry.

This public skill supports exactly two target kinds:

- `http-mcp`: an existing HTTP(S) MCP endpoint managed outside this package.
- `ssh-server`: a self-hosted Linux server where this package installs and
  supervises the bundled remote MCP server through OpenSSH.

Resolve this skill directory as
`${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote`; do not hardcode the
original author's home directory.

## Architecture and Ports

- Codex endpoint: `http://127.0.0.1:7891/mcp`.
- A direct `http-mcp` target is any existing HTTP(S) MCP endpoint reachable from
  the local machine. Optional credential values are stored only in the private
  skill `.env`; the Router registry stores credential environment-variable
  names.
- An `ssh-server` target uses a passwordless alias from `~/.ssh/config`. A local
  supervisor holds one direct `ssh -N -T -L` connection from a private loopback
  port to the server-local MCP listener. It uses no tmux, PTY framing, Base64,
  remote curl, or public MCP listener.
- The dedicated SSH alias uses native OpenSSH connection multiplexing with an
  owner-only control socket, so probe, upload, install, recovery, and tunnel
  setup reuse authentication instead of paying for a new TCP/SSH handshake each
  time. This is still only OpenSSH, not a third-party tunnel dependency.
- Codex always talks to the local Router. Individual upstream MCP endpoints and
  private tunnel ports must not be placed in business-tool arguments.
- The Router maps each local MCP session to zero or one remote target. Calling
  `router_connect` again replaces that session's current target. Many local
  sessions may independently connect to the same remote target.

Never put a hostname, server name, port, credential, or other target detail in a
business-tool argument. Those details belong to the local target registry.

## Native Code Mode Contract

The remote server reuses Codex's Rust execution engine, while this skill owns
the MCP and routing adapters around it. Those adapters must preserve the
following contract:

- Every remote tool advertises an `outputSchema` and
  `_meta["codex/codeModeResult"] = "structuredContent"`.
- A compatible Codex build uses that opt-in to return `structuredContent`
  directly from `tools.<name>(...)` in Code Mode. Tools without the marker keep
  the standard MCP `CallToolResult` envelope.
- `exec_command` and `write_stdin` use the same snake_case result fields as the
  native unified-exec tools: `chunk_id`, `wall_time_seconds`, `exit_code`,
  `session_id`, `original_token_count`, and `output`.
- Unified-exec `session_id` values remain integers through the remote server and
  Router. The skill-specific `exec_session` API continues to use opaque string
  handles because it is not a native unified-exec tool.
- Router-owned tools and skill-specific file/process tools also return their
  structured payload directly, but keep their documented custom schemas rather
  than pretending to be native Codex tools that do not exist.

An unmodified Codex build still receives valid MCP results, but its Code Mode
adapter exposes the outer `CallToolResult` object. Rebuild or reload Codex after
changing the opt-in adapter in `codex-rs/tools` or `codex-rs/core`.

## Persistent Local State

The only Router configuration and route-state authority is:

`~/.codex/state/agent-remote-mcp/router-state.json`, or the corresponding path
under `$CODEX_HOME` when it is set.

The file is atomically written with mode `0600` and contains only:

- registered `http-mcp` and `ssh-server` target adapters;
- each target's discovered stable opaque `machineCode`;
- trusted Codex thread route and parent-inheritance records.

Do not persist live upstream MCP session IDs, remote process handles, tmux
handles, or login commands. A Router restart recreates upstream MCP sessions
from the persisted thread route.

This skill's private `.env` is mode `0600`. It stores credential values and
installer/helper metadata, including credential environment variables referenced
by the registry. Never print cookies, tokens, login commands, passwords, or raw
`.env` content. Report only presence, expiry, byte length, validation status,
and sanitized target metadata.

Local Router configuration uses the `AGENT_REMOTE_MCP_*` prefix. Remote
installer and remote-server environment variables use the `REMOTE_MCP_*` prefix.
There is deliberately no legacy single-upstream setting, target JSON setting,
default target, or implicit fallback. A newly initialized root conversation is
unbound until it calls `router_connect`.

## Router Tools

### First-Use and Connection-Recovery Preflight

Run this preflight only on the first use of this skill in the current Codex
session, or when remote MCP access is needed but the Router tools are missing or
a Router call fails because the connection is unavailable. Do not repeat it on
later turns while the tools and connection remain usable.

1. On first use, if the Router tools are visible, call `router_list()` to prove
   the live control surface.
2. If the Router tools are missing, or a Router call fails because the local
   endpoint is unavailable, check `http://127.0.0.1:7891/health` without
   printing any credentials.
3. If health is unavailable, start the Router and its managed tunnels with
   `"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"`, wait for the script to
   finish, and require the health check to succeed.
4. Retry `router_list()`. If the current Codex process still does not expose the
   Router tools after a successful start, state explicitly that the MCP was
   started but this Codex session has not loaded its tools; do not present a
   direct read of `router-state.json` as an MCP result.
5. When a target is requested and the session is unbound, call
   `router_connect(target_ref)` automatically after applying the target-selection
   rules below. When the Router is healthy but the session is merely unbound,
   do not restart it.

The persisted `router-state.json` is the configuration authority, but it is not
a substitute for live `router_list()`, `router_status()`, or remote-command
evidence. Reading it directly is allowed only as a clearly labelled diagnostic
fallback when the current Codex session cannot expose the Router tools.

The Router exposes exactly three control tools:

- `router_list()` lists registered targets, kind, discovered machine code, and
  whether each target is selected for the current session.
- `router_connect(target_ref)` connects or reconnects the current session. The
  value may be a registry reference or discovered machine code.
- `router_status()` shows the current session's one target, generation, and
  inheritance mode.

There is no separate `switch` tool. `router_connect` performs both first
connection and replacement. A subagent inherits its direct parent thread's route
by default; connecting another target detaches only that subagent.
`router_connect("main")` rejoins parent inheritance.

All Router-owned tools use the `router_` prefix. The remote MCP tool contract is
preserved unchanged, including its native `list(path)` file tool.

## Target Names

Every target has three separate identities:

- `ref` is a safe local ASCII identifier used for files and configuration;
- `name` is the persistent user-facing name and may contain Chinese;
- `machineCode` is the opaque remote identity and never changes when the local
  name changes.

On first registration, choose a short semantic name automatically instead of
asking the user when the context is sufficient. Prefer an explicit user name,
then an environment-and-role name such as `build-server`, `production-shell`, or
`personal-vps`. Never derive a name from a credential or expose a full hostname
when a safer semantic label is available. Use an ASCII slug as the internal
`ref`; if the chosen name is already registered, add a concise qualifier instead
of overwriting another target.

`router_list()` returns both `name` and `target_ref`. `router_connect()` accepts
the name, ref, alias, or machine code, so a later request such as "connect the
build server" can be resolved from persistent local state. To rename an existing
target without adding an MCP control tool, run:

```bash
"$SKILL_DIR/scripts/name-target.mjs" <target-ref-or-machine-code> <display-name> \
  [--alias NAME]
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
```

## Register Targets

Register or update a target through the state helper:

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote"
"$SKILL_DIR/scripts/register-target.mjs" \
  <ref> <http-mcp|ssh-server> <upstream> \
  [--name DISPLAY_NAME] [--origin URL] [--authorization-env NAME] \
  [--alias NAME]
```

The registry stores only credential environment-variable names. Put credential
values in the private `.env`, then restart the Router. Use
`references/direct-http-mcp.md` when the user provides an existing HTTP(S) MCP
endpoint.

## Start and Configure Codex

Start the Router and verify only its local process health:

```bash
"$SKILL_DIR/scripts/configure-codex.mjs"
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
curl -fsS http://127.0.0.1:7891/health
```

The native Node launcher attempts every registered SSH tunnel, restarts the
local Router, and writes private PID/log state below `~/.codex/state`. An
unavailable SSH target is reported but does not block healthy direct HTTP
targets or other SSH targets; selecting the unavailable target still fails at
`router_connect`. The launcher does not require tmux. `configure-codex.mjs`
atomically adds the `remote` MCP section, preserves a backup, and refuses to
overwrite a conflicting MCP entry.

`configure-codex.mjs` also creates an owner-only local Router bearer-token file
and writes that token into the owner-only Codex config. Configure Codex with
both local authentication and explicit route-lineage opt-in (the value below is
illustrative; never copy it literally):

```toml
[mcp_servers.remote]
url = "http://127.0.0.1:7891/mcp"
http_headers = { "Authorization" = "Bearer <generated-local-router-token>", "X-Codex-Route-Lineage" = "current" }
```

The Router rejects unauthenticated `/mcp` requests before creating or accessing
a session; `/health` contains only local process health and remains public on
loopback. Codex injects the current thread ID and direct parent thread ID
dynamically. It must remove stale caller-supplied reserved lineage headers. The
Router accepts durable route recovery only when the opt-in marker and a valid
current thread ID are both present.

While running, the Router performs a real upstream MCP health sweep every 30
seconds (`initialize`, `tools/list`, and remote `health`). A target with an
in-flight business call is skipped for that sweep so a probe session cannot
queue behind a long-running operation on the same upstream. A failed SSH tunnel
is restarted automatically after active business calls drain, and stale upstream
sessions are discarded before later calls resume. Logical process-handle
bindings survive a transport-only recovery when the route generation is
unchanged, so a later `read_session`/`write_stdin` continues on its original
upstream MCP session instead of becoming stale or being terminated by recovery.
Handle-free stale sessions are closed. SSH recovery is scoped to the failed
target ref and never restarts unrelated tunnels. Generic network and
authentication failures retain the last identity and retry on the next sweep.
`/health` reports the 30-second interval and aggregate target health without
exposing credentials or target details.

After a Codex reload or in a direct MCP client, prove the real route with
`router_list()`, `router_connect(target_ref=...)`, `router_status()`, and a
remote command such as `pwd`. `/health` alone does not prove a session is
connected.

## Build and Deploy the Remote Binary

The canonical experimental remote-server source is the skill asset:

`$SKILL_DIR/assets/codex-remote-mcp-server/codex-rs`.

The shareable skill includes a stripped Linux x86_64 binary at
`assets/codex-remote-mcp-server/prebuilt/x86_64-unknown-linux-gnu/` and its
`SHA256SUMS`. Ordinary compatible servers use this artifact directly; they do
not compile Rust remotely. The canonical source remains bundled for audit and
building another architecture.

Build `codex-remote-mcp-server` locally for the target Linux ABI. Self-hosted
servers require a glibc 2.17-compatible target; do not use an unversioned
host-glibc link. Optimize the deployment artifact for transfer size with fat
LTO, one codegen unit, `opt-level = "z"`, `panic = "abort"`, and symbol
stripping. Do not run Cargo on the remote server and do not add this experiment
to CI. The deployment artifact contains only the precompiled binary and
`install.sh`.

On a development machine with Rust, Zig, and `cargo-zigbuild`, rebuild and
refresh the bundled checksum with:

```bash
"$SKILL_DIR/scripts/build-prebuilt-linux-x86_64.sh"
```

## Add an Existing HTTP MCP Endpoint

When the user provides an existing MCP URL, read
`references/direct-http-mcp.md` and register it as `kind=http-mcp`. Keep
endpoint credentials in the private `.env`; store only their environment
variable names in Router state.

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote"
"$SKILL_DIR/scripts/register-target.mjs" \
  <target-ref> http-mcp <https-or-http-mcp-url> \
  [--name DISPLAY_NAME] [--origin URL] \
  [--authorization-env NAME] [--alias NAME]
"$SKILL_DIR/scripts/configure-codex.mjs"
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
```

Finish only after `router_list()`, `router_connect()`, `router_status()`, and a
safe read-only remote tool prove the selected endpoint. Do not claim success
from URL reachability or `/health` alone.

## Add a Self-Hosted SSH Server

When the user sends an SSH command plus a password, read
`references/self-hosted-ssh.md` and execute the workflow instead of merely
explaining it. Derive a short target reference when the user omitted one. Never
repeat the password, put it in command arguments or environment variables, or
write it to local files or skill logs. Prefer letting the user type it directly
in a user-visible native `ssh-copy-id` PTY. If the user instead sends it to
Codex, state accurately that the task/tool transcript remains subject to the
Codex product's retention policy; this skill only controls its own local
processes and files.

Establish the SSH host identity before sending a password: reuse an existing
normal `known_hosts` entry, or prefer a SHA256 fingerprint obtained
independently from the server provider. If neither exists, the script stops
before password entry; use `--trust-on-first-use` only after stating that it has
the same first-connection MITM limitation as accepting a new key in native SSH.
When host, port, user, and password are the only supplied identity details,
state that limitation once and proceed with TOFU without asking for a second
confirmation. Run the following command in a PTY and send the password only to
the live `ssh-copy-id` prompt:

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote"
"$SKILL_DIR/scripts/add-ssh-server.sh" \
  <target-ref> <host> <ssh-port> <ssh-user> \
  [--name DISPLAY_NAME] [--alias NAME] \
  [--host-key-sha256 SHA256:...] [--trust-on-first-use]
```

The command verifies or explicitly pins the server host key, generates an
ED25519 identity under `~/.ssh`, asks for the SSH password once to install the
public key, deploys the bundled checksum-verified precompiled binary, registers
`kind=ssh-server`, configures Codex, and starts the native Router plus
supervised SSH TCP tunnel. The onboarding flow does not persist the password in
command arguments, environment variables, local files, or skill logs. The remote
executable and credentials always live under the SSH user's owner-only
`$HOME/.local/share/codex-remote-mcp`; `--remote-workdir` changes only the MCP
filesystem root.

The bundled artifact requires Linux x86_64 plus a standard GNU/Linux
coreutils/procps userland; fail before uploading when the target is
incompatible. ED25519 is preferred over RSA; use RSA only for an old SSH server
that cannot accept ED25519. The passwordless key has the full authority of the
SSH account so the complete MCP can execute shell commands; prefer a dedicated
non-root account with least privilege, and protect the owner-only private key
accordingly.

The recipient's local machine needs Node.js 20 or newer, Bash, OpenSSH
including `ssh-copy-id`, `scp`, and `shasum`. The remote machine needs glibc
2.17 or newer, a writable home directory, and SSH public-key support. These are
the only prerequisites beyond the supplied SSH details and one-time password.

If a passwordless `~/.ssh/config` alias already exists, import it directly:

```bash
"$SKILL_DIR/scripts/register-ssh-server.mjs" \
  <target-ref> <ssh-config-alias>
"$SKILL_DIR/scripts/configure-codex.mjs"
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
```

SSH tunnel metadata is stored under
`~/.codex/state/agent-remote-mcp/ssh-tunnels`; the private key and pinned host
key remain in the standard `~/.ssh` store. The Router state contains only the
local tunnel endpoint and opaque machine code. One OpenSSH connection carries
concurrent native HTTP channels without terminal framing, Base64, or remote
curl. The supervisor reconnects the tunnel and restarts a detached remote
server after failure. On a real systemd host, the installer instead enables a
restart-on-failure boot service. The server MCP stays bound to `127.0.0.1:7890`
and requires the per-target Bearer token held in private local and remote state.

## Remote Session Contract

Every Router local session owns at most one live upstream MCP session. Remote
`initialize` returns a distinct `Mcp-Session-Id`; all later calls require it,
and `DELETE /mcp` terminates only that upstream session and its processes. The
Router virtualizes process handles per local session, so identical caller
handles cannot collide across conversations. Reconnecting invalidates all old
handles and never routes them to either the previous or new target. A
health-monitor transport repair does not change the route generation, so it
preserves both the virtual bindings and their live upstream MCP session;
handle-free sessions may be replaced.

Read-only calls may retry bounded transient `502`, `503`, or `504` failures.
Calls with side effects, `read_session`, session input, cancellation, and
process operations must never be retried automatically. Only an expired upstream
session on a read-only call may be reopened and replayed.

Discovery and cleanup use bounded timeouts. Normal tools use a separate long
timeout, extended by a tool's requested `timeout_ms`, so long commands are not
terminated by the discovery budget.

The remote server provides command execution, session I/O, file operations,
search, upload/download, apply-patch, process/port inspection, `pwd`, `env`,
`which`, and `health`. Prefer native remote file tools for remote files and use
upload helpers only for local-to-remote transfer.

For a local file or directory, prefer `scripts/upload-local-path.mjs`. Bytes
travel through MCP file-transfer helpers rather than shell base64 or heredoc
writes. Do not fall back to shell base64 or heredoc writes after
`upload_archive` exceeds the single-request envelope.

## Share This Skill

Export a clean package from this exact skill:

```bash
"$SKILL_DIR/scripts/export-share-package.sh"
```

The exporter creates `~/Downloads/agent-native-remote-share.tar.gz`, prints its
SHA256, verifies the bundled server checksum, and excludes `.env`, internal
`HANDOFF` notes, logs, SSH keys, known-host files, runtime state, and Apple
metadata. It also normalizes archive ownership metadata to `root/root`, so the
builder account is not disclosed. Share only that archive, never the live skill
directory.

A recipient can give the archive and either an MCP endpoint or SSH
command/password to an agent and say: install the attached `agent-native-remote`
skill and connect this target. The agent must extract it to
`${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote`, then follow
`references/direct-http-mcp.md` or `references/self-hosted-ssh.md`; the
onboarding command configures Codex and starts the Router itself.

## Completion Evidence

Before reporting success, verify all of the following on the actual target:

1. Local Router state lists the target with the correct kind.
2. `router_connect` returns its stable opaque machine code.
3. `router_status` returns the same code and expected route mode.
4. A safe remote `pwd`, `hostname`, or file read proves the selected target.
5. Router restart plus trusted thread lineage restores the route but creates a
   fresh upstream MCP session.
6. Two local sessions may use the same target independently, while one local
   session never controls more than one target at a time.

After connection, finish with a concise user-facing summary naming the selected
target, the verified remote path or host identity, and the next useful remote
action. If the remote surface is unstable or awkward, improve this skill and its
canonical asset rather than introducing a compatibility fallback.
