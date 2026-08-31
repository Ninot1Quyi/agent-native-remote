#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function sanitize(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-500);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readConfig(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = [
    'bearerTokenEnv',
    'localPort',
    'ref',
    'remoteInstallDir',
    'remoteUrl',
    'sshTarget',
    'version',
  ];
  if (value.version !== 2 || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error('invalid SSH tunnel config schema');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.sshTarget) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.bearerTokenEnv) ||
    !Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65_535 ||
    value.remoteUrl !== 'http://127.0.0.1:7890/mcp' ||
    typeof value.remoteInstallDir !== 'string' || !value.remoteInstallDir.startsWith('/') ||
    /[\r\n\0]/.test(value.remoteInstallDir)
  ) {
    throw new Error('invalid SSH tunnel config values');
  }
  return value;
}

function validateToken(value) {
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(value || '')) {
    throw new Error('missing or invalid SSH remote MCP bearer token');
  }
  return value;
}

export function remoteStartCommand(installDir) {
  const directory = shellQuote(installDir);
  return [
    `dir=${directory}`,
    `listen=${shellQuote('127.0.0.1:7890')}`,
    'test -x "$dir/start.sh" || exit 41',
    'if test -s "$dir/service-name" && command -v systemctl >/dev/null 2>&1; then service=$(cat "$dir/service-name"); systemctl restart "$service" >/dev/null 2>&1 && exit 0; fi',
    `managed_pid() { pid=$(cat "$dir/server.pid" 2>/dev/null || true); case "$pid" in ""|*[!0-9]*) return 1;; esac; kill -0 "$pid" 2>/dev/null || return 1; ps -p "$pid" -o stat= 2>/dev/null | grep -Eqv "^[[:space:]]*Z" || return 1; test -r "/proc/$pid/cmdline" || return 1; test "$dir/codex-remote-mcp-server" -ef "/proc/$pid/exe" || return 1; tr "\\000" "\\n" < "/proc/$pid/cmdline" | awk -v expected="$listen" 'previous == "--listen" && $0 == expected { found=1 } { previous=$0 } END { exit(found ? 0 : 1) }'; }`,
    'if managed_pid; then exit 0; fi',
    'rm -f "$dir/server.pid"',
    'lock="$dir/.supervisor-start-lock"',
    'if mkdir "$lock" 2>/dev/null; then trap \"rmdir \\\"$lock\\\" 2>/dev/null || true\" EXIT; if ! managed_pid; then rm -f "$dir/server.pid"; if command -v setsid >/dev/null 2>&1; then nohup setsid "$dir/start.sh" >"$dir/logs/server.log" 2>&1 </dev/null & else nohup "$dir/start.sh" >"$dir/logs/server.log" 2>&1 </dev/null & fi; fi; fi',
  ].join('; ');
}

function ensureRemoteServer(config) {
  const result = spawnSync('/usr/bin/ssh', [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    config.sshTarget,
    remoteStartCommand(config.remoteInstallDir),
  ], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`remote server recovery failed with SSH exit ${result.status ?? 'unknown'}`);
  }
}

async function probe(config, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.localPort}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (response.status === 401) return 'unauthorized';
    return response.status === 405 ? 'ready' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function spawnTunnel(config) {
  return spawn('/usr/bin/ssh', [
    '-N',
    '-T',
    '-L', `127.0.0.1:${config.localPort}:127.0.0.1:7890`,
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    config.sshTarget,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function main() {
  const [configFile, instanceFlag, instanceToken, refFlag, managedRef, ...extraArguments] = process.argv.slice(2);
  if (
    !configFile || !path.isAbsolute(configFile) ||
    instanceFlag !== '--managed-instance' || !/^[a-f0-9]{48}$/.test(instanceToken || '') ||
    refFlag !== '--managed-ref' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(managedRef || '') ||
    extraArguments.length !== 0
  ) {
    throw new Error('usage: ssh-mcp-tunnel-supervisor.mjs <absolute-config-file> --managed-instance <token> --managed-ref <ref>');
  }
  const config = readConfig(configFile);
  if (managedRef !== config.ref) throw new Error('managed SSH tunnel ref does not match its config');
  const token = validateToken(process.env.REMOTE_MCP_BEARER_TOKEN);
  let stopping = false;
  let child = null;
  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  let backoffMs = 100;
  while (!stopping) {
    child = spawnTunnel(config);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16 * 1024);
    });
    child.on('error', (error) => {
      stderr = `${stderr}${error.message}`.slice(-16 * 1024);
    });

    let ready = false;
    for (let attempt = 0; attempt < 30 && child.exitCode === null && !stopping; attempt += 1) {
      const state = await probe(config, token);
      if (state === 'ready') {
        ready = true;
        break;
      }
      if (state === 'unauthorized') {
        throw new Error('remote MCP rejected the configured bearer token');
      }
      if (attempt === 4 || attempt === 14) {
        try {
          ensureRemoteServer(config);
        } catch (error) {
          process.stderr.write(`[ssh-mcp-tunnel-supervisor] ${sanitize(error.message)}\n`);
        }
      }
      await delay(200);
    }

    if (ready) {
      process.stdout.write(`[ssh-mcp-tunnel-supervisor] ${config.ref} ready\n`);
      backoffMs = 100;
      let failedProbes = 0;
      while (!stopping && child.exitCode === null) {
        await delay(2_000);
        const state = await probe(config, token);
        if (state === 'ready') {
          failedProbes = 0;
          continue;
        }
        if (state === 'unauthorized') {
          process.stderr.write('[ssh-mcp-tunnel-supervisor] remote MCP authentication failed\n');
          failedProbes = 0;
          continue;
        }
        failedProbes += 1;
        if (failedProbes >= 2) {
          try {
            ensureRemoteServer(config);
          } catch (error) {
            process.stderr.write(`[ssh-mcp-tunnel-supervisor] ${sanitize(error.message)}\n`);
          }
        }
        if (failedProbes >= 5) child.kill('SIGTERM');
      }
    } else if (child.exitCode === null) {
      child.kill('SIGTERM');
    }

    if (stopping) break;
    if (stderr) {
      process.stderr.write(`[ssh-mcp-tunnel-supervisor] tunnel unavailable: ${sanitize(stderr)}\n`);
    }
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[ssh-mcp-tunnel-supervisor] ${sanitize(error.message)}\n`);
    process.exitCode = 1;
  });
}
