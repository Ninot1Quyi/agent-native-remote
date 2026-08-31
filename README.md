# Agent-Native Remote share package

This is the complete shareable form of the `agent-native-remote` skill. It
contains the local Router, native SSH tunnel supervisor, remote installer,
auditable Rust source, and a checksum-pinned Linux x86_64 prebuilt server. It
contains no author SSH key, host, password, token, cookie, `.env`, log, or
Router state.

The public package supports two target kinds:

- `http-mcp`: connect the Router to an existing HTTP(S) MCP endpoint.
- `ssh-server`: install and supervise the bundled remote MCP server on a
  self-hosted Linux server over OpenSSH.

Give the archive and either an MCP URL or SSH command to Codex. For SSH, the
safest first-login flow is to type the one-time password yourself in the
user-visible native `ssh-copy-id` PTY when Codex opens it. Then say:

> 安装附件里的 `agent-native-remote` skill，并连接我给出的远程目标。
> 首次注册时根据用途自动设置一个简短、可读、持久化的设备名称，
> 以后我可以直接说“连接这个名称”。
> 如果是 SSH 服务器，在可见的原生 `ssh-copy-id` 密码提示中让我输入一次密码；
> 不要把密码写入命令参数、环境变量、文件或 skill 日志。
> 连接后验证完整的远程 MCP 工具。

For convenience, a user may instead send the password to Codex for live PTY
entry. The onboarding code still does not write it to local command arguments,
environment variables, files, or skill logs, but a password placed in a Codex
task or tool interaction remains subject to that Codex product's task/transcript
retention policy. This package cannot promise zero retention outside its own
local files and processes.

Codex should extract the archive so this file becomes
`${CODEX_HOME:-$HOME/.codex}/skills/agent-native-remote/README.md`, read
`SKILL.md`, then execute one of the reference workflows:

- `references/direct-http-mcp.md` for an existing HTTP(S) MCP endpoint.
- `references/self-hosted-ssh.md` for a managed self-hosted Linux server.

For SSH, the first connection must establish the server host identity before
sending the password. An independently obtained OpenSSH `SHA256:...` host-key
fingerprint is preferred; explicit TOFU has the same first-connection limitation
as native SSH.

The onboarding flow stores a user-facing target name separately from its safe
internal reference and opaque machine code. The Router lists that name and
accepts it directly in `router_connect`, without exposing the server address or
endpoint URL in business-tool arguments.

The prebuilt server requires Linux x86_64, glibc 2.17 or newer, `bash`, `curl`,
`sha256sum`, and a standard GNU/Linux coreutils/procps userland. ARM servers can
be supported by building another artifact from the included source and
registering it through `--binary`.

The dedicated passwordless ED25519 key has the same authority as the supplied
SSH account because complete remote MCP includes shell execution. Prefer a
dedicated non-root account with only the privileges the agent needs. Anyone who
steals that private key can use the same SSH account authority.
