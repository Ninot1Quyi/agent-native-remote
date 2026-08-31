use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicI32;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use codex_apply_patch::apply_patch;
use codex_exec_server::CopyOptions;
use codex_exec_server::CreateDirectoryOptions;
use codex_exec_server::Environment;
use codex_exec_server::ExecOutputStream;
use codex_exec_server::ExecParams;
use codex_exec_server::ExecProcess;
use codex_exec_server::ExecutorFileSystem;
use codex_exec_server::ProcessId;
use codex_exec_server::ReadResponse;
use codex_exec_server::RemoveOptions;
use codex_exec_server::StartedExecProcess;
use codex_utils_absolute_path::AbsolutePathBuf;
use constant_time_eq::constant_time_eq_32;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Mutex;

const DEFAULT_LISTEN: &str = "127.0.0.1:7890";
const DEFAULT_SHELL: &str = "/bin/sh";
const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MIN_YIELD_TIME_MS: u64 = 250;
const MIN_EMPTY_YIELD_TIME_MS: u64 = 5_000;
const MAX_YIELD_TIME_MS: u64 = 30_000;
const MAX_EMPTY_YIELD_TIME_MS: u64 = 300_000;
const CODE_MODE_RESULT_META_KEY: &str = "codex/codeModeResult";
const CODE_MODE_RESULT_STRUCTURED_CONTENT: &str = "structuredContent";

mod remote_machine_code;

use remote_machine_code::DEFAULT_MACHINE_CODE_FILE;
use remote_machine_code::load_or_create_machine_code;

type JsonObject = serde_json::Map<String, serde_json::Value>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    name: Cow<'static, str>,
    description: Cow<'static, str>,
    #[serde(rename = "inputSchema")]
    input_schema: serde_json::Value,
    #[serde(rename = "outputSchema")]
    output_schema: serde_json::Value,
    annotations: ToolAnnotations,
    #[serde(rename = "_meta")]
    meta: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolAnnotations {
    read_only_hint: bool,
}

#[derive(Debug)]
struct McpError {
    message: String,
}

impl McpError {
    fn invalid_params(message: impl Into<String>, _data: Option<serde_json::Value>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

#[derive(Clone)]
struct RemoteServer {
    tools: Arc<Vec<Tool>>,
    root: AbsolutePathBuf,
    environment: Arc<Environment>,
    shell: String,
    machine_code: Arc<str>,
    process_namespace: Arc<str>,
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    next_session_id: Arc<AtomicI32>,
}

struct SessionState {
    process: Arc<dyn ExecProcess>,
    after_seq: Option<u64>,
    cmd: String,
    cwd: String,
    pty_as_stdout: bool,
    tty: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    pty: Vec<u8>,
    combined: Vec<u8>,
    stdout_cursor: usize,
    stderr_cursor: usize,
    pty_cursor: usize,
    combined_cursor: usize,
    exited: bool,
    closed: bool,
    exit_code: Option<i32>,
    failure: Option<String>,
}

#[derive(Deserialize)]
struct ExecArgs {
    cmd: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct ExecCommandArgs {
    cmd: String,
    workdir: Option<String>,
    shell: Option<String>,
    login: Option<bool>,
    tty: Option<bool>,
    yield_time_ms: Option<u64>,
    max_output_tokens: Option<usize>,
    sandbox_permissions: Option<String>,
    additional_permissions: Option<serde_json::Value>,
    justification: Option<String>,
    prefix_rule: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecOutput {
    exit_code: Option<i32>,
    timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    running: bool,
    stdout: String,
    stderr: String,
    pty: String,
    cwd: String,
}

#[derive(Serialize)]
struct UnifiedExecOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_id: Option<String>,
    wall_time_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_token_count: Option<usize>,
    output: String,
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
struct ViewImageArgs {
    path: String,
    detail: Option<String>,
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
    create_parent_dirs: Option<bool>,
}

#[derive(Deserialize)]
struct UploadArgs {
    path: String,
    content: Option<String>,
    base64: Option<String>,
    create_parent_dirs: Option<bool>,
}

#[derive(Deserialize)]
struct DownloadArgs {
    path: String,
}

#[derive(Deserialize)]
struct SearchArgs {
    pattern: String,
    path: Option<String>,
    max_results: Option<u64>,
}

#[derive(Deserialize)]
struct CopyArgs {
    from: String,
    to: String,
    recursive: Option<bool>,
}

#[derive(Deserialize)]
struct MoveArgs {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct ChmodArgs {
    path: String,
    mode: String,
    recursive: Option<bool>,
}

#[derive(Deserialize)]
struct RemoveArgs {
    path: String,
    recursive: Option<bool>,
    force: Option<bool>,
}

#[derive(Deserialize)]
struct FindArgs {
    path: Option<String>,
    name: Option<String>,
    max_results: Option<u64>,
}

#[derive(Deserialize)]
struct TailArgs {
    path: String,
    lines: Option<u64>,
}

#[derive(Deserialize)]
struct WhichArgs {
    command: String,
}

#[derive(Deserialize)]
struct LimitArgs {
    max_results: Option<u64>,
}

#[derive(Deserialize)]
struct UploadArchiveArgs {
    path: String,
    base64: String,
}

#[derive(Deserialize)]
struct ExecSessionArgs {
    cmd: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    tty: Option<bool>,
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct ReadSessionArgs {
    session_id: String,
    wait_ms: Option<u64>,
    max_output_bytes: Option<usize>,
}

#[derive(Deserialize)]
struct WriteStdinArgs {
    session_id: serde_json::Value,
    content: Option<String>,
    chars: Option<String>,
    yield_time_ms: Option<u64>,
    max_output_tokens: Option<usize>,
}

#[derive(Deserialize)]
struct KillSessionArgs {
    session_id: String,
}

#[derive(Deserialize)]
struct ApplyPatchArgs {
    patch: String,
    cwd: Option<String>,
}

impl RemoteServer {
    fn new(
        root: AbsolutePathBuf,
        environment: Environment,
        shell: String,
        machine_code: String,
    ) -> Self {
        Self {
            tools: Arc::new(vec![
                tool(
                    "exec_command",
                    "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
                    json!({
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string", "description": "Shell command to execute." },
                            "workdir": { "type": "string", "description": "Optional working directory to run the command in; defaults to the remote workspace root." },
                            "shell": { "type": "string", "description": "Shell binary to launch. Defaults to the configured remote shell." },
                            "tty": { "type": "boolean", "description": "Whether to allocate a TTY for the command. Defaults to false." },
                            "yield_time_ms": { "type": "integer", "minimum": 0, "description": "How long to wait for output before yielding." },
                            "max_output_tokens": { "type": "integer", "minimum": 1, "description": "Maximum number of tokens to return. Excess output is truncated." },
                            "login": { "type": "boolean", "description": "Whether to run the shell with -l/-i semantics. Defaults to true." },
                            "sandbox_permissions": { "type": "string", "description": "Accepted for Codex exec_command compatibility; remote MCP currently runs inside its configured remote root." },
                            "additional_permissions": { "type": "object", "description": "Accepted for Codex exec_command compatibility; remote MCP currently ignores this field." },
                            "justification": { "type": "string", "description": "Accepted for Codex exec_command compatibility when sandbox_permissions is set." },
                            "prefix_rule": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Accepted for Codex exec_command compatibility when sandbox_permissions is set."
                            }
                        },
                        "required": ["cmd"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "exec",
                    "Run a command on the remote machine inside the configured remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string" },
                            "cwd": { "type": "string" },
                            "timeout_ms": { "type": "integer", "minimum": 1 },
                            "max_output_bytes": { "type": "integer", "minimum": 1 },
                            "env": {
                                "type": "object",
                                "additionalProperties": { "type": "string" }
                            }
                        },
                        "required": ["cmd"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "read",
                    "Read a UTF-8 file from the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "write",
                    "Write a UTF-8 file in the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "content": { "type": "string" },
                            "create_parent_dirs": { "type": "boolean" }
                        },
                        "required": ["path", "content"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "list",
                    "List entries in a remote workspace directory.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "stat",
                    "Read metadata for a remote workspace path.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "mkdir",
                    "Create a directory in the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "rm",
                    "Remove a file or directory in the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "recursive": { "type": "boolean" },
                            "force": { "type": "boolean" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "cp",
                    "Copy a file or directory in the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "recursive": { "type": "boolean" }
                        },
                        "required": ["from", "to"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "mv",
                    "Move or rename a file or directory in the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" }
                        },
                        "required": ["from", "to"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "chmod",
                    "Change file mode for a remote workspace path.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "mode": { "type": "string" },
                            "recursive": { "type": "boolean" }
                        },
                        "required": ["path", "mode"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "upload",
                    "Write text or base64 bytes to a remote workspace file.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "content": { "type": "string" },
                            "base64": { "type": "string" },
                            "create_parent_dirs": { "type": "boolean" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "download",
                    "Read bytes from a remote workspace file as base64, with UTF-8 text when possible.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "download_archive",
                    "Download a remote file or directory as a base64 tar.gz archive.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "upload_archive",
                    "Upload a base64 tar.gz archive into a remote workspace directory.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "base64": { "type": "string" }
                        },
                        "required": ["path", "base64"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "view_image",
                    "View a remote image file from the filesystem when visual inspection is needed.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Remote filesystem path to an image file." },
                            "detail": {
                                "type": "string",
                                "enum": ["high", "original"],
                                "description": "Image detail level. Defaults to high; use original to preserve exact resolution."
                            }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "search",
                    "Search remote workspace files with ripgrep.",
                    json!({
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string" },
                            "path": { "type": "string" },
                            "max_results": { "type": "integer", "minimum": 1 }
                        },
                        "required": ["pattern"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "find",
                    "Find remote workspace paths by optional name pattern.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "name": { "type": "string" },
                            "max_results": { "type": "integer", "minimum": 1 }
                        },
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "tail",
                    "Read the last lines from a remote workspace file.",
                    json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "lines": { "type": "integer", "minimum": 1 }
                        },
                        "required": ["path"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "exec_session",
                    "Start a long-running command session on the remote machine.",
                    json!({
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string" },
                            "cwd": { "type": "string" },
                            "env": {
                                "type": "object",
                                "additionalProperties": { "type": "string" }
                            },
                            "tty": { "type": "boolean" },
                            "session_id": { "type": "string" }
                        },
                        "required": ["cmd"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "read_session",
                    "Read incremental stdout, stderr, and pty output from a remote command session.",
                    json!({
                        "type": "object",
                        "properties": {
                            "session_id": { "type": "string" },
                            "wait_ms": { "type": "integer", "minimum": 0 },
                            "max_output_bytes": { "type": "integer", "minimum": 1 }
                        },
                        "required": ["session_id"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "write_stdin",
                    "Writes characters to an existing unified exec session and returns recent output.",
                    json!({
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "integer",
                                "description": "Identifier of the running unified exec session."
                            },
                            "chars": {
                                "type": "string",
                                "description": "Bytes to write to stdin. Defaults to empty, which polls without writing."
                            },
                            "yield_time_ms": {
                                "type": "integer",
                                "minimum": 0,
                                "description": "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default."
                            },
                            "max_output_tokens": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."
                            },
                        },
                        "required": ["session_id"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "kill_session",
                    "Terminate a remote command session.",
                    json!({
                        "type": "object",
                        "properties": {
                            "session_id": { "type": "string" }
                        },
                        "required": ["session_id"],
                        "additionalProperties": false
                    }),
                    false,
                ),
                tool(
                    "sessions",
                    "List active remote command sessions.",
                    json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "health",
                    "Return remote MCP server configuration and basic workspace reachability.",
                    json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "pwd",
                    "Return the configured remote workspace root.",
                    json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "env",
                    "Print the remote process environment.",
                    json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "which",
                    "Resolve a command on the remote PATH.",
                    json!({
                        "type": "object",
                        "properties": {
                            "command": { "type": "string" }
                        },
                        "required": ["command"],
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "process_list",
                    "List remote processes.",
                    json!({
                        "type": "object",
                        "properties": {
                            "max_results": { "type": "integer", "minimum": 1 }
                        },
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "port_list",
                    "List listening remote TCP ports.",
                    json!({
                        "type": "object",
                        "properties": {
                            "max_results": { "type": "integer", "minimum": 1 }
                        },
                        "additionalProperties": false
                    }),
                    true,
                ),
                tool(
                    "apply_patch",
                    "Apply a Codex apply_patch patch inside the remote workspace.",
                    json!({
                        "type": "object",
                        "properties": {
                            "patch": { "type": "string" },
                            "cwd": { "type": "string" }
                        },
                        "required": ["patch"],
                        "additionalProperties": false
                    }),
                    false,
                ),
            ]),
            root,
            environment: Arc::new(environment),
            shell,
            machine_code: Arc::from(machine_code),
            process_namespace: Arc::from("template"),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: Arc::new(AtomicI32::new(1)),
        }
    }

    fn isolated_session(&self, session_id: &str) -> Self {
        Self {
            tools: Arc::clone(&self.tools),
            root: self.root.clone(),
            environment: Arc::clone(&self.environment),
            shell: self.shell.clone(),
            machine_code: Arc::clone(&self.machine_code),
            process_namespace: Arc::from(session_id),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: Arc::new(AtomicI32::new(1)),
        }
    }

    async fn terminate_all_sessions(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session.process)
            .collect::<Vec<_>>();
        for process in sessions {
            let _ = process.terminate().await;
        }
    }

    async fn start_exec_process(&self, params: ExecParams) -> Result<StartedExecProcess, McpError> {
        let backend = self.environment.get_exec_backend();
        tokio::spawn(async move { backend.start(params).await })
            .await
            .map_err(to_mcp_error)?
            .map_err(to_mcp_error)
    }

    async fn exec(&self, args: ExecArgs) -> Result<serde_json::Value, McpError> {
        let cwd = self.resolve_workspace_path(args.cwd.as_deref().unwrap_or("."))?;
        let process_id = ProcessId::new(format!(
            "{}-remote-{}",
            self.process_namespace,
            unique_suffix()
        ));
        let cmd = args.cmd;
        let started = self
            .start_exec_process(ExecParams {
                process_id: process_id.clone(),
                argv: vec![self.shell.clone(), "-c".to_string(), cmd.clone()],
                cwd: cwd.to_path_buf(),
                env: args.env.unwrap_or_default(),
                tty: false,
                arg0: None,
            })
            .await
            .map_err(to_mcp_error)?;

        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(30_000).min(300_000));
        let max_output_bytes = args.max_output_bytes.unwrap_or(256 * 1024);
        let deadline = Instant::now() + timeout;
        let mut after_seq = None;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut pty = Vec::new();
        let mut exit_code = None;
        let mut timed_out = false;

        loop {
            if Instant::now() >= deadline {
                timed_out = true;
                let _ = started.process.terminate().await;
                break;
            }

            let remaining =
                max_output_bytes.saturating_sub(stdout.len() + stderr.len() + pty.len());
            let response = started
                .process
                .read(after_seq, Some(remaining.max(1)), Some(100))
                .await
                .map_err(to_mcp_error)?;
            for chunk in response.chunks {
                after_seq = Some(chunk.seq);
                match chunk.stream {
                    ExecOutputStream::Stdout => stdout.extend(chunk.chunk.into_inner()),
                    ExecOutputStream::Stderr => stderr.extend(chunk.chunk.into_inner()),
                    ExecOutputStream::Pty => pty.extend(chunk.chunk.into_inner()),
                }
            }

            if response.exit_code.is_some() {
                exit_code = response.exit_code;
            }
            if response.closed {
                break;
            }

            if remaining == 0 {
                break;
            }
        }

        Ok(json!(ExecOutput {
            exit_code,
            timed_out,
            session_id: None,
            running: false,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            pty: String::from_utf8_lossy(&pty).into_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
        }))
    }

    async fn exec_command(&self, args: ExecCommandArgs) -> Result<serde_json::Value, McpError> {
        let cwd = self.resolve_workspace_path(args.workdir.as_deref().unwrap_or("."))?;
        let shell = args.shell.unwrap_or_else(|| self.shell.clone());
        let shell_arg = if args.login.unwrap_or(true) {
            "-lc"
        } else {
            "-c"
        };
        let ExecCommandArgs {
            cmd,
            tty,
            yield_time_ms,
            max_output_tokens,
            sandbox_permissions: _sandbox_permissions,
            additional_permissions: _additional_permissions,
            justification: _justification,
            prefix_rule: _prefix_rule,
            ..
        } = args;
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let session_key = session_id.to_string();
        let process_id = ProcessId::new(format!("{}-{session_id}", self.process_namespace));
        let requested_tty = tty.unwrap_or(false);
        let started_at = Instant::now();
        let started = self
            .start_exec_process(ExecParams {
                process_id: process_id.clone(),
                argv: vec![shell, shell_arg.to_string(), cmd.clone()],
                cwd: cwd.to_path_buf(),
                env: HashMap::new(),
                tty: requested_tty,
                arg0: None,
            })
            .await
            .map_err(to_mcp_error)?;

        let wait_ms = yield_time_ms
            .unwrap_or(10_000)
            .clamp(MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
        let max_bytes = max_output_tokens
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
            .saturating_mul(4)
            .min(MAX_OUTPUT_BYTES);
        let mut output = Vec::new();
        let mut after_seq = None;
        let mut exit_code = None;
        let mut exited = false;
        let mut closed = false;
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        while Instant::now() < deadline {
            let remaining = max_bytes.saturating_sub(output.len());
            let response = started
                .process
                .read(after_seq, Some(remaining.max(1)), Some(100))
                .await
                .map_err(to_mcp_error)?;
            for chunk in response.chunks {
                after_seq = Some(chunk.seq);
                let bytes = chunk.chunk.into_inner();
                output.extend_from_slice(&bytes);
            }
            if response.exit_code.is_some() {
                exit_code = response.exit_code;
            }
            exited |= response.exited;
            closed |= response.closed;
            if closed {
                break;
            }
            if remaining == 0 {
                break;
            }
        }

        let response_session_id = if closed {
            None
        } else {
            let process = Arc::clone(&started.process);
            self.sessions.lock().await.insert(
                session_key.clone(),
                SessionState {
                    process: Arc::clone(&process),
                    after_seq,
                    cmd,
                    cwd: cwd.to_string_lossy().into_owned(),
                    pty_as_stdout: !requested_tty,
                    tty: requested_tty,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    pty: Vec::new(),
                    combined: Vec::new(),
                    stdout_cursor: 0,
                    stderr_cursor: 0,
                    pty_cursor: 0,
                    combined_cursor: 0,
                    exited,
                    closed: false,
                    exit_code,
                    failure: None,
                },
            );
            self.spawn_session_drain(session_key, process, after_seq);
            Some(session_id)
        };

        let output = String::from_utf8_lossy(&output).into_owned();
        let original_token_count = approx_token_count(&output);
        Ok(json!(UnifiedExecOutput {
            chunk_id: Some(unique_suffix()),
            wall_time_seconds: started_at.elapsed().as_secs_f64(),
            exit_code: closed.then_some(exit_code).flatten(),
            session_id: response_session_id,
            original_token_count: Some(original_token_count),
            output,
        }))
    }

    async fn read(&self, path: &str) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(path)?;
        let content = self
            .filesystem()
            .read_file_text(&path)
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "content": content,
        }))
    }

    async fn write(&self, args: WriteArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let fs = self.filesystem();
        if args.create_parent_dirs.unwrap_or(true)
            && let Some(parent) = path.parent()
        {
            fs.create_directory(&parent, CreateDirectoryOptions { recursive: true })
                .await
                .map_err(to_mcp_error)?;
        }
        fs.write_file(&path, args.content.into_bytes())
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "written": true,
        }))
    }

    async fn list(&self, path: &str) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(path)?;
        let entries = self
            .filesystem()
            .read_directory(&path)
            .await
            .map_err(to_mcp_error)?
            .into_iter()
            .map(|entry| {
                json!({
                    "fileName": entry.file_name,
                    "isDirectory": entry.is_directory,
                    "isFile": entry.is_file,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "path": path.to_string_lossy(),
            "entries": entries,
        }))
    }

    async fn stat(&self, path: &str) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(path)?;
        let metadata = self
            .filesystem()
            .get_metadata(&path)
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "isDirectory": metadata.is_directory,
            "isFile": metadata.is_file,
            "createdAtMs": metadata.created_at_ms,
            "modifiedAtMs": metadata.modified_at_ms,
        }))
    }

    async fn mkdir(&self, path: &str) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(path)?;
        self.filesystem()
            .create_directory(&path, CreateDirectoryOptions { recursive: true })
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "created": true,
        }))
    }

    async fn remove(&self, args: RemoveArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        self.filesystem()
            .remove(
                &path,
                RemoveOptions {
                    recursive: args.recursive.unwrap_or(false),
                    force: args.force.unwrap_or(false),
                },
            )
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "removed": true,
        }))
    }

    async fn copy(&self, args: CopyArgs) -> Result<serde_json::Value, McpError> {
        let from = self.resolve_workspace_path(&args.from)?;
        let to = self.resolve_workspace_path(&args.to)?;
        self.filesystem()
            .copy(
                &from,
                &to,
                CopyOptions {
                    recursive: args.recursive.unwrap_or(false),
                },
            )
            .await
            .map_err(to_mcp_error)?;
        Ok(json!({
            "from": from.to_string_lossy(),
            "to": to.to_string_lossy(),
            "copied": true,
        }))
    }

    async fn move_path(&self, args: MoveArgs) -> Result<serde_json::Value, McpError> {
        let from = self.resolve_workspace_path(&args.from)?;
        let to = self.resolve_workspace_path(&args.to)?;
        let cmd = format!("mv -- {} {}", quote_path(&from)?, quote_path(&to)?);
        let output = self
            .exec(ExecArgs {
                cmd,
                cwd: None,
                timeout_ms: Some(30_000),
                max_output_bytes: Some(256 * 1024),
                env: None,
            })
            .await?;
        Ok(json!({
            "from": from.to_string_lossy(),
            "to": to.to_string_lossy(),
            "output": output,
        }))
    }

    async fn chmod(&self, args: ChmodArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let recursive = if args.recursive.unwrap_or(false) {
            "-R "
        } else {
            ""
        };
        let mode = shlex::try_quote(&args.mode).map_err(to_mcp_error)?;
        let cmd = format!("chmod {recursive}{mode} {}", quote_path(&path)?);
        let output = self
            .exec(ExecArgs {
                cmd,
                cwd: None,
                timeout_ms: Some(30_000),
                max_output_bytes: Some(256 * 1024),
                env: None,
            })
            .await?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "mode": args.mode,
            "output": output,
        }))
    }

    async fn upload(&self, args: UploadArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let bytes = match (args.content, args.base64) {
            (Some(content), None) => content.into_bytes(),
            (None, Some(encoded)) => BASE64_STANDARD.decode(encoded).map_err(to_mcp_error)?,
            (Some(_), Some(_)) => {
                return Err(McpError::invalid_params(
                    "upload accepts either content or base64, not both".to_string(),
                    None,
                ));
            }
            (None, None) => {
                return Err(McpError::invalid_params(
                    "upload requires content or base64".to_string(),
                    None,
                ));
            }
        };
        let byte_len = bytes.len();
        let fs = self.filesystem();
        if args.create_parent_dirs.unwrap_or(true)
            && let Some(parent) = path.parent()
        {
            fs.create_directory(&parent, CreateDirectoryOptions { recursive: true })
                .await
                .map_err(to_mcp_error)?;
        }
        fs.write_file(&path, bytes).await.map_err(to_mcp_error)?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "bytes": byte_len,
            "uploaded": true,
        }))
    }

    async fn download(&self, args: DownloadArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let bytes = self
            .filesystem()
            .read_file(&path)
            .await
            .map_err(to_mcp_error)?;
        let content = String::from_utf8(bytes.clone()).ok();
        Ok(json!({
            "path": path.to_string_lossy(),
            "bytes": bytes.len(),
            "content": content,
            "base64": BASE64_STANDARD.encode(bytes),
        }))
    }

    async fn download_archive(&self, args: DownloadArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let path_ref = path.as_path();
        let parent = path_ref
            .parent()
            .ok_or_else(|| McpError::invalid_params("archive path has no parent", None))?;
        let name = path_ref
            .file_name()
            .ok_or_else(|| McpError::invalid_params("archive path has no file name", None))?
            .to_string_lossy();
        let cmd = format!(
            "tar -C {} -czf - {} | base64 | tr -d '\\n'",
            shlex::try_quote(&parent.to_string_lossy()).map_err(to_mcp_error)?,
            shlex::try_quote(&name).map_err(to_mcp_error)?
        );
        let output = self
            .exec(ExecArgs {
                cmd,
                cwd: None,
                timeout_ms: Some(120_000),
                max_output_bytes: Some(64 * 1024 * 1024),
                env: None,
            })
            .await?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "archiveBase64": output["stdout"],
            "output": output,
        }))
    }

    async fn upload_archive(&self, args: UploadArchiveArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let bytes = BASE64_STANDARD.decode(args.base64).map_err(to_mcp_error)?;
        let temp = self
            .root
            .join(format!(".remote-upload-{}.tar.gz", unique_suffix()));
        let fs = self.filesystem();
        fs.create_directory(&path, CreateDirectoryOptions { recursive: true })
            .await
            .map_err(to_mcp_error)?;
        fs.write_file(&temp, bytes).await.map_err(to_mcp_error)?;
        let cmd = format!(
            "tar -xzf {} -C {} && rm -f {}",
            quote_path(&temp)?,
            quote_path(&path)?,
            quote_path(&temp)?
        );
        let output = self
            .exec(ExecArgs {
                cmd,
                cwd: None,
                timeout_ms: Some(120_000),
                max_output_bytes: Some(512 * 1024),
                env: None,
            })
            .await?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "output": output,
        }))
    }

    async fn view_image(&self, args: ViewImageArgs) -> Result<serde_json::Value, McpError> {
        let detail = args.detail.unwrap_or_else(|| "high".to_string());
        if detail != "high" && detail != "original" {
            return Err(McpError::invalid_params(
                "detail must be high or original",
                None,
            ));
        }
        let path = self.resolve_workspace_path(&args.path)?;
        let bytes = self
            .filesystem()
            .read_file(&path)
            .await
            .map_err(to_mcp_error)?;
        let mime = match path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        };
        let base64 = BASE64_STANDARD.encode(bytes);
        Ok(json!({
            "image_url": format!("data:{mime};base64,{base64}"),
            "detail": detail,
        }))
    }

    async fn search(&self, args: SearchArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(args.path.as_deref().unwrap_or("."))?;
        let pattern = shlex::try_quote(&args.pattern).map_err(to_mcp_error)?;
        let path_text = path.to_string_lossy();
        let path = shlex::try_quote(&path_text).map_err(to_mcp_error)?;
        let max_results = args.max_results.unwrap_or(200);
        let cmd = format!(
            "if command -v rg >/dev/null 2>&1; then rg --line-number --column --no-heading --color never -- {pattern} {path}; else grep -RIn -- {pattern} {path}; fi | head -n {max_results}"
        );
        self.exec(ExecArgs {
            cmd,
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn find(&self, args: FindArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(args.path.as_deref().unwrap_or("."))?;
        let max_results = args.max_results.unwrap_or(200);
        let mut cmd = format!("find {}", quote_path(&path)?);
        if let Some(name) = args.name {
            cmd.push_str(" -name ");
            cmd.push_str(&shlex::try_quote(&name).map_err(to_mcp_error)?);
        }
        cmd.push_str(&format!(" | head -n {max_results}"));
        self.exec(ExecArgs {
            cmd,
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn tail(&self, args: TailArgs) -> Result<serde_json::Value, McpError> {
        let path = self.resolve_workspace_path(&args.path)?;
        let lines = args.lines.unwrap_or(200);
        let cmd = format!("tail -n {lines} {}", quote_path(&path)?);
        self.exec(ExecArgs {
            cmd,
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn exec_session(&self, args: ExecSessionArgs) -> Result<serde_json::Value, McpError> {
        let cwd = self.resolve_workspace_path(args.cwd.as_deref().unwrap_or("."))?;
        let cmd = args.cmd;
        let session_id = args
            .session_id
            .unwrap_or_else(|| format!("remote-session-{}", unique_suffix()));
        let requested_tty = args.tty.unwrap_or(true);
        let process_id = ProcessId::new(format!("{}-{session_id}", self.process_namespace));
        let started = self
            .start_exec_process(ExecParams {
                process_id,
                argv: vec![self.shell.clone(), "-c".to_string(), cmd.clone()],
                cwd: cwd.to_path_buf(),
                env: args.env.unwrap_or_default(),
                tty: requested_tty,
                arg0: None,
            })
            .await
            .map_err(to_mcp_error)?;

        self.sessions.lock().await.insert(
            session_id.clone(),
            SessionState {
                process: Arc::clone(&started.process),
                after_seq: None,
                cmd,
                cwd: cwd.to_string_lossy().into_owned(),
                pty_as_stdout: !requested_tty,
                tty: requested_tty,
                stdout: Vec::new(),
                stderr: Vec::new(),
                pty: Vec::new(),
                combined: Vec::new(),
                stdout_cursor: 0,
                stderr_cursor: 0,
                pty_cursor: 0,
                combined_cursor: 0,
                exited: false,
                closed: false,
                exit_code: None,
                failure: None,
            },
        );
        self.spawn_session_drain(session_id.clone(), started.process, None);
        Ok(json!({
            "sessionId": session_id,
            "cwd": cwd.to_string_lossy(),
            "started": true,
        }))
    }

    fn spawn_session_drain(
        &self,
        session_id: String,
        process: Arc<dyn ExecProcess>,
        mut after_seq: Option<u64>,
    ) {
        let sessions = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            loop {
                let response = process.read(after_seq, Some(256 * 1024), Some(100)).await;
                let response = match response {
                    Ok(response) => response,
                    Err(error) => {
                        if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                            session.closed = true;
                            session.failure = Some(error.to_string());
                        }
                        break;
                    }
                };

                let done;
                {
                    let mut sessions = sessions.lock().await;
                    let Some(session) = sessions.get_mut(&session_id) else {
                        break;
                    };
                    done = merge_session_read(session, &mut after_seq, response);
                }
                if done {
                    break;
                }
            }
        });
    }

    async fn read_session(&self, args: ReadSessionArgs) -> Result<serde_json::Value, McpError> {
        let wait_ms = args.wait_ms.unwrap_or(100).min(MAX_EMPTY_YIELD_TIME_MS);
        let max_output_bytes = args.max_output_bytes.unwrap_or(256 * 1024);
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            let mut should_remove = false;
            let result = {
                let mut sessions = self.sessions.lock().await;
                let session = sessions.get_mut(&args.session_id).ok_or_else(|| {
                    McpError::invalid_params(format!("unknown session {}", args.session_id), None)
                })?;
                let has_unread = session.stdout_cursor < session.stdout.len()
                    || session.stderr_cursor < session.stderr.len()
                    || session.pty_cursor < session.pty.len()
                    || session.combined_cursor < session.combined.len();
                if has_unread || session.closed || Instant::now() >= deadline {
                    let mut remaining = max_output_bytes;
                    let stdout =
                        take_unread(&session.stdout, &mut session.stdout_cursor, &mut remaining);
                    let stderr =
                        take_unread(&session.stderr, &mut session.stderr_cursor, &mut remaining);
                    let pty = take_unread(&session.pty, &mut session.pty_cursor, &mut remaining);
                    let mut output_remaining = max_output_bytes;
                    let output = take_unread(
                        &session.combined,
                        &mut session.combined_cursor,
                        &mut output_remaining,
                    );
                    let fully_drained = session.stdout_cursor >= session.stdout.len()
                        && session.stderr_cursor >= session.stderr.len()
                        && session.pty_cursor >= session.pty.len()
                        && session.combined_cursor >= session.combined.len();
                    should_remove = session.closed && fully_drained;
                    Some(json!({
                        "sessionId": args.session_id,
                        "stdout": String::from_utf8_lossy(&stdout),
                        "stderr": String::from_utf8_lossy(&stderr),
                        "pty": String::from_utf8_lossy(&pty),
                        "output": String::from_utf8_lossy(&output),
                        "exited": session.exited,
                        "closed": session.closed && fully_drained,
                        "exitCode": session.exit_code,
                        "failure": session.failure,
                    }))
                } else {
                    None
                }
            };
            if let Some(result) = result {
                if should_remove {
                    self.sessions.lock().await.remove(&args.session_id);
                }
                return Ok(result);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn write_stdin(&self, args: WriteStdinArgs) -> Result<serde_json::Value, McpError> {
        let started_at = Instant::now();
        let session_id = session_id_to_string(&args.session_id)?;
        let numeric_session_id = args
            .session_id
            .as_i64()
            .and_then(|value| i32::try_from(value).ok());
        let input = args.content.or(args.chars).unwrap_or_default();
        let is_poll = input.is_empty();
        let (process, tty) = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(&session_id).ok_or_else(|| {
                McpError::invalid_params(format!("unknown session {session_id}"), None)
            })?;
            (Arc::clone(&session.process), session.tty)
        };
        if !is_poll {
            if !tty {
                return Err(McpError::invalid_params(
                    "stdin is closed for non-tty session",
                    None,
                ));
            }
            let response = process
                .write(input.into_bytes())
                .await
                .map_err(to_mcp_error)?;
            if !matches!(response.status, codex_exec_server::WriteStatus::Accepted) {
                return Err(McpError::invalid_params(
                    format!("stdin write was not accepted: {:?}", response.status),
                    None,
                ));
            }
        }
        let requested_wait_ms = args.yield_time_ms.unwrap_or(if is_poll {
            MIN_EMPTY_YIELD_TIME_MS
        } else {
            MIN_YIELD_TIME_MS
        });
        let wait_ms = if is_poll {
            requested_wait_ms.clamp(MIN_EMPTY_YIELD_TIME_MS, MAX_EMPTY_YIELD_TIME_MS)
        } else {
            requested_wait_ms.clamp(MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS)
        };
        let recent = self
            .read_session(ReadSessionArgs {
                session_id: session_id.clone(),
                wait_ms: Some(wait_ms),
                max_output_bytes: Some(
                    args.max_output_tokens
                        .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
                        .saturating_mul(4)
                        .min(MAX_OUTPUT_BYTES),
                ),
            })
            .await?;
        let output = recent
            .get("output")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let exit_code = recent
            .get("exitCode")
            .and_then(serde_json::Value::as_i64)
            .and_then(|value| i32::try_from(value).ok());
        let session_open = recent
            .get("closed")
            .and_then(serde_json::Value::as_bool)
            .map(|closed| !closed)
            .unwrap_or(true);
        Ok(json!(UnifiedExecOutput {
            chunk_id: Some(unique_suffix()),
            wall_time_seconds: started_at.elapsed().as_secs_f64(),
            exit_code: (!session_open).then_some(exit_code).flatten(),
            session_id: session_open.then_some(numeric_session_id).flatten(),
            original_token_count: Some(approx_token_count(&output)),
            output,
        }))
    }

    async fn kill_session(&self, args: KillSessionArgs) -> Result<serde_json::Value, McpError> {
        let process = self.sessions.lock().await.remove(&args.session_id);
        if let Some(session) = process {
            session.process.terminate().await.map_err(to_mcp_error)?;
            Ok(json!({
                "sessionId": args.session_id,
                "killed": true,
            }))
        } else {
            Ok(json!({
                "sessionId": args.session_id,
                "killed": false,
            }))
        }
    }

    async fn sessions(&self) -> Result<serde_json::Value, McpError> {
        let sessions = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(session_id, session)| {
                json!({
                    "sessionId": session_id,
                    "cmd": session.cmd,
                    "cwd": session.cwd,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "sessions": sessions }))
    }

    async fn health(&self) -> Result<serde_json::Value, McpError> {
        let metadata = self
            .filesystem()
            .get_metadata(&self.root)
            .await
            .map_err(to_mcp_error)?;
        Ok(health_result(
            &self.root,
            &self.shell,
            metadata.is_directory,
            &self.machine_code,
        ))
    }

    async fn pwd(&self) -> Result<serde_json::Value, McpError> {
        Ok(json!({ "root": self.root.to_string_lossy() }))
    }

    async fn env(&self) -> Result<serde_json::Value, McpError> {
        self.exec(ExecArgs {
            cmd: "env | sort".to_string(),
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn which(&self, args: WhichArgs) -> Result<serde_json::Value, McpError> {
        let command = shlex::try_quote(&args.command).map_err(to_mcp_error)?;
        self.exec(ExecArgs {
            cmd: format!("command -v {command}"),
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(64 * 1024),
            env: None,
        })
        .await
    }

    async fn process_list(&self, args: LimitArgs) -> Result<serde_json::Value, McpError> {
        let max_results = args.max_results.unwrap_or(200);
        self.exec(ExecArgs {
            cmd: format!("ps -eo pid,ppid,stat,comm,args | head -n {max_results}"),
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn port_list(&self, args: LimitArgs) -> Result<serde_json::Value, McpError> {
        let max_results = args.max_results.unwrap_or(200);
        let cmd = format!(
            "if command -v ss >/dev/null 2>&1; then ss -ltnp; elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN; elif [ -x /usr/sbin/lsof ]; then /usr/sbin/lsof -nP -iTCP -sTCP:LISTEN; elif command -v netstat >/dev/null 2>&1; then netstat -an; elif [ -x /usr/sbin/netstat ]; then /usr/sbin/netstat -an; else true; fi | head -n {max_results}"
        );
        self.exec(ExecArgs {
            cmd,
            cwd: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(512 * 1024),
            env: None,
        })
        .await
    }

    async fn apply_patch(&self, args: ApplyPatchArgs) -> Result<serde_json::Value, McpError> {
        let cwd = self.resolve_workspace_path(args.cwd.as_deref().unwrap_or("."))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let fs = self.filesystem();
        if let Err(error) =
            apply_patch(&args.patch, &cwd, &mut stdout, &mut stderr, fs.as_ref()).await
        {
            let detail = String::from_utf8_lossy(&stderr).trim().to_string();
            let message = if detail.is_empty() {
                error.to_string()
            } else {
                detail
            };
            return Err(McpError::invalid_params(message, None));
        }
        Ok(json!({
            "cwd": cwd.to_string_lossy(),
            "stdout": String::from_utf8_lossy(&stdout),
            "stderr": String::from_utf8_lossy(&stderr),
            "applied": true,
        }))
    }

    fn resolve_workspace_path(&self, value: &str) -> Result<AbsolutePathBuf, McpError> {
        let raw = Path::new(value);
        let resolved = if raw.is_absolute() {
            AbsolutePathBuf::from_absolute_path(raw).map_err(to_mcp_error)?
        } else {
            self.root.join(raw)
        };
        if !resolved.starts_with(self.root.as_path()) {
            return Err(McpError::invalid_params(
                format!(
                    "path {value:?} escapes remote workspace root {}",
                    self.root.display()
                ),
                None,
            ));
        }
        Ok(resolved)
    }

    fn filesystem(&self) -> Arc<dyn ExecutorFileSystem> {
        self.environment.get_filesystem()
    }
}

impl RemoteServer {
    async fn call_tool(
        &self,
        name: &str,
        arguments: Option<JsonObject>,
    ) -> Result<serde_json::Value, McpError> {
        Ok(match name {
            "exec_command" => {
                self.exec_command(parse_args(arguments, "exec_command")?)
                    .await?
            }
            "exec" => self.exec(parse_args(arguments, "exec")?).await?,
            "read" => {
                let args: PathArgs = parse_args(arguments, "read")?;
                self.read(&args.path).await?
            }
            "write" => self.write(parse_args(arguments, "write")?).await?,
            "list" => {
                let args: PathArgs = parse_args(arguments, "list")?;
                self.list(&args.path).await?
            }
            "stat" => {
                let args: PathArgs = parse_args(arguments, "stat")?;
                self.stat(&args.path).await?
            }
            "mkdir" => {
                let args: PathArgs = parse_args(arguments, "mkdir")?;
                self.mkdir(&args.path).await?
            }
            "rm" => self.remove(parse_args(arguments, "rm")?).await?,
            "cp" => self.copy(parse_args(arguments, "cp")?).await?,
            "mv" => self.move_path(parse_args(arguments, "mv")?).await?,
            "chmod" => self.chmod(parse_args(arguments, "chmod")?).await?,
            "upload" => self.upload(parse_args(arguments, "upload")?).await?,
            "download" => self.download(parse_args(arguments, "download")?).await?,
            "download_archive" => {
                self.download_archive(parse_args(arguments, "download_archive")?)
                    .await?
            }
            "upload_archive" => {
                self.upload_archive(parse_args(arguments, "upload_archive")?)
                    .await?
            }
            "view_image" => {
                self.view_image(parse_args(arguments, "view_image")?)
                    .await?
            }
            "search" => self.search(parse_args(arguments, "search")?).await?,
            "find" => self.find(parse_args(arguments, "find")?).await?,
            "tail" => self.tail(parse_args(arguments, "tail")?).await?,
            "exec_session" => {
                self.exec_session(parse_args(arguments, "exec_session")?)
                    .await?
            }
            "read_session" => {
                self.read_session(parse_args(arguments, "read_session")?)
                    .await?
            }
            "write_stdin" => {
                self.write_stdin(parse_args(arguments, "write_stdin")?)
                    .await?
            }
            "kill_session" => {
                self.kill_session(parse_args(arguments, "kill_session")?)
                    .await?
            }
            "sessions" => self.sessions().await?,
            "health" => self.health().await?,
            "pwd" => self.pwd().await?,
            "env" => self.env().await?,
            "which" => self.which(parse_args(arguments, "which")?).await?,
            "process_list" => {
                self.process_list(parse_args(arguments, "process_list")?)
                    .await?
            }
            "port_list" => self.port_list(parse_args(arguments, "port_list")?).await?,
            "apply_patch" => {
                self.apply_patch(parse_args(arguments, "apply_patch")?)
                    .await?
            }
            other => {
                return Err(McpError::invalid_params(
                    format!("unknown remote tool: {other}"),
                    None,
                ));
            }
        })
    }
}

fn tool(
    name: &'static str,
    description: &'static str,
    schema: serde_json::Value,
    read_only: bool,
) -> Tool {
    Tool {
        name: Cow::Borrowed(name),
        description: Cow::Borrowed(description),
        input_schema: schema,
        output_schema: tool_output_schema(name),
        annotations: ToolAnnotations {
            read_only_hint: read_only,
        },
        meta: code_mode_result_meta(),
    }
}

fn code_mode_result_meta() -> serde_json::Value {
    json!({
        CODE_MODE_RESULT_META_KEY: CODE_MODE_RESULT_STRUCTURED_CONTENT,
    })
}

fn unified_exec_output_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "chunk_id": { "type": "string" },
            "wall_time_seconds": { "type": "number" },
            "exit_code": { "type": "integer" },
            "session_id": { "type": "integer" },
            "original_token_count": { "type": "integer" },
            "output": { "type": "string" }
        },
        "required": ["wall_time_seconds", "output"],
        "additionalProperties": false
    })
}

fn exec_output_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "exitCode": { "type": ["integer", "null"] },
            "timedOut": { "type": "boolean" },
            "sessionId": { "type": ["string", "null"] },
            "running": { "type": "boolean" },
            "stdout": { "type": "string" },
            "stderr": { "type": "string" },
            "pty": { "type": "string" },
            "cwd": { "type": "string" }
        },
        "required": ["exitCode", "timedOut", "running", "stdout", "stderr", "pty", "cwd"],
        "additionalProperties": false
    })
}

fn tool_output_schema(name: &str) -> serde_json::Value {
    match name {
        "exec_command" | "write_stdin" => unified_exec_output_schema(),
        "exec" | "search" | "find" | "tail" | "env" | "which" | "process_list" | "port_list" => {
            exec_output_schema()
        }
        "read" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "content": { "type": "string" }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
        "list" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "fileName": { "type": "string" },
                            "isDirectory": { "type": "boolean" },
                            "isFile": { "type": "boolean" }
                        },
                        "required": ["fileName", "isDirectory", "isFile"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["path", "entries"],
            "additionalProperties": false
        }),
        "stat" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "isDirectory": { "type": "boolean" },
                "isFile": { "type": "boolean" },
                "createdAtMs": { "type": ["integer", "null"] },
                "modifiedAtMs": { "type": ["integer", "null"] }
            },
            "required": ["path", "isDirectory", "isFile", "createdAtMs", "modifiedAtMs"],
            "additionalProperties": false
        }),
        "write" => mutation_output_schema("written"),
        "mkdir" => mutation_output_schema("created"),
        "rm" => mutation_output_schema("removed"),
        "cp" => json!({
            "type": "object",
            "properties": {
                "from": { "type": "string" },
                "to": { "type": "string" },
                "copied": { "type": "boolean" }
            },
            "required": ["from", "to", "copied"],
            "additionalProperties": false
        }),
        "mv" => path_pair_exec_output_schema(),
        "chmod" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "mode": { "type": "string" },
                "output": exec_output_schema()
            },
            "required": ["path", "mode", "output"],
            "additionalProperties": false
        }),
        "upload" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "bytes": { "type": "integer" },
                "uploaded": { "type": "boolean" }
            },
            "required": ["path", "bytes", "uploaded"],
            "additionalProperties": false
        }),
        "download" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "bytes": { "type": "integer" },
                "content": { "type": ["string", "null"] },
                "base64": { "type": "string" }
            },
            "required": ["path", "bytes", "content", "base64"],
            "additionalProperties": false
        }),
        "download_archive" => json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "archiveBase64": { "type": "string" },
                "output": exec_output_schema()
            },
            "required": ["path", "archiveBase64", "output"],
            "additionalProperties": false
        }),
        "upload_archive" => path_exec_output_schema(),
        "view_image" => json!({
            "type": "object",
            "properties": {
                "image_url": { "type": "string" },
                "detail": { "type": "string", "enum": ["high", "original"] }
            },
            "required": ["image_url", "detail"],
            "additionalProperties": false
        }),
        "exec_session" => json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string" },
                "cwd": { "type": "string" },
                "started": { "type": "boolean" }
            },
            "required": ["sessionId", "cwd", "started"],
            "additionalProperties": false
        }),
        "read_session" => json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string" },
                "stdout": { "type": "string" },
                "stderr": { "type": "string" },
                "pty": { "type": "string" },
                "output": { "type": "string" },
                "exited": { "type": "boolean" },
                "closed": { "type": "boolean" },
                "exitCode": { "type": ["integer", "null"] },
                "failure": { "type": ["string", "null"] }
            },
            "required": ["sessionId", "stdout", "stderr", "pty", "output", "exited", "closed", "exitCode", "failure"],
            "additionalProperties": false
        }),
        "kill_session" => json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string" },
                "killed": { "type": "boolean" }
            },
            "required": ["sessionId", "killed"],
            "additionalProperties": false
        }),
        "sessions" => json!({
            "type": "object",
            "properties": {
                "sessions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string" },
                            "cmd": { "type": "string" },
                            "cwd": { "type": "string" }
                        },
                        "required": ["sessionId", "cmd", "cwd"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["sessions"],
            "additionalProperties": false
        }),
        "health" => json!({
            "type": "object",
            "properties": {
                "server": { "type": "string" },
                "root": { "type": "string" },
                "shell": { "type": "string" },
                "rootIsDirectory": { "type": "boolean" },
                "machineCode": { "type": "string" }
            },
            "required": ["server", "root", "shell", "rootIsDirectory", "machineCode"],
            "additionalProperties": false
        }),
        "pwd" => json!({
            "type": "object",
            "properties": { "root": { "type": "string" } },
            "required": ["root"],
            "additionalProperties": false
        }),
        "apply_patch" => json!({
            "type": "object",
            "properties": {
                "cwd": { "type": "string" },
                "stdout": { "type": "string" },
                "stderr": { "type": "string" },
                "applied": { "type": "boolean" }
            },
            "required": ["cwd", "stdout", "stderr", "applied"],
            "additionalProperties": false
        }),
        other => panic!("missing output schema for remote tool {other}"),
    }
}

fn mutation_output_schema(result_key: &str) -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            (result_key): { "type": "boolean" }
        },
        "required": ["path", result_key],
        "additionalProperties": false
    })
}

fn path_exec_output_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "output": exec_output_schema()
        },
        "required": ["path", "output"],
        "additionalProperties": false
    })
}

fn path_pair_exec_output_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "from": { "type": "string" },
            "to": { "type": "string" },
            "output": exec_output_schema()
        },
        "required": ["from", "to", "output"],
        "additionalProperties": false
    })
}

fn parse_args<T: for<'de> Deserialize<'de>>(
    arguments: Option<JsonObject>,
    tool_name: &str,
) -> Result<T, McpError> {
    match arguments {
        Some(arguments) => {
            serde_json::from_value(serde_json::Value::Object(arguments.into_iter().collect()))
                .map_err(|err| McpError::invalid_params(err.to_string(), None))
        }
        None => Err(McpError::invalid_params(
            format!("missing arguments for {tool_name} tool"),
            None,
        )),
    }
}

fn to_mcp_error(err: impl std::fmt::Display) -> McpError {
    McpError::invalid_params(err.to_string(), None)
}

fn quote_path(path: &AbsolutePathBuf) -> Result<String, McpError> {
    shlex::try_quote(&path.to_string_lossy())
        .map(Cow::into_owned)
        .map_err(to_mcp_error)
}

fn session_id_to_string(value: &serde_json::Value) -> Result<String, McpError> {
    match value {
        serde_json::Value::String(value) => Ok(value.clone()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        other => Err(McpError::invalid_params(
            format!("session_id must be a string or integer, got {other}"),
            None,
        )),
    }
}

fn unique_suffix() -> String {
    #[expect(clippy::expect_used)]
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_nanos();
    nanos.to_string()
}

fn merge_session_read(
    session: &mut SessionState,
    after_seq: &mut Option<u64>,
    response: ReadResponse,
) -> bool {
    for chunk in response.chunks {
        *after_seq = Some(chunk.seq);
        let bytes = chunk.chunk.into_inner();
        session.combined.extend_from_slice(&bytes);
        match chunk.stream {
            ExecOutputStream::Stdout => session.stdout.extend_from_slice(&bytes),
            ExecOutputStream::Stderr => session.stderr.extend_from_slice(&bytes),
            ExecOutputStream::Pty if session.pty_as_stdout => {
                session.stdout.extend_from_slice(&bytes)
            }
            ExecOutputStream::Pty => session.pty.extend_from_slice(&bytes),
        }
    }
    session.after_seq = *after_seq;
    session.exited |= response.exited;
    session.closed |= response.closed;
    if response.exit_code.is_some() {
        session.exit_code = response.exit_code;
    }
    if let Some(failure) = response.failure {
        session.failure = Some(failure);
        session.closed = true;
    }
    session.closed
}

fn take_unread(buffer: &[u8], cursor: &mut usize, remaining: &mut usize) -> Vec<u8> {
    if *remaining == 0 || *cursor >= buffer.len() {
        return Vec::new();
    }
    let end = (*cursor + *remaining).min(buffer.len());
    let output = buffer[*cursor..end].to_vec();
    *remaining -= output.len();
    *cursor = end;
    output
}

fn approx_token_count(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn health_result(
    root: &AbsolutePathBuf,
    shell: &str,
    root_is_directory: bool,
    machine_code: &str,
) -> serde_json::Value {
    json!({
        "server": "remote",
        "root": root.to_string_lossy(),
        "shell": shell,
        "rootIsDirectory": root_is_directory,
        "machineCode": machine_code,
    })
}

fn initialize_result(machine_code: &str) -> serde_json::Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "remote",
            "title": "Remote Codex Tools",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Generic remote MCP tools backed by Codex exec-server primitives.",
            "machineCode": machine_code,
        }
    })
}

#[derive(Clone)]
struct RemoteMcpState {
    template: RemoteServer,
    sessions: Arc<Mutex<HashMap<String, RemoteServer>>>,
    bearer_token_sha256: [u8; 32],
}

fn main() -> anyhow::Result<()> {
    let args = RuntimeArgs::parse(std::env::args().skip(1))?;
    let root = AbsolutePathBuf::from_absolute_path(&args.root)?;
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?,
    );
    let environment = runtime.block_on(Environment::create(/*exec_server_url*/ None))?;
    let machine_code = load_or_create_machine_code(&args.machine_code_file)?;
    let bearer_token_sha256 = load_bearer_token_digest(&args.bearer_token_file)?;
    let state = RemoteMcpState {
        template: RemoteServer::new(root.clone(), environment, args.shell, machine_code),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        bearer_token_sha256,
    };
    let listener = tiny_http::Server::http(&args.listen)
        .map_err(|err| anyhow::anyhow!("failed to listen on {}: {err}", args.listen))?;
    eprintln!(
        "remote MCP listening on http://{}/mcp with root {}",
        args.listen,
        root.display()
    );
    for request in listener.incoming_requests() {
        let runtime = Arc::clone(&runtime);
        let state = state.clone();
        std::thread::spawn(move || {
            respond_to_request(&runtime, state, request);
        });
    }
    Ok(())
}

fn respond_to_request(
    runtime: &Arc<tokio::runtime::Runtime>,
    state: RemoteMcpState,
    mut request: tiny_http::Request,
) {
    let result = (|| -> anyhow::Result<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
        if request.url() != "/mcp" {
            return Ok(json_response(
                404,
                json!({ "error": "not found", "path": request.url() }),
            ));
        }
        if !has_valid_bearer_token(&request, &state.bearer_token_sha256) {
            return Ok(unauthorized_response());
        }
        let session_id = request_header(&request, "Mcp-Session-Id");
        if request.method() == &tiny_http::Method::Delete {
            let Some(session_id) = session_id else {
                return Ok(json_response(
                    404,
                    json!({ "error": "unknown or missing Mcp-Session-Id" }),
                ));
            };
            let removed =
                runtime.block_on(async { state.sessions.lock().await.remove(&session_id) });
            let Some(server) = removed else {
                return Ok(json_response(
                    404,
                    json!({ "error": "unknown or missing Mcp-Session-Id" }),
                ));
            };
            runtime.block_on(server.terminate_all_sessions());
            return Ok(tiny_http::Response::from_data(Vec::new()).with_status_code(204));
        }
        if request.method() != &tiny_http::Method::Post {
            return Ok(json_response(405, json!({ "error": "method not allowed" })));
        }
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body)?;
        let method = rpc_method(&body)?;
        if method == "initialize" {
            if session_id.is_some() {
                return Ok(json_response(
                    400,
                    json!({ "error": "initialize must not reuse Mcp-Session-Id" }),
                ));
            }
            let session_id = format!("mcp-{}", unique_suffix());
            let server = state.template.isolated_session(&session_id);
            let response = runtime.block_on(handle_rpc(server.clone(), body))?;
            runtime.block_on(async {
                state
                    .sessions
                    .lock()
                    .await
                    .insert(session_id.clone(), server);
            });
            Ok(with_session_header(
                json_response(200, response),
                &session_id,
            ))
        } else {
            let Some(session_id) = session_id else {
                return Ok(json_response(
                    404,
                    rpc_error(
                        serde_json::Value::Null,
                        -32001,
                        "unknown or missing Mcp-Session-Id".to_string(),
                    ),
                ));
            };
            let server =
                runtime.block_on(async { state.sessions.lock().await.get(&session_id).cloned() });
            let Some(server) = server else {
                return Ok(json_response(
                    404,
                    rpc_error(
                        serde_json::Value::Null,
                        -32001,
                        "unknown or missing Mcp-Session-Id".to_string(),
                    ),
                ));
            };
            if is_rpc_notification(&body)? {
                Ok(with_session_header(
                    tiny_http::Response::from_data(Vec::new()).with_status_code(202),
                    &session_id,
                ))
            } else {
                let response = runtime.block_on(handle_rpc(server, body))?;
                Ok(with_session_header(
                    json_response(200, response),
                    &session_id,
                ))
            }
        }
    })();

    let response = match result {
        Ok(response) => response,
        Err(err) => json_response(500, json!({ "error": err.to_string() })),
    };
    let _ = request.respond(response);
}

fn request_header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn load_bearer_token_digest(path: &Path) -> anyhow::Result<[u8; 32]> {
    if !path.is_absolute() {
        anyhow::bail!("REMOTE_MCP_BEARER_TOKEN_FILE must be an absolute path");
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        anyhow::bail!("remote MCP bearer token must be a regular non-symlink file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            anyhow::bail!("remote MCP bearer token file must not be accessible by group or others");
        }
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.len() > 514 {
        anyhow::bail!("remote MCP bearer token file is too large");
    }
    let token = raw
        .strip_suffix("\r\n")
        .or_else(|| raw.strip_suffix('\n'))
        .unwrap_or(&raw);
    if token.len() < 32
        || token.len() > 512
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        anyhow::bail!("remote MCP bearer token must be 32-512 URL-safe ASCII characters");
    }
    Ok(sha256_digest(token.as_bytes()))
}

fn sha256_digest(input: &[u8]) -> [u8; 32] {
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&Sha256::digest(input));
    digest
}

fn has_valid_bearer_values<'a>(
    mut values: impl Iterator<Item = &'a str>,
    expected_sha256: &[u8; 32],
) -> bool {
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let mut parts = value.split_ascii_whitespace();
    let (Some(scheme), Some(token), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return false;
    }
    let actual_sha256 = sha256_digest(token.as_bytes());
    constant_time_eq_32(expected_sha256, &actual_sha256)
}

fn has_valid_bearer_token(request: &tiny_http::Request, expected_sha256: &[u8; 32]) -> bool {
    has_valid_bearer_values(
        request
            .headers()
            .iter()
            .filter(|header| header.field.equiv("Authorization"))
            .map(|header| header.value.as_str()),
        expected_sha256,
    )
}

fn unauthorized_response() -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut response = json_response(401, json!({ "error": "valid bearer token required" }));
    if let Ok(header) = tiny_http::Header::from_bytes(
        b"WWW-Authenticate".as_slice(),
        b"Bearer realm=\"codex-remote-mcp\"".as_slice(),
    ) {
        response.add_header(header);
    }
    response
}

fn with_session_header(
    mut response: tiny_http::Response<std::io::Cursor<Vec<u8>>>,
    session_id: &str,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    if let Ok(header) =
        tiny_http::Header::from_bytes(b"Mcp-Session-Id".as_slice(), session_id.as_bytes())
    {
        response.add_header(header);
    }
    response
}

fn rpc_method(body: &str) -> anyhow::Result<String> {
    let request: serde_json::Value = serde_json::from_str(body)?;
    Ok(request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string())
}

async fn handle_rpc(server: RemoteServer, body: String) -> anyhow::Result<serde_json::Value> {
    let request: serde_json::Value = serde_json::from_str(&body)?;
    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let method = request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => initialize_result(&server.machine_code),
        "tools/list" => json!({
            "tools": &*server.tools,
            "nextCursor": null,
        }),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("tools/call requires params.name"))?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let arguments = match arguments {
                serde_json::Value::Object(arguments) => Some(arguments),
                other => {
                    return Ok(rpc_error(
                        id,
                        -32602,
                        format!("arguments must be object, got {other}"),
                    ));
                }
            };
            let structured_content = match server.call_tool(name, arguments).await {
                Ok(value) => value,
                Err(err) => return Ok(rpc_error(id, -32602, err.to_string())),
            };
            json!({
                "content": [],
                "structuredContent": structured_content,
                "isError": false,
                "_meta": code_mode_result_meta(),
            })
        }
        other => return Ok(rpc_error(id, -32601, format!("unknown method: {other}"))),
    };

    Ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
}

fn is_rpc_notification(body: &str) -> anyhow::Result<bool> {
    let request: serde_json::Value = serde_json::from_str(body)?;
    Ok(request.get("id").is_none_or(serde_json::Value::is_null))
}

fn rpc_error(id: serde_json::Value, code: i64, message: String) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    })
}

fn json_response(
    status: u16,
    value: serde_json::Value,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"serialize\"}".to_vec());
    let mut response = tiny_http::Response::from_data(body).with_status_code(status);
    if let Ok(header) =
        tiny_http::Header::from_bytes(b"Content-Type".as_slice(), b"application/json".as_slice())
    {
        response.add_header(header);
    }
    response
}

struct RuntimeArgs {
    listen: String,
    root: PathBuf,
    shell: String,
    machine_code_file: PathBuf,
    bearer_token_file: PathBuf,
}

impl RuntimeArgs {
    fn parse(args: impl Iterator<Item = String>) -> anyhow::Result<Self> {
        let mut listen =
            std::env::var("REMOTE_MCP_LISTEN").unwrap_or_else(|_| DEFAULT_LISTEN.to_string());
        let mut root = std::env::var_os("REMOTE_ROOT")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("/"));
        let mut shell = std::env::var("REMOTE_SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string());
        let mut machine_code_file = PathBuf::from(
            std::env::var_os("REMOTE_MCP_MACHINE_CODE_FILE")
                .unwrap_or_else(|| DEFAULT_MACHINE_CODE_FILE.into()),
        );
        let mut bearer_token_file =
            std::env::var_os("REMOTE_MCP_BEARER_TOKEN_FILE").map(PathBuf::from);
        let mut args = args.peekable();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => {
                    listen = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--listen requires a value"))?;
                }
                "--root" => {
                    root = PathBuf::from(
                        args.next()
                            .ok_or_else(|| anyhow::anyhow!("--root requires a value"))?,
                    );
                }
                "--shell" => {
                    shell = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--shell requires a value"))?;
                }
                "--machine-code-file" => {
                    machine_code_file =
                        PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--machine-code-file requires a value")
                        })?);
                }
                "--bearer-token-file" => {
                    bearer_token_file =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--bearer-token-file requires a value")
                        })?));
                }
                other => anyhow::bail!("unknown argument: {other}"),
            }
        }
        let bearer_token_file = bearer_token_file.ok_or_else(|| {
            anyhow::anyhow!("REMOTE_MCP_BEARER_TOKEN_FILE or --bearer-token-file is required")
        })?;
        if !bearer_token_file.is_absolute() {
            anyhow::bail!("REMOTE_MCP_BEARER_TOKEN_FILE must be an absolute path");
        }
        Ok(Self {
            listen,
            root,
            shell,
            machine_code_file,
            bearer_token_file,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn health_and_initialize_expose_only_the_opaque_machine_code() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let machine_code = "rmc_0123456789abcdef0123456789abcdef";

        let health = health_result(&root, "/bin/sh", true, machine_code);
        assert_eq!(health["machineCode"], machine_code);
        let initialize = initialize_result(machine_code);
        assert_eq!(initialize["serverInfo"]["machineCode"], machine_code);
        assert_eq!(initialize.to_string().matches(machine_code).count(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn tools_advertise_direct_structured_code_mode_results() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let environment = Environment::create(None).await?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );

        for tool in server.tools.iter() {
            assert!(
                tool.output_schema.is_object(),
                "{} has no output schema",
                tool.name
            );
            assert_eq!(
                tool.meta[CODE_MODE_RESULT_META_KEY], CODE_MODE_RESULT_STRUCTURED_CONTENT,
                "{} has the wrong Code Mode result contract",
                tool.name,
            );
        }
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unified_exec_uses_native_field_names_and_numeric_session_ids() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let environment = Environment::create(None).await?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );

        let started = server
            .exec_command(ExecCommandArgs {
                cmd: "sleep 0.5; printf remote-native-shape".to_string(),
                workdir: None,
                shell: None,
                login: Some(false),
                tty: Some(false),
                yield_time_ms: Some(MIN_YIELD_TIME_MS),
                max_output_tokens: Some(1_000),
                sandbox_permissions: None,
                additional_permissions: None,
                justification: None,
                prefix_rule: None,
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let session_id = started["session_id"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("expected numeric session_id: {started}"))?;
        assert!(started.get("sessionId").is_none());
        assert!(started.get("stdout").is_none());

        let completed = server
            .write_stdin(WriteStdinArgs {
                session_id: json!(session_id),
                content: None,
                chars: Some(String::new()),
                yield_time_ms: Some(5_000),
                max_output_tokens: Some(1_000),
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        assert_eq!(completed["exit_code"], 0, "unexpected result: {completed}");
        assert_eq!(completed["output"], "remote-native-shape");
        assert!(completed.get("session_id").is_none());
        assert!(completed.get("exitCode").is_none());
        Ok(())
    }

    #[test]
    fn bearer_authorization_is_required_unique_and_constant_time_checked() {
        let expected = sha256_digest(b"0123456789abcdef0123456789abcdef");
        assert!(has_valid_bearer_values(
            ["Bearer 0123456789abcdef0123456789abcdef"].into_iter(),
            &expected,
        ));
        assert!(has_valid_bearer_values(
            ["bearer 0123456789abcdef0123456789abcdef"].into_iter(),
            &expected,
        ));
        assert!(!has_valid_bearer_values([].into_iter(), &expected));
        assert!(!has_valid_bearer_values(
            ["Bearer wrong", "Bearer 0123456789abcdef0123456789abcdef"].into_iter(),
            &expected,
        ));
        assert!(!has_valid_bearer_values(
            ["Bearer wrong"].into_iter(),
            &expected
        ));
    }

    #[test]
    #[cfg(unix)]
    fn bearer_token_file_must_be_private_regular_and_valid() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let token_file = temporary_directory.path().join("bearer-token");
        std::fs::write(&token_file, "0123456789abcdef0123456789abcdef\n")?;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600))?;
        assert_eq!(
            load_bearer_token_digest(&token_file)?,
            sha256_digest(b"0123456789abcdef0123456789abcdef")
        );

        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o644))?;
        assert!(load_bearer_token_digest(&token_file).is_err());

        let symlink = temporary_directory.path().join("bearer-token-link");
        std::os::unix::fs::symlink(&token_file, &symlink)?;
        assert!(load_bearer_token_digest(&symlink).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn apply_patch_tool_creates_a_file_below_the_remote_root() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let environment = Environment::create(None).await?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );
        server
            .mkdir("nested")
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        server
            .apply_patch(ApplyPatchArgs {
                patch: "*** Begin Patch\n*** Add File: nested/patched.txt\n+remote patch\n*** End Patch".to_string(),
                cwd: Some(temporary_directory.path().to_string_lossy().into_owned()),
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        assert_eq!(
            std::fs::read_to_string(temporary_directory.path().join("nested/patched.txt"))?,
            "remote patch\n",
        );
        Ok(())
    }

    #[test]
    fn transient_request_thread_does_not_own_non_tty_child() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        );
        let environment = runtime.block_on(Environment::create(None))?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );
        let request_runtime = Arc::clone(&runtime);
        let request_server = server.clone();
        std::thread::spawn(move || -> anyhow::Result<()> {
            request_runtime.block_on(async {
                request_server
                    .exec_session(ExecSessionArgs {
                        cmd: "sleep 0.1; printf survived-request-thread".to_string(),
                        cwd: None,
                        env: None,
                        tty: Some(false),
                        session_id: Some("transient-request".to_string()),
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                Ok(())
            })
        })
        .join()
        .map_err(|_| anyhow::anyhow!("request thread panicked"))??;

        let result = runtime.block_on(async {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stdout = String::new();
            loop {
                let recent = server
                    .read_session(ReadSessionArgs {
                        session_id: "transient-request".to_string(),
                        wait_ms: Some(500),
                        max_output_bytes: Some(64 * 1024),
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                stdout.push_str(recent["stdout"].as_str().unwrap_or_default());
                if recent["closed"] == true {
                    return Ok::<_, anyhow::Error>((stdout, recent["exitCode"].clone()));
                }
                if Instant::now() >= deadline {
                    anyhow::bail!("session did not close: {recent}");
                }
            }
        })?;

        assert_eq!(result.0, "survived-request-thread");
        assert_eq!(result.1, 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_drain_keeps_reading_after_exit_until_streams_close() -> anyhow::Result<()> {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let environment = Environment::create(None).await?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );
        let session_id = "scripted-drain".to_string();
        server
            .exec_session(ExecSessionArgs {
                cmd: "sleep 60".to_string(),
                cwd: None,
                env: None,
                tty: Some(false),
                session_id: Some(session_id.clone()),
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let mut session = server
            .sessions
            .lock()
            .await
            .remove(&session_id)
            .ok_or_else(|| anyhow::anyhow!("missing scripted session"))?;
        let mut after_seq = None;

        let exited: ReadResponse = serde_json::from_value(json!({
            "chunks": [],
            "nextSeq": 2,
            "exited": true,
            "exitCode": 0,
            "closed": false,
            "failure": null,
        }))?;
        assert!(!merge_session_read(&mut session, &mut after_seq, exited));
        assert!(session.exited);
        assert_eq!(session.exit_code, Some(0));
        assert!(session.stdout.is_empty());

        let output: ReadResponse = serde_json::from_value(json!({
            "chunks": [{
                "seq": 2,
                "stream": "stdout",
                "chunk": BASE64_STANDARD.encode(b"pipe-session-ok"),
            }],
            "nextSeq": 3,
            "exited": true,
            "exitCode": 0,
            "closed": false,
            "failure": null,
        }))?;
        assert!(!merge_session_read(&mut session, &mut after_seq, output));
        assert_eq!(session.stdout, b"pipe-session-ok");

        let closed: ReadResponse = serde_json::from_value(json!({
            "chunks": [],
            "nextSeq": 4,
            "exited": true,
            "exitCode": 0,
            "closed": true,
            "failure": null,
        }))?;
        assert!(merge_session_read(&mut session, &mut after_seq, closed));
        assert!(session.closed);
        session.process.terminate().await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quick_non_tty_session_drains_output_before_reporting_completion() -> anyhow::Result<()>
    {
        let temporary_directory = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temporary_directory.path())?;
        let environment = Environment::create(None).await?;
        let server = RemoteServer::new(
            root,
            environment,
            "/bin/sh".to_string(),
            "rmc_0123456789abcdef0123456789abcdef".to_string(),
        );

        for index in 0..25 {
            let session_id = format!("quick-pipe-{index}");
            server
                .exec_session(ExecSessionArgs {
                    cmd: format!("printf quick-pipe-{index}"),
                    cwd: None,
                    env: None,
                    tty: Some(false),
                    session_id: Some(session_id.clone()),
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let result = server
                .read_session(ReadSessionArgs {
                    session_id,
                    wait_ms: Some(2_000),
                    max_output_bytes: Some(64 * 1024),
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;

            assert_eq!(result["exitCode"], 0, "unexpected result: {result}");
            assert_eq!(
                result["stdout"],
                format!("quick-pipe-{index}"),
                "unexpected result: {result}",
            );
            assert_eq!(result["closed"], true, "unexpected result: {result}");
        }
        Ok(())
    }
}
