#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mergedEnv, routerStatePath } from './env.mjs';
import {
  newManagedInstanceToken,
  stopManagedPidFile,
  writeManagedPidFile,
} from './managed-process.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const supervisorScript = path.join(scriptDirectory, 'ssh-mcp-tunnel-supervisor.mjs');

function selectedRef(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== '--ref' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(argv[1])) {
    throw new Error('usage: start-ssh-server-tunnels.mjs [--ref TARGET_REF]');
  }
  return argv[1];
}

function sanitize(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(-400);
}

function readConfig(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = ['bearerTokenEnv', 'localPort', 'ref', 'remoteInstallDir', 'remoteUrl', 'sshTarget', 'version'];
  if (value.version !== 2 || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error(`invalid SSH tunnel config: ${file}`);
  }
  return value;
}

async function waitForMcp(config, bearerToken, child, logFile) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.localPort}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'ssh-tunnel-manager', version: '1' },
          },
        }),
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok && response.headers.get('mcp-session-id')) {
        const sessionId = response.headers.get('mcp-session-id');
        await fetch(`http://127.0.0.1:${config.localPort}/mcp`, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${bearerToken}`,
            'mcp-session-id': sessionId,
          },
          signal: AbortSignal.timeout(1_500),
        }).catch(() => {});
        return;
      }
    } catch {
      // The tunnel or remote service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = fs.existsSync(logFile) ? sanitize(fs.readFileSync(logFile, 'utf8')) : '';
  throw new Error(`SSH MCP tunnel ${config.ref} failed to start${detail ? `: ${detail}` : ''}`);
}

const env = mergedEnv();
const requestedRef = selectedRef(process.argv.slice(2));
const stateFile = routerStatePath(env);
const stateDirectory = path.dirname(stateFile);
const tunnelDirectory = path.join(stateDirectory, 'ssh-tunnels');
if (!fs.existsSync(tunnelDirectory)) {
  if (requestedRef) throw new Error(`registered SSH tunnel not found: ${requestedRef}`);
  process.exit(0);
}

const configs = fs.readdirSync(tunnelDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ file: path.join(tunnelDirectory, name), config: readConfig(path.join(tunnelDirectory, name)) }))
  .filter(({ config }) => !requestedRef || config.ref === requestedRef);
if (requestedRef && configs.length !== 1) {
  throw new Error(`registered SSH tunnel not found: ${requestedRef}`);
}

for (const { file, config } of configs) {
  const bearerToken = env[config.bearerTokenEnv];
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(bearerToken || '')) {
    throw new Error(`missing SSH remote token environment: ${config.bearerTokenEnv}`);
  }
  const runtimeDirectory = path.join(tunnelDirectory, 'runtime', config.ref);
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const pidFile = path.join(runtimeDirectory, 'supervisor.pid');
  const logFile = path.join(runtimeDirectory, 'supervisor.log');
  const legacyPidFile = path.join(stateDirectory, 'ssh-adapters', 'runtime', config.ref, 'adapter.pid');
  const expectedArguments = (token) => [
    supervisorScript,
    file,
    '--managed-instance', token,
    '--managed-ref', config.ref,
  ];
  // Legacy/plain PID files have no verifiable instance identity. Clearing them
  // is safe; signalling their PID is not.
  await stopManagedPidFile(legacyPidFile, expectedArguments);
  await stopManagedPidFile(pidFile, expectedArguments);
  fs.writeFileSync(logFile, '', { mode: 0o600 });
  const log = fs.openSync(logFile, 'a');
  const instanceToken = newManagedInstanceToken();
  const child = spawn(process.execPath, expectedArguments(instanceToken), {
    detached: true,
    env: { ...process.env, REMOTE_MCP_BEARER_TOKEN: bearerToken },
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  writeManagedPidFile(pidFile, child.pid, instanceToken);
  child.unref();
  try {
    await waitForMcp(config, bearerToken, child, logFile);
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  }
  console.log(`SSH MCP tunnel ${config.ref}: http://127.0.0.1:${config.localPort}/mcp`);
}
