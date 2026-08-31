#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseEnvFile,
  readRouterState,
  routerStatePath,
  upsertRouterTarget,
  writeEnvFile,
} from './env.mjs';

function usage() {
  return 'usage: register-ssh-server.mjs <ref> <ssh-config-alias> [--name DISPLAY_NAME] [--local-port PORT] [--alias NAME] [--remote-install-dir PATH]\n';
}

function safeRef(value, name) {
  const ref = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
    throw new Error(`${name} must contain only letters, numbers, dot, underscore, and hyphen`);
  }
  return ref;
}

function safeDisplayName(value, option) {
  const name = String(value || '').trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${option} must be 1-128 printable characters`);
  }
  return name;
}

function parsePort(value) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--local-port must be an integer between 1 and 65535');
  }
  return port;
}

function portFromTarget(target) {
  if (!target?.upstream) return null;
  try {
    const url = new URL(target.upstream);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') return null;
    return Number.parseInt(url.port, 10) || null;
  } catch {
    return null;
  }
}

async function portIsAvailable(port) {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort(state, ref, requested) {
  if (requested) {
    const owner = state.targets.find((target) => portFromTarget(target) === requested);
    if (owner && owner.ref !== ref) throw new Error(`local port ${requested} is already registered`);
    if (!owner && !(await portIsAvailable(requested))) {
      throw new Error(`local port ${requested} is already in use`);
    }
    return requested;
  }
  const previous = state.targets.find((target) => target.ref === ref && target.kind === 'ssh-server');
  const previousPort = portFromTarget(previous);
  if (previousPort) return previousPort;
  const reserved = new Set(state.targets.map(portFromTarget).filter(Boolean));
  for (let port = 7892; port <= 7999; port += 1) {
    if (!reserved.has(port) && await portIsAvailable(port)) return port;
  }
  throw new Error('no free local SSH-adapter port is available in 7892-7999');
}

function verifySshAlias(sshTarget) {
  const resolved = spawnSync('/usr/bin/ssh', ['-G', sshTarget], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (resolved.status !== 0) throw new Error(`SSH config alias ${sshTarget} cannot be resolved`);
  const authenticated = spawnSync('/usr/bin/ssh', [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    sshTarget,
    'true',
  ], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (authenticated.status !== 0) {
    throw new Error(`SSH config alias ${sshTarget} is not passwordless or host-key verified`);
  }
}

function resolveRemoteInstallDir(sshTarget, requested) {
  if (requested !== null) {
    if (!requested.startsWith('/') || /[\r\n\0]/.test(requested)) {
      throw new Error('--remote-install-dir must be an absolute path');
    }
    return requested.replace(/\/$/, '');
  }
  const resolved = spawnSync('/usr/bin/ssh', [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    sshTarget,
    'printf %s "$HOME"',
  ], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const home = String(resolved.stdout || '').trim();
  if (resolved.status !== 0 || !home.startsWith('/') || /[\r\n\0]/.test(home)) {
    throw new Error(`cannot resolve the remote home for SSH config alias ${sshTarget}`);
  }
  return `${home.replace(/\/$/, '')}/.local/share/codex-remote-mcp`;
}

const [rawRef, rawSshTarget, ...options] = process.argv.slice(2);
if (!rawRef || !rawSshTarget) {
  process.stderr.write(usage());
  process.exit(2);
}

const ref = safeRef(rawRef, 'ref');
const sshTarget = safeRef(rawSshTarget, 'ssh-config-alias');
let requestedPort = null;
let requestedRemoteInstallDir = null;
let requestedName = null;
const aliases = [];
for (let index = 0; index < options.length; index += 2) {
  const option = options[index];
  const value = options[index + 1];
  if (!value) throw new Error(`missing value for ${option}`);
  if (option === '--name') requestedName = safeDisplayName(value, '--name');
  else if (option === '--local-port') requestedPort = parsePort(value);
  else if (option === '--alias') aliases.push(safeDisplayName(value, '--alias'));
  else if (option === '--remote-install-dir') requestedRemoteInstallDir = value;
  else throw new Error(`unknown option: ${option}`);
}

verifySshAlias(sshTarget);
const remoteInstallDir = resolveRemoteInstallDir(sshTarget, requestedRemoteInstallDir);
const env = parseEnvFile();
const stateFile = routerStatePath(env);
const state = readRouterState(stateFile);
const localPort = await choosePort(state, ref, requestedPort);
const previousTarget = state.targets.find((target) => target.ref === ref);
const targetAliases = aliases.length > 0 ? aliases : previousTarget?.aliases;
const bearerTokenEnv = `AGENT_REMOTE_MCP_SSH_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
const previousToken = env[bearerTokenEnv];
const bearerToken = /^[A-Za-z0-9._~-]{32,512}$/.test(previousToken || '')
  ? previousToken
  : crypto.randomBytes(32).toString('hex');

writeEnvFile({ ...env, [bearerTokenEnv]: bearerToken, AGENT_REMOTE_MCP_STATE_FILE: stateFile });
const tunnelDirectory = path.join(path.dirname(stateFile), 'ssh-tunnels');
fs.mkdirSync(tunnelDirectory, { recursive: true, mode: 0o700 });
const tunnelFile = path.join(tunnelDirectory, `${ref}.json`);
const temporary = `${tunnelFile}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify({
  version: 2,
  ref,
  sshTarget,
  localPort,
  bearerTokenEnv,
  remoteUrl: 'http://127.0.0.1:7890/mcp',
  remoteInstallDir,
}, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, tunnelFile);
fs.chmodSync(tunnelFile, 0o600);
const retiredAdapter = path.join(path.dirname(stateFile), 'ssh-adapters', `${ref}.json`);
if (fs.existsSync(retiredAdapter)) fs.rmSync(retiredAdapter);

upsertRouterTarget({
  ref,
  ...(requestedName ? { name: requestedName } : {}),
  kind: 'ssh-server',
  upstream: `http://127.0.0.1:${localPort}/mcp`,
  authorizationEnv: bearerTokenEnv,
  ...(Array.isArray(targetAliases) && targetAliases.length > 0 ? { aliases: targetAliases } : {}),
}, stateFile);

console.log(`registered ssh-server target ${ref}`);
console.log(`ssh config alias: ${sshTarget}`);
console.log(`local SSH tunnel: 127.0.0.1:${localPort}`);
console.log(`state: ${stateFile}`);
