#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ensureRouterBearerToken,
  mergedEnv,
  routerBearerTokenPath,
  routerStatePath,
} from './env.mjs';
import {
  newManagedInstanceToken,
  stopManagedPidFile,
  writeManagedPidFile,
} from './managed-process.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const routerScript = path.join(scriptDirectory, 'remote-mcp-router.mjs');
const tunnelStarter = path.join(scriptDirectory, 'start-ssh-server-tunnels.mjs');
const env = mergedEnv();
const listen = env.AGENT_REMOTE_MCP_LOCAL_LISTEN || '127.0.0.1:7891';
const match = listen.match(/^127\.0\.0\.1:(\d{1,5})$/);
if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535) {
  throw new Error('AGENT_REMOTE_MCP_LOCAL_LISTEN must use 127.0.0.1 and a valid port');
}
const port = Number(match[1]);
const bearerTokenFile = routerBearerTokenPath(env);
ensureRouterBearerToken(bearerTokenFile);
const runtimeDirectory = path.join(path.dirname(routerStatePath(env)), 'runtime', 'router');
const pidFile = path.join(runtimeDirectory, 'router.pid');
const logFile = path.join(runtimeDirectory, 'router.log');

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health() {
  try {
    const response = await fetch(`http://${listen}/health`, { signal: AbortSignal.timeout(500) });
    const body = await response.json();
    return response.ok && body?.ok === true && body?.name === 'remote-router';
  } catch {
    return false;
  }
}

async function portIsAvailable() {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function stopManagedRouter() {
  const expectedArguments = (token) => [
    routerScript,
    '--managed-instance', token,
    '--managed-listen', listen,
    '--managed-state-file', routerStatePath(env),
  ];
  await stopManagedPidFile(pidFile, expectedArguments);
  const legacyPidFile = path.resolve(scriptDirectory, '..', 'logs', 'agent-remote-mcp-proxy.pid');
  // A legacy plain PID cannot prove process identity, so it is only cleared.
  await stopManagedPidFile(legacyPidFile, expectedArguments);
}

fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
if (process.env.AGENT_REMOTE_MCP_SKIP_SSH_TUNNEL_START !== '1') {
  const tunnelResult = spawnSync(process.execPath, [tunnelStarter], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (tunnelResult.status !== 0) {
    console.warn(
      'Warning: one or more registered SSH MCP tunnels are unavailable; starting the Router for the remaining targets.',
    );
  }
}

await stopManagedRouter();
if (!(await portIsAvailable())) {
  throw new Error(`local Router port ${port} is occupied by a non-Router process`);
}
fs.writeFileSync(logFile, '', { mode: 0o600 });
const log = fs.openSync(logFile, 'a');
const instanceToken = newManagedInstanceToken();
const routerArguments = [
  routerScript,
  '--managed-instance', instanceToken,
  '--managed-listen', listen,
  '--managed-state-file', routerStatePath(env),
];
const child = spawn(process.execPath, routerArguments, {
  detached: true,
  env: {
    ...process.env,
    ...env,
    AGENT_REMOTE_MCP_LOCAL_LISTEN: listen,
    AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: bearerTokenFile,
  },
  stdio: ['ignore', log, log],
});
fs.closeSync(log);
writeManagedPidFile(pidFile, child.pid, instanceToken);
child.unref();

const deadline = Date.now() + 10_000;
while (Date.now() < deadline && processExists(child.pid)) {
  if (await health()) {
    console.log(`Remote MCP Router: http://${listen}/mcp`);
    console.log(`Router log: ${logFile}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const detail = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').replace(/\s+/g, ' ').trim().slice(-500)
  : '';
throw new Error(`Remote MCP Router failed to start${detail ? `: ${detail}` : ''}`);
