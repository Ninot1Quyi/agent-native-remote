import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const skillDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
export const envPath = path.join(skillDir, '.env');
const retiredRouterKeys = new Set([
  'AGENT_REMOTE_MCP_UPSTREAM',
  'AGENT_REMOTE_MCP_TARGETS_JSON',
  'AGENT_REMOTE_MCP_DEFAULT_TARGET',
  'AGENT_REMOTE_MCP_SESSION_STATE_FILE',
]);

export function parseEnvFile(file = envPath) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value.replace(/'\\''/g, "'");
  }
  return env;
}

export function quoteEnv(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

export function writeEnvFile(next, file = envPath) {
  const orderedKeys = [
    'AGENT_REMOTE_MCP_LOCAL_LISTEN',
    'AGENT_REMOTE_MCP_STATE_FILE',
    'AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE',
  ];
  const keys = [
    ...orderedKeys,
    ...Object.keys(next).filter(
      (key) => !orderedKeys.includes(key) && !retiredRouterKeys.has(key),
    ),
  ];
  const lines = ['# Local state for agent-native-remote. Do not commit or print.'];
  for (const key of keys) {
    if (retiredRouterKeys.has(key) || next[key] === undefined || next[key] === '') continue;
    lines.push(`${key}=${quoteEnv(next[key])}`);
  }
  lines.push('');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function routerStatePath(env = parseEnvFile()) {
  return env.AGENT_REMOTE_MCP_STATE_FILE ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state', 'agent-remote-mcp', 'router-state.json');
}

export function routerBearerTokenPath(env = parseEnvFile()) {
  return env.AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE ||
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'state',
      'agent-remote-mcp',
      'router-bearer-token',
    );
}

export function validateRouterBearerToken(token) {
  if (
    typeof token !== 'string' ||
    token.length < 32 ||
    token.length > 512 ||
    !/^[A-Za-z0-9._~-]+$/.test(token)
  ) {
    throw new Error('local Router bearer token must be 32-512 URL-safe ASCII characters');
  }
  return token;
}

export function generateRouterBearerToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function readRouterBearerToken(file = routerBearerTokenPath()) {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`local Router bearer token must be a regular file: ${file}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`local Router bearer token file must use mode 0600: ${file}`);
  }
  return validateRouterBearerToken(fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''));
}

export function writeRouterBearerToken(token, file = routerBearerTokenPath()) {
  const validated = validateRouterBearerToken(token);
  if (!path.isAbsolute(file)) {
    throw new Error('AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE must be an absolute path');
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = fs.lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`local Router state directory must be a regular directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to replace symlinked local Router bearer token: ${file}`);
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${validated}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return validated;
}

export function ensureRouterBearerToken(file = routerBearerTokenPath()) {
  if (fs.existsSync(file)) return readRouterBearerToken(file);
  return writeRouterBearerToken(generateRouterBearerToken(), file);
}

export function readRouterState(file = routerStatePath()) {
  if (!fs.existsSync(file)) return { version: 1, targets: [], threads: {} };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unknownFields = Object.keys(state).filter(
    (field) => !['version', 'targets', 'threads'].includes(field),
  );
  if (
    unknownFields.length > 0 ||
    state.version !== 1 ||
    !Array.isArray(state.targets) ||
    !state.threads ||
    Array.isArray(state.threads)
  ) {
    throw new Error(`invalid remote MCP Router state: ${file}`);
  }
  return state;
}

export function writeRouterState(state, file = routerStatePath()) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function upsertRouterTarget(target, file = routerStatePath()) {
  if (!target?.ref || !['http-mcp', 'ssh-server'].includes(target.kind)) {
    throw new Error('Router target requires ref and kind=http-mcp|ssh-server');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.ref)) {
    throw new Error('Router target ref must be a safe ASCII identifier');
  }
  const state = readRouterState(file);
  const previous = state.targets.find((entry) => entry?.ref === target.ref);
  const name = String(target.name ?? previous?.name ?? target.ref).trim();
  const aliasValues = Array.isArray(target.aliases) ? target.aliases : (previous?.aliases || []);
  const aliases = aliasValues.map((value) => String(value).trim());
  for (const [label, value] of [['name', name], ...aliases.map((value) => ['alias', value])]) {
    if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Router target ${label} must be 1-128 printable characters`);
    }
  }
  const requestedNames = new Set([target.ref, name, ...aliases]);
  for (const entry of state.targets) {
    if (entry?.ref === target.ref) continue;
    const existingNames = [entry?.ref, entry?.name || entry?.ref, ...(entry?.aliases || [])];
    const collision = existingNames.find((value) => requestedNames.has(value));
    if (collision) throw new Error(`Router target name or alias is already registered: ${collision}`);
  }
  const sameAdapter = previous &&
    previous.upstream === target.upstream &&
    (previous.origin || '') === (target.origin || '') &&
    (previous.cookieEnv || '') === (target.cookieEnv || '') &&
    (previous.authorizationEnv || '') === (target.authorizationEnv || '');
  const nextTarget = {
    ...target,
    ...(name !== target.ref ? { name } : {}),
    ...(aliases.length > 0 ? { aliases: [...new Set(aliases.filter((value) => value !== name && value !== target.ref))] } : {}),
    ...(sameAdapter && previous.machineCode ? { machineCode: previous.machineCode } : {}),
  };
  if (nextTarget.name === target.ref) delete nextTarget.name;
  if (!nextTarget.aliases?.length) delete nextTarget.aliases;
  state.targets = [
    ...state.targets.filter((entry) => entry?.ref !== target.ref),
    nextTarget,
  ];
  writeRouterState(state, file);
  return state;
}

export function mergedEnv() {
  return { ...parseEnvFile(), ...process.env };
}
