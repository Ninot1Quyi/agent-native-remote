# Public Migration Notes

## Goal

This copy is a company-neutral remote-control Skill and MCP server bundle. It
keeps the local authentication, route isolation, SSH host verification, and
remote process ownership contracts while removing private platform integrations
and identifiers.

## Supported public targets

- `http-mcp`: an existing HTTP(S) MCP endpoint managed outside this package.
- `ssh-server`: a self-hosted Linux server reached through a verified,
  passwordless OpenSSH alias and an owner-only local TCP tunnel.

## Removed platform integrations

The public package does not discover organization-specific machines, services,
lanes, containers, browser-shell sessions, private CLIs, private domains, or
private credential formats. Those integrations belonged to the original
organization-local package and are intentionally absent here.

## Public naming

- Local Router configuration uses the `AGENT_REMOTE_MCP_*` prefix.
- Persistent local state lives below `~/.codex/state/agent-remote-mcp/`.
- Remote installer and remote-server variables use the `REMOTE_MCP_*` prefix.
- Target kinds are exactly `http-mcp` and `ssh-server`.

The public copy intentionally does not retain aliases for legacy private names:
keeping them would preserve the identifiers this migration is meant to remove.

## Verification gates

1. Generic Router, session-isolation, SSH, installer, and file-transfer tests
   remain green after the migration.
2. Direct HTTP and SSH targets pass registration and Router validation tests.
3. A package-wide audit rejects organization names, private platform terms,
   private host patterns, and old configuration prefixes.
4. Shell and JavaScript syntax checks pass.
5. The prebuilt Linux archive is repackaged with the generic installer and its
   checksum manifest verifies.
6. The share exporter completes from the sanitized copy.
