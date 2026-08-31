# Self-hosted SSH first connection

Use this workflow when the user provides an SSH command or host, port, user,
and a one-time password for an ordinary Linux server.

## Prerequisites

The local machine needs Node.js 20 or newer, Bash, OpenSSH (`ssh`,
`ssh-keygen`, `ssh-keyscan`, `ssh-copy-id`, and `scp`), and `shasum`. The remote
machine needs Linux x86_64 with glibc 2.17 or newer, `bash`, `curl`,
`sha256sum`, a writable home directory, an SSH daemon that allows public keys,
and the standard GNU/Linux commands `mktemp`, `install`, `date`, `dirname`,
`uname`, `mkdir`, `chmod`, `mv`, `rm`, `cat`, `id`, `ps`, `grep`, `awk`, `sed`,
`nohup`, `seq`, and `sleep`. The bundled artifact does not compile anything
remotely.

## Input contract

Extract only:

- target reference: a short ASCII-safe internal identifier; derive one from the host when omitted;
- display name: a short semantic user-facing name; derive one automatically from
  the user's wording or server role when omitted, and keep the internal reference ASCII-safe;
- host;
- SSH port;
- SSH user;
- optional remote workspace;
- preferably the server host-key fingerprint in OpenSSH `SHA256:...` form.

Treat the password as ephemeral process input. Never place it in an argument,
environment variable, file, `.env`, SSH config, state JSON, skill log, or final
response. Do not repeat it in commentary. Prefer a user-visible native PTY so
the user can type it directly when `ssh-copy-id` asks. If the user instead sends
the password to Codex for live PTY entry, explain that although this onboarding
code does not persist it in its local files or process configuration, the Codex
task/tool transcript remains subject to the product's retention policy. Terminal
echo is controlled by OpenSSH; verify afterward that public-key-only
authentication succeeds.

Never send a password to a host whose identity has not been established. The
script first reuses an existing matching entry from the user's normal
`known_hosts`, or verifies a fingerprint obtained independently from the
server provider. If neither exists, it stops before password entry and prints
the observed fingerprints. Only use `--trust-on-first-use` after telling the
user that this is the same first-connection trust boundary as accepting a new
host key in native SSH; it cannot protect against an active first-connection
MITM.

When the user supplied only host, port, user, and password, state that TOFU
limitation once and proceed immediately with `--trust-on-first-use`; do not stop
for a second confirmation. The user's request to connect already authorizes
that ordinary first-connection SSH trust decision.

## Deterministic workflow

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote"
"$SKILL_DIR/scripts/add-ssh-server.sh" \
  <target-ref> <host> <port> <user> \
  [--name DISPLAY_NAME] [--alias NAME] \
  [--host-key-sha256 SHA256:...] [--trust-on-first-use] \
  [--remote-workdir PATH] [--ssh-alias NAME] [--binary PATH]
```

The script performs all of the following:

1. Establish host identity from an existing pin, an independently verified
   SHA256 fingerprint, or an explicit native-SSH-style TOFU decision.
2. Generate a dedicated ED25519 key.
3. Use the password once to install the public key.
4. Prove strict host-key-checked, passwordless SSH.
5. Verify Linux x86_64 plus required remote commands.
6. Reuse one native OpenSSH multiplexed connection for the remaining probe,
   upload, install, and private tunnel setup.
7. Register `kind=ssh-server` with a private local tunnel endpoint and create
   its Bearer token.
8. Upload the bundled glibc 2.17-compatible server and installer.
9. Verify SHA256, atomically install under the remote user's owner-only
   `$HOME/.local/share/codex-remote-mcp`, and bind only `127.0.0.1:7890`.
10. Start a supervised native OpenSSH TCP forward and the local Router.
11. Create an owner-only local Router bearer token and add the authenticated
    `remote` Streamable HTTP MCP entry to the owner-only Codex config.

The generated ED25519 private key is owner-only and has no passphrase so the
tunnel can recover unattended. It carries the full authority of the SSH account;
prefer a dedicated non-root account with least privilege. Theft of that key
grants the same remote shell authority.

`--remote-workdir` changes only the filesystem root exposed by MCP. It never
changes the executable or credential installation directory.

If `127.0.0.1:7891` is already occupied or the Codex config already uses the
name `remote`, choose both values explicitly on the same onboarding command:

```bash
AGENT_REMOTE_MCP_CODEX_NAME=remote_ssh \
AGENT_REMOTE_MCP_LOCAL_LISTEN=127.0.0.1:7895 \
  "$SKILL_DIR/scripts/add-ssh-server.sh" \
  <target-ref> <host> <port> <user> --trust-on-first-use
```

After the first configuration, tell the user that an already-running Codex
conversation may need a new conversation before the `remote` tools appear.

## Acceptance

Use a fresh MCP session and prove:

1. `router_list()` contains the new target's persistent display name without exposing its host.
2. `router_connect(display-name)` returns a stable `rmc_...` machine code.
3. `router_status()` shows exactly one selected target.
4. `pwd()` and one file read/write operation succeed.
5. A second MCP session can connect to the same machine independently.

Do not claim success from SSH login, `/health`, or process status alone.
