# Direct HTTP MCP endpoint

Use this workflow when the user provides an existing HTTP(S) MCP endpoint that
is already managed outside this package.

## Prerequisites

The endpoint must be reachable from the local machine and must implement the
MCP Streamable HTTP transport. If the endpoint requires authentication, store
the credential value in the skill's private `.env` file and register only the
environment-variable name in Router state.

## Input contract

Extract only:

- target reference: a short ASCII-safe internal identifier; derive one from the
  endpoint purpose when omitted;
- display name: a short semantic user-facing name;
- MCP endpoint URL;
- optional origin URL for human traceability;
- optional authorization environment-variable name.

Never place bearer tokens, cookies, API keys, passwords, or signed URLs in the
target reference, display name, origin, final response, or business-tool
arguments.

## Deterministic workflow

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote"
"$SKILL_DIR/scripts/register-target.mjs" \
  <target-ref> http-mcp <https-or-http-mcp-url> \
  [--name DISPLAY_NAME] [--origin URL] \
  [--authorization-env NAME] [--alias NAME]
"$SKILL_DIR/scripts/configure-codex.mjs"
"$SKILL_DIR/scripts/start-remote-mcp-proxy.sh"
```

If authentication is required, first add the credential value to the private
skill `.env` with mode `0600`, then pass its variable name through
`--authorization-env`. The registry must store only that variable name.

## Acceptance

Use a fresh MCP session and prove:

1. `router_list()` contains the new target's persistent display name and
   `kind=http-mcp` without exposing credentials.
2. `router_connect(display-name)` returns a stable `rmc_...` machine code.
3. `router_status()` shows exactly one selected target.
4. A safe read-only remote tool, such as `pwd()` or `health()`, succeeds through
   the Router.
5. A second MCP session can connect to the same endpoint independently.

Do not claim success from URL reachability, a local process check, or Router
`/health` alone.
