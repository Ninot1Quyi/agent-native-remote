#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readRouterBearerToken, routerBearerTokenPath } from './env.mjs';
const listen = process.env.AGENT_REMOTE_MCP_LOCAL_LISTEN || '127.0.0.1:7891';
const [host, portText] = listen.split(':');
const port = Number(portText);

const CONTROL_TOOL_NAMES = new Set(['router_list', 'router_connect', 'router_status']);
const CODE_MODE_RESULT_META = Object.freeze({
  'codex/codeModeResult': 'structuredContent',
});
const ROUTER_ERROR_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { const: false },
    error: { type: 'string' },
  },
  required: ['ok', 'error'],
  additionalProperties: false,
});
const ROUTER_STATUS_OUTPUT_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object',
      properties: {
        machine_code: { type: ['string', 'null'] },
        generation: { type: 'integer' },
        mode: { type: 'string' },
      },
      required: ['machine_code', 'generation', 'mode'],
      additionalProperties: false,
    },
    ROUTER_ERROR_OUTPUT_SCHEMA,
  ],
});
const ROUTER_LIST_OUTPUT_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              target_ref: { type: 'string' },
              kind: { type: 'string' },
              machine_code: { type: ['string', 'null'] },
              selected: { type: 'boolean' },
            },
            required: ['name', 'target_ref', 'kind', 'machine_code', 'selected'],
            additionalProperties: false,
          },
        },
      },
      required: ['targets'],
      additionalProperties: false,
    },
    ROUTER_ERROR_OUTPUT_SCHEMA,
  ],
});
const CONTROL_TOOLS = Object.freeze([
  {
    name: 'router_list',
    description: 'List registered targets with their user-facing names, kinds, and opaque machine codes.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: ROUTER_LIST_OUTPUT_SCHEMA,
    _meta: CODE_MODE_RESULT_META,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'router_connect',
    description: 'Connect the current MCP session to a target, or use main to resume parent inheritance.',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: {
          type: 'string',
          description: 'Registered target name, reference, alias, or opaque machine code.',
        },
      },
      required: ['target_ref'],
      additionalProperties: false,
    },
    outputSchema: ROUTER_STATUS_OUTPUT_SCHEMA,
    _meta: CODE_MODE_RESULT_META,
    annotations: { readOnlyHint: false },
  },
  {
    name: 'router_status',
    description: 'Show the single remote target bound to the current MCP session.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: ROUTER_STATUS_OUTPUT_SCHEMA,
    _meta: CODE_MODE_RESULT_META,
    annotations: { readOnlyHint: true },
  },
]);

const READ_ONLY_TOOLS = new Set([
  'env',
  'find',
  'health',
  'list',
  'port_list',
  'process_list',
  'pwd',
  'read',
  // read_session advances a remote cursor and must never be retried.
  'search',
  'sessions',
  'stat',
  'tail',
  'which',
]);
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);
const MAX_READ_ONLY_ATTEMPTS = 4;
const UPSTREAM_PROBE_TIMEOUT_MS = Number(process.env.AGENT_REMOTE_MCP_UPSTREAM_PROBE_TIMEOUT_MS || 2000);
const HTTP_MCP_DISCOVERY_TIMEOUT_MS = Number(process.env.AGENT_REMOTE_MCP_HTTP_DISCOVERY_TIMEOUT_MS || 30000);
const UPSTREAM_TOOL_TIMEOUT_MS = Number(process.env.AGENT_REMOTE_MCP_UPSTREAM_TOOL_TIMEOUT_MS || 310000);
const ROUTER_HEALTH_CHECK_INTERVAL_MS = Number(
  process.env.AGENT_REMOTE_MCP_HEALTH_CHECK_INTERVAL_MS || 30000,
);
const ROUTER_STATE_VERSION = 1;
const HANDLE_PRODUCERS = new Set(['exec_command', 'exec_session']);
const HANDLE_CONSUMERS = new Set(['read_session', 'write_stdin', 'kill_session']);

class ToolRoutingError extends Error {}
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sshTunnelStarter = process.env.NODE_ENV === 'test' &&
  process.env.AGENT_REMOTE_MCP_TEST_SSH_TUNNEL_STARTER
  ? path.resolve(process.env.AGENT_REMOTE_MCP_TEST_SSH_TUNNEL_STARTER)
  : path.join(scriptDirectory, 'start-ssh-server-tunnels.mjs');
const routerStateFile = String(
  process.env.AGENT_REMOTE_MCP_STATE_FILE ||
  path.join(codexHome, 'state', 'agent-remote-mcp', 'router-state.json'),
).trim();
const localBearerTokenFile = routerBearerTokenPath(process.env);

if (!Number.isFinite(port)) {
  throw new Error(`Invalid AGENT_REMOTE_MCP_LOCAL_LISTEN: ${listen}`);
}
if (!Number.isFinite(UPSTREAM_PROBE_TIMEOUT_MS) || UPSTREAM_PROBE_TIMEOUT_MS < 250) {
  throw new Error('AGENT_REMOTE_MCP_UPSTREAM_PROBE_TIMEOUT_MS must be at least 250 milliseconds.');
}
if (!Number.isFinite(UPSTREAM_TOOL_TIMEOUT_MS) || UPSTREAM_TOOL_TIMEOUT_MS < 1000) {
  throw new Error('AGENT_REMOTE_MCP_UPSTREAM_TOOL_TIMEOUT_MS must be at least 1000 milliseconds.');
}
const minimumHealthInterval = process.env.NODE_ENV === 'test' ? 20 : 1000;
if (!Number.isInteger(ROUTER_HEALTH_CHECK_INTERVAL_MS) ||
    ROUTER_HEALTH_CHECK_INTERVAL_MS < minimumHealthInterval) {
  throw new Error(`AGENT_REMOTE_MCP_HEALTH_CHECK_INTERVAL_MS must be at least ${minimumHealthInterval} milliseconds.`);
}
if (
  !Number.isFinite(HTTP_MCP_DISCOVERY_TIMEOUT_MS) ||
  HTTP_MCP_DISCOVERY_TIMEOUT_MS < 1000 ||
  HTTP_MCP_DISCOVERY_TIMEOUT_MS > UPSTREAM_TOOL_TIMEOUT_MS
) {
  throw new Error('AGENT_REMOTE_MCP_HTTP_DISCOVERY_TIMEOUT_MS must be between 1000 milliseconds and AGENT_REMOTE_MCP_UPSTREAM_TOOL_TIMEOUT_MS.');
}
if (!path.isAbsolute(routerStateFile)) {
  throw new Error('AGENT_REMOTE_MCP_STATE_FILE must be an absolute path.');
}
if (!path.isAbsolute(localBearerTokenFile)) {
  throw new Error('AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE must be an absolute path.');
}
const localBearerToken = readRouterBearerToken(localBearerTokenFile);
const expectedAuthorizationDigest = crypto
  .createHash('sha256')
  .update(`Bearer ${localBearerToken}`, 'utf8')
  .digest();

function hasValidLocalBearerToken(request) {
  const distinct = request.headersDistinct?.authorization;
  const received = Array.isArray(distinct)
    ? (distinct.length === 1 ? distinct[0] : '')
    : (typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
  const receivedDigest = crypto.createHash('sha256').update(received, 'utf8').digest();
  return crypto.timingSafeEqual(receivedDigest, expectedAuthorizationDigest);
}

function temporaryTargetCode(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);
  return `tmp_${digest}`;
}

function environmentSecret(raw, field) {
  const environmentName = raw[field];
  if (environmentName === undefined) return '';
  if (
    typeof environmentName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
  ) {
    throw new Error(`target ${field} must be an environment variable name`);
  }
  const value = process.env[environmentName];
  if (!value) throw new Error(`target credential environment is missing: ${environmentName}`);
  return value;
}

function rejectUnknownFields(raw, allowedFields, context) {
  const unknownFields = Object.keys(raw).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`${context} has unknown field(s): ${unknownFields.join(', ')}`);
  }
}

function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Every remote MCP target must be an object.');
  }
  rejectUnknownFields(
    raw,
    new Set([
      'ref',
      'name',
      'kind',
      'aliases',
      'upstream',
      'origin',
      'cookieEnv',
      'authorizationEnv',
      'machineCode',
    ]),
    'remote MCP target',
  );
  const ref = typeof raw.ref === 'string' ? raw.ref.trim() : '';
  if (!ref) throw new Error('Every remote MCP target requires a non-empty ref.');
  const name = raw.name === undefined ? ref : String(raw.name).trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Remote MCP target ${ref} has an invalid name.`);
  }
  const upstream = typeof raw.upstream === 'string' ? raw.upstream.trim() : '';
  if (!upstream) throw new Error(`Remote MCP target ${ref} requires an upstream URL.`);
  const parsed = new URL(upstream);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Remote MCP target ${ref} upstream must use http or https.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Remote MCP target ${ref} upstream must not contain credentials, query, or fragment.`);
  }
  if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) {
    throw new Error(`Remote MCP target ${ref} aliases must be an array.`);
  }
  const refs = [ref, name, ...(raw.aliases || [])]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  for (const candidate of refs) {
    if (candidate.length > 128 || /[\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error(`Remote MCP target ${ref} has an invalid reference.`);
    }
  }
  const authorizationToken = environmentSecret(raw, 'authorizationEnv');
  const kind = raw.kind === undefined ? 'http-mcp' : String(raw.kind).trim();
  if (!['http-mcp', 'ssh-server'].includes(kind)) {
    throw new Error(`Remote MCP target ${ref} kind must be http-mcp or ssh-server.`);
  }
  const persistedMachineCode = raw.machineCode === undefined
    ? null
    : String(raw.machineCode).trim();
  if (persistedMachineCode && !/^rmc_[0-9a-f]{32}$/.test(persistedMachineCode)) {
    throw new Error(`Remote MCP target ${ref} has an invalid persisted machineCode.`);
  }
  const origin = raw.origin === undefined ? '' : String(raw.origin).trim();
  if (origin && new URL(origin).origin !== origin.replace(/\/$/, '')) {
    throw new Error(`Remote MCP target ${ref} origin must be an absolute origin when provided.`);
  }
  return {
    ref,
    name,
    kind,
    machineCode: persistedMachineCode || temporaryTargetCode(`${ref}\0${parsed.toString()}`),
    refs: [...new Set(refs)],
    upstream: parsed.toString(),
    origin: origin.replace(/\/$/, ''),
    cookieEnv: raw.cookieEnv || null,
    authorizationEnv: raw.authorizationEnv || null,
    cookie: environmentSecret(raw, 'cookieEnv'),
    authorization: authorizationToken ? `Bearer ${authorizationToken}` : '',
    discovered: Boolean(persistedMachineCode),
  };
}

function loadRouterState() {
  if (!fs.existsSync(routerStateFile)) {
    throw new Error(`Agent remote MCP state file does not exist: ${routerStateFile}`);
  }
  const payload = JSON.parse(fs.readFileSync(routerStateFile, 'utf8'));
  rejectUnknownFields(payload, new Set(['version', 'targets', 'threads']), 'router state');
  if (payload.version !== ROUTER_STATE_VERSION) {
    throw new Error(`unsupported Agent remote MCP state version: ${payload.version}`);
  }
  if (!Array.isArray(payload.targets)) {
    throw new Error('router state targets must be an array');
  }
  if (!payload.threads || typeof payload.threads !== 'object' || Array.isArray(payload.threads)) {
    throw new Error('router state threads must be an object');
  }
  return payload;
}

class TargetRegistry {
  constructor(targets) {
    this.byMachineCode = new Map();
    this.byRef = new Map();
    this.adapters = [];
    for (const target of targets) this.register(target);
  }

  register(target) {
    for (const ref of target.refs) {
      const owner = this.byRef.get(ref);
      if (owner && owner !== target) {
        throw new Error(`target reference collision for ${ref}`);
      }
      this.byRef.set(ref, target);
    }
    this.adapters.push(target);
    this.addMachineAdapter(target.machineCode, target);
    return target;
  }

  addMachineAdapter(machineCode, target) {
    const adapters = this.byMachineCode.get(machineCode) || [];
    if (!adapters.includes(target)) adapters.push(target);
    this.byMachineCode.set(machineCode, adapters);
  }

  removeMachineAdapter(machineCode, target) {
    const adapters = (this.byMachineCode.get(machineCode) || []).filter(
      (candidate) => candidate !== target,
    );
    if (adapters.length > 0) this.byMachineCode.set(machineCode, adapters);
    else this.byMachineCode.delete(machineCode);
  }

  resolve(ref) {
    if (typeof ref !== 'string') return null;
    return this.byRef.get(ref) || this.byMachineCode.get(ref)?.[0] || null;
  }

  adoptMachineCode(target, discoveredMachineCode) {
    const machineCode = String(discoveredMachineCode || '').trim();
    if (!/^rmc_[0-9a-f]{32}$/.test(machineCode)) {
      throw new Error('remote health returned an invalid machine code');
    }
    if (target.machineCode === machineCode) {
      target.discovered = true;
      return target;
    }
    if (target.discovered || target.machineCode.startsWith('rmc_')) {
      throw new Error(
        `target identity changed from ${target.machineCode} to ${machineCode}; restart the Router to re-register it`,
      );
    }

    const oldMachineCode = target.machineCode;
    this.removeMachineAdapter(oldMachineCode, target);
    target.machineCode = machineCode;
    target.discovered = true;
    this.addMachineAdapter(machineCode, target);
    return target;
  }

  forgetMachineCode(target) {
    const oldMachineCode = target.machineCode;
    this.removeMachineAdapter(oldMachineCode, target);
    target.machineCode = temporaryTargetCode(`${target.ref}\0${target.upstream}\0unavailable`);
    target.discovered = false;
    this.addMachineAdapter(target.machineCode, target);
    return oldMachineCode;
  }

  discoveredTargets(selectedMachineCode) {
    return [...this.byMachineCode.entries()]
      .filter(([, targets]) => targets.some((target) => target.discovered))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([machineCode]) => ({
        machine_code: machineCode,
        selected: machineCode === selectedMachineCode,
      }));
  }

  listTargets(selectedMachineCode) {
    return this.adapters
      .map((target) => ({
        name: target.name,
        target_ref: target.ref,
        kind: target.kind,
        machine_code: target.discovered ? target.machineCode : null,
        selected: target.discovered && target.machineCode === selectedMachineCode,
      }))
      .sort((a, b) => a.target_ref.localeCompare(b.target_ref));
  }

  targets() {
    return [...this.adapters];
  }

  records() {
    return this.adapters.map((target) => ({
      ref: target.ref,
      ...(target.name !== target.ref ? { name: target.name } : {}),
      kind: target.kind,
      ...(target.refs.some((candidate) => candidate !== target.ref && candidate !== target.name)
        ? { aliases: target.refs.filter((candidate) => candidate !== target.ref && candidate !== target.name) }
        : {}),
      upstream: target.upstream,
      ...(target.origin ? { origin: target.origin } : {}),
      ...(target.cookieEnv ? { cookieEnv: target.cookieEnv } : {}),
      ...(target.authorizationEnv ? { authorizationEnv: target.authorizationEnv } : {}),
      ...(target.discovered ? { machineCode: target.machineCode } : {}),
    }));
  }
}

const initialRouterState = loadRouterState();
const registry = new TargetRegistry(initialRouterState.targets.map(normalizeTarget));
const sessions = new Map();
const threadSessions = new Map();
const closedSessionIds = new Set();
const persistedThreads = loadPersistedThreads(initialRouterState.threads);
const targetHealth = new Map(registry.targets().map((target) => [target.ref, {
  status: 'unknown',
  consecutiveFailures: 0,
  lastCheckedAt: null,
  recoveries: 0,
}]));
const targetRecoveries = new Map();
const targetChecks = new Map();
let canonicalBusinessTools = null;
let canonicalToolFingerprint = null;

function validThreadId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function jsonObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function sanitizeInitializeParams(params = {}) {
  return {
    protocolVersion:
      typeof params.protocolVersion === 'string' && params.protocolVersion
        ? params.protocolVersion
        : '2024-11-05',
    capabilities: jsonObject(params.capabilities),
    clientInfo: jsonObject(params.clientInfo, {
      name: 'codex-session-recovery',
      version: '1',
    }),
  };
}

function loadPersistedThreads(rawThreads) {
  const records = new Map();
  for (const [threadId, record] of Object.entries(rawThreads)) {
    if (!validThreadId(threadId) || !record || typeof record !== 'object' || Array.isArray(record)) {
      continue;
    }
    rejectUnknownFields(
      record,
      new Set([
        'parentThreadId',
        'routeMode',
        'targetRef',
        'machineCode',
        'generation',
        'initializeParams',
      ]),
      `router state thread ${threadId}`,
    );
    if (!['owner', 'detached', 'inherited'].includes(record.routeMode)) continue;
    const parentThreadId = validThreadId(record.parentThreadId) ? record.parentThreadId : null;
    const targetRef = typeof record.targetRef === 'string' && record.targetRef.trim()
      ? record.targetRef.trim()
      : null;
    const machineCode = typeof record.machineCode === 'string' && /^rmc_[0-9a-f]{32}$/.test(record.machineCode)
      ? record.machineCode
      : null;
    if (record.routeMode === 'inherited' && !parentThreadId) continue;
    records.set(threadId, {
      parentThreadId,
      routeMode: record.routeMode,
      targetRef,
      machineCode,
      generation: Math.max(0, Number(record.generation) || 0),
      initializeParams: sanitizeInitializeParams(record.initializeParams),
    });
  }
  return records;
}

function flushRouterState() {
  const directory = path.dirname(routerStateFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${routerStateFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const threads = Object.fromEntries([...persistedThreads.entries()].sort(([left], [right]) =>
    left.localeCompare(right)));
  const state = {
    version: ROUTER_STATE_VERSION,
    targets: registry.records(),
    threads,
  };
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, routerStateFile);
  fs.chmodSync(routerStateFile, 0o600);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isReadOnlyRpc(method, params = {}) {
  if (method === 'initialize' || method === 'ping' || method === 'tools/list') {
    return true;
  }
  return method === 'tools/call' && READ_ONLY_TOOLS.has(params?.name);
}

function parseRpcBody(body) {
  try {
    const rpc = JSON.parse(body.toString('utf8'));
    return rpc && !Array.isArray(rpc) && typeof rpc === 'object' ? rpc : null;
  } catch {
    return null;
  }
}

function retryDelay(attempt) {
  return 250 * (2 ** attempt);
}

function upstreamHeaders(target, { accept = 'application/json', contentType = 'application/json', sessionId } = {}) {
  return {
    accept,
    'content-type': contentType,
    ...(target.cookie ? { cookie: target.cookie } : {}),
    ...(target.authorization ? { authorization: target.authorization } : {}),
    ...(target.origin ? { origin: target.origin, referer: `${target.origin}/` } : {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function fetchUpstream(target, options, readOnly, timeoutMs = UPSTREAM_PROBE_TIMEOUT_MS) {
  const attempts = readOnly ? MAX_READ_ONLY_ATTEMPTS : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(target.upstream, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!readOnly || !RETRYABLE_UPSTREAM_STATUSES.has(response.status) || attempt === attempts - 1) {
        return response;
      }
      await response.arrayBuffer();
      lastError = new Error(`upstream returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error?.name === 'TimeoutError') throw error;
      if (!readOnly || attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
  }
  throw lastError || new Error('upstream request failed');
}

function upstreamRpcTimeout(method, params = {}) {
  if (method !== 'tools/call') return UPSTREAM_PROBE_TIMEOUT_MS;
  const requested = Number(params?.arguments?.timeout_ms);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(requested + 5_000, UPSTREAM_PROBE_TIMEOUT_MS), UPSTREAM_TOOL_TIMEOUT_MS);
  }
  return UPSTREAM_TOOL_TIMEOUT_MS;
}

async function rpcUpstream(
  target,
  upstreamSession,
  method,
  params = {},
  timeoutMs = upstreamRpcTimeout(method, params),
  retryReadOnly = true,
) {
  const response = await fetchUpstream(target, {
    method: 'POST',
    headers: upstreamHeaders(target, { sessionId: upstreamSession?.sessionId }),
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  }, retryReadOnly && isReadOnlyRpc(method, params), timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  const nextSessionId = response.headers.get('mcp-session-id');
  if (upstreamSession && nextSessionId) upstreamSession.sessionId = nextSessionId;
  return { result: payload.result, sessionId: nextSessionId };
}

function migrateMachineCode(oldMachineCode, newMachineCode) {
  if (oldMachineCode === newMachineCode) return;
  const groups = new Set();
  for (const localSession of sessions.values()) {
    if (localSession.routeGroup) groups.add(localSession.routeGroup);
    if (localSession.observedRoute?.machineCode === oldMachineCode) {
      localSession.observedRoute.machineCode = newMachineCode;
    }
    if (localSession.activeUpstream?.machineCode === oldMachineCode) {
      localSession.activeUpstream.machineCode = newMachineCode;
    }
    if (localSession.pendingUpstream?.machineCode === oldMachineCode) {
      localSession.pendingUpstream.machineCode = newMachineCode;
    }
    for (const binding of localSession.handles?.values() || []) {
      if (binding.machineCode === oldMachineCode) binding.machineCode = newMachineCode;
    }
  }
  for (const group of groups) {
    if (group.machineCode === oldMachineCode) group.machineCode = newMachineCode;
  }
  for (const record of persistedThreads.values()) {
    if (record.machineCode === oldMachineCode) record.machineCode = newMachineCode;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function invocationSchema(value) {
  if (Array.isArray(value)) return value.map(invocationSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['description', 'title', 'examples', 'default'].includes(key))
    .map(([key, entry]) => [key, invocationSchema(entry)]));
}

function routingContract(tool) {
  const inputSchema = invocationSchema(tool.inputSchema || {});
  if (tool.name === 'view_image' && inputSchema.properties) {
    delete inputSchema.properties.detail;
    if (Array.isArray(inputSchema.required)) {
      inputSchema.required = inputSchema.required.filter((name) => name !== 'detail');
    }
  }
  if (tool.name === 'write_stdin' && inputSchema.properties) {
    delete inputSchema.properties.content;
    inputSchema.properties.session_id = { type: ['integer', 'string'] };
  }
  return { name: tool.name, inputSchema };
}

function acceptToolContract(machineCode, tools) {
  const businessTools = tools
    .filter((tool) => tool && typeof tool.name === 'string' && !CONTROL_TOOL_NAMES.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(businessTools.map((tool) => tool.name)).size !== businessTools.length) {
    throw new Error(`remote tool contract has duplicate Router names for ${machineCode}`);
  }
  const invocationContract = businessTools.map(routingContract);
  const fingerprint = crypto.createHash('sha256').update(stableJson(invocationContract)).digest('hex');
  if (!canonicalBusinessTools) {
    canonicalBusinessTools = structuredClone(businessTools);
    canonicalToolFingerprint = fingerprint;
  } else if (fingerprint !== canonicalToolFingerprint) {
    throw new Error(`remote tool contract mismatch for ${machineCode}`);
  }
}

async function openUpstreamSession(localSession, target, { retryReadOnly = true } = {}) {
  const upstreamSession = { sessionId: null, initializeResult: null, target, machineCode: target.machineCode };
  const discoveryTimeoutMs = target.kind === 'http-mcp'
    ? HTTP_MCP_DISCOVERY_TIMEOUT_MS
    : UPSTREAM_PROBE_TIMEOUT_MS;
  const initialized = await rpcUpstream(
    target,
    upstreamSession,
    'initialize',
    localSession.initializeParams,
    discoveryTimeoutMs,
    retryReadOnly,
  );
  upstreamSession.initializeResult = initialized.result;
  if (initialized.sessionId) upstreamSession.sessionId = initialized.sessionId;
  const listed = await rpcUpstream(
    target,
    upstreamSession,
    'tools/list',
    {},
    discoveryTimeoutMs,
    retryReadOnly,
  );
  const health = await rpcUpstream(target, upstreamSession, 'tools/call', {
    name: 'health',
    arguments: {},
  }, discoveryTimeoutMs, retryReadOnly);
  acceptToolContract(target.machineCode, listed.result?.tools || []);
  if (health.result?.isError) throw new Error('remote health tool failed');
  const healthContent = health.result?.structuredContent || {};
  const healthMachineCode = healthContent.machineCode || healthContent.machine_code;
  const initializeMachineCode = initialized.result?.serverInfo?.machineCode;
  if (!healthMachineCode) {
    throw new Error('remote health did not return machineCode');
  }
  if (initializeMachineCode && initializeMachineCode !== healthMachineCode) {
    throw new Error('remote initialize and health machineCode values differ');
  }
  const oldMachineCode = target.machineCode;
  const wasDiscovered = target.discovered;
  const canonicalTarget = registry.adoptMachineCode(target, healthMachineCode);
  migrateMachineCode(oldMachineCode, canonicalTarget.machineCode);
  upstreamSession.machineCode = canonicalTarget.machineCode;
  if (typeof healthContent.root !== 'string' || !healthContent.root.startsWith('/')) {
    throw new Error('remote health did not return an absolute workspace root');
  }
  if (healthContent.rootIsDirectory !== true) {
    throw new Error('remote health did not confirm that the workspace root is a directory');
  }
  upstreamSession.root = healthContent.root;
  upstreamSession.rootIsDirectory = true;
  target.root = healthContent.root;
  canonicalTarget.discovered = true;
  target.discovered = true;
  if (!wasDiscovered || oldMachineCode !== canonicalTarget.machineCode) {
    flushRouterState();
  }
  return upstreamSession;
}

async function closeUpstreamSession(upstreamSession) {
  if (!upstreamSession?.sessionId) return;
  await fetch(upstreamSession.target.upstream, {
    method: 'DELETE',
    headers: upstreamHeaders(upstreamSession.target, { sessionId: upstreamSession.sessionId }),
    signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
  });
}

function monitorInitializeParams() {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-native-router-health', version: '1' },
  };
}

function monitorDiagnostic(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-600);
}

function runManagedHelper(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-8192);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: monitorDiagnostic(error.message), timedOut: false });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const output = monitorDiagnostic(`${stderr}\n${stdout}`);
      resolve({
        ok: code === 0 && !timedOut,
        output,
        timedOut,
      });
    });
  });
}

function targetHasBusySession(target) {
  for (const localSession of sessions.values()) {
    let route;
    try {
      route = effectiveRoute(localSession);
    } catch {
      continue;
    }
    if (route.machineCode !== target.machineCode) continue;
    if (localSession.gate.activeReaders > 0 || localSession.gate.writer ||
        localSession.gate.queue.length > 0 || localSession.pendingUpstream) {
      return true;
    }
  }
  return false;
}

async function invalidateTargetUpstreams(target, { preserveHandleSessions = false } = {}) {
  const stale = [];
  for (const localSession of sessions.values()) {
    if (localSession.activeUpstream?.session?.target !== target) continue;
    if (preserveHandleSessions && localSession.handles.size > 0) continue;
    stale.push(localSession.activeUpstream.session);
    localSession.activeUpstream = null;
  }
  await Promise.allSettled(stale.map(closeUpstreamSession));
}

async function probeTarget(target) {
  const upstreamSession = await openUpstreamSession(
    { initializeParams: monitorInitializeParams() },
    target,
    { retryReadOnly: false },
  );
  await closeUpstreamSession(upstreamSession).catch(() => {});
}

async function repairTarget(target) {
  if (target.kind === 'ssh-server') {
    return runManagedHelper(sshTunnelStarter, ['--ref', target.ref], 120_000);
  }
  return { ok: true, passive: true };
}

function healthSummary() {
  const statuses = { healthy: 0, recovering: 0, unhealthy: 0, unknown: 0 };
  for (const state of targetHealth.values()) {
    if (Object.hasOwn(statuses, state.status)) statuses[state.status] += 1;
    else statuses.unknown += 1;
  }
  return statuses;
}

async function checkAndRepairTarget(target) {
  const state = targetHealth.get(target.ref);
  state.lastCheckedAt = new Date().toISOString();
  if (targetHasBusySession(target)) {
    return;
  }
  try {
    await probeTarget(target);
    state.status = 'healthy';
    state.consecutiveFailures = 0;
    return;
  } catch (error) {
    state.status = 'unhealthy';
    state.consecutiveFailures += 1;
    state.lastError = monitorDiagnostic(error.message);
  }

  if (targetHasBusySession(target)) return;
  state.status = 'recovering';
  const recovery = (async () => {
    const repaired = await repairTarget(target);
    if (!repaired.ok) {
      state.status = 'unhealthy';
      state.lastError = repaired.output || 'managed recovery failed';
      return;
    }
    await invalidateTargetUpstreams(target, { preserveHandleSessions: true });
    try {
      await probeTarget(target);
      state.status = 'healthy';
      state.consecutiveFailures = 0;
      state.recoveries += 1;
      state.lastError = null;
      console.log(JSON.stringify({
        event: 'router-target-self-healed',
        target_ref: target.ref,
        recovery: repaired.passive ? 'session-reopen' : 'managed-transport-restart',
      }));
    } catch (error) {
      state.status = 'unhealthy';
      state.lastError = monitorDiagnostic(error.message);
    }
  })();
  targetRecoveries.set(target, recovery);
  try {
    await recovery;
  } finally {
    if (targetRecoveries.get(target) === recovery) targetRecoveries.delete(target);
  }
}

function runHealthSweep() {
  for (const target of registry.targets()) {
    if (targetChecks.has(target)) continue;
    const check = checkAndRepairTarget(target)
      .catch((error) => {
        const state = targetHealth.get(target.ref);
        state.status = 'unhealthy';
        state.lastError = monitorDiagnostic(error.message);
        console.error(JSON.stringify({
          event: 'router-target-health-check-failed',
          target_ref: target.ref,
          error: state.lastError,
        }));
      })
      .finally(() => {
        if (targetChecks.get(target) === check) targetChecks.delete(target);
      });
    targetChecks.set(target, check);
  }
}

function sameRoute(left, right) {
  return left?.machineCode === right?.machineCode && left?.generation === right?.generation;
}

async function syncSessionRoute(localSession) {
  const route = effectiveRoute(localSession);
  if (sameRoute(localSession.observedRoute, route)) return route;

  const previous = localSession.activeUpstream?.session || null;
  localSession.activeUpstream = null;
  localSession.handles.clear();
  localSession.observedRoute = { ...route };
  if (previous) {
    localSession.retiredUpstreams.add(previous);
    try {
      await closeUpstreamSession(previous);
      localSession.retiredUpstreams.delete(previous);
    } catch {
      // Keep the unreachable upstream in the retirement set so DELETE can retry
      // cleanup, but never expose it to later requests.
    }
  }
  return route;
}

async function ensureUpstreamSession(localSession, target) {
  const recovery = targetRecoveries.get(target);
  if (recovery) await recovery;
  const route = await syncSessionRoute(localSession);
  if (!route.machineCode) throw new Error('NO_TARGET_BOUND');
  if (route.machineCode !== target.machineCode) {
    throw new Error('selected target changed before the request could start');
  }

  const active = localSession.activeUpstream;
  if (
    active &&
    active.machineCode === route.machineCode &&
    active.generation === route.generation
  ) {
    return active.session;
  }

  const pending = localSession.pendingUpstream;
  if (
    pending &&
    pending.machineCode === route.machineCode &&
    pending.generation === route.generation
  ) {
    return pending.promise;
  }

  const expectedRoute = { ...route };
  const pendingUpstream = {
    machineCode: expectedRoute.machineCode,
    generation: expectedRoute.generation,
    promise: null,
  };
  const opening = openUpstreamSession(localSession, target)
    .then(async (upstreamSession) => {
      const currentRoute = effectiveRoute(localSession);
      if (!sameRoute(currentRoute, {
        machineCode: upstreamSession.machineCode,
        generation: expectedRoute.generation,
      }) || !sessions.has(localSession.id)) {
        await closeUpstreamSession(upstreamSession).catch(() => {});
        throw new Error('selected target changed while opening its upstream session');
      }
      localSession.activeUpstream = {
        machineCode: upstreamSession.machineCode,
        generation: expectedRoute.generation,
        session: upstreamSession,
      };
      localSession.observedRoute = { ...currentRoute };
      return upstreamSession;
    })
    .finally(() => {
      if (localSession.pendingUpstream === pendingUpstream) {
        localSession.pendingUpstream = null;
      }
    });
  pendingUpstream.promise = opening;
  localSession.pendingUpstream = pendingUpstream;
  return opening;
}

async function ensureCanonicalToolContract(initializeParams) {
  if (canonicalBusinessTools) return;
  const failures = [];
  const candidates = registry.targets().sort((left, right) => {
    const leftPriority = left.kind === 'http-mcp' ? 0 : 1;
    const rightPriority = right.kind === 'http-mcp' ? 0 : 1;
    return leftPriority - rightPriority;
  });
  if (candidates.length === 0) {
    canonicalBusinessTools = [];
    canonicalToolFingerprint = crypto.createHash('sha256').update(stableJson([])).digest('hex');
    return;
  }
  for (const target of candidates) {
    const probeSession = { initializeParams };
    try {
      const upstreamSession = await openUpstreamSession(probeSession, target);
      await closeUpstreamSession(upstreamSession).catch(() => {});
      return;
    } catch (error) {
      failures.push(`${target.ref}: ${error.message}`);
    }
  }
  throw new Error(`no registered target could provide the remote tool contract: ${failures.join('; ')}`);
}

async function callTool(target, upstreamSession, name, args = {}) {
  const { result } = await rpcUpstream(upstreamSession.target || target, upstreamSession, 'tools/call', {
    name,
    arguments: args,
  });
  if (result?.isError) throw new Error(JSON.stringify(result));
  return result?.structuredContent;
}

async function runLongExec(localSession, target, args) {
  const upstreamSession = await ensureUpstreamSession(localSession, target);
  const remoteRoot = upstreamSession.root || upstreamSession.target?.root || target.root;
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new Error('selected target has no remote workspace root');
  }
  const requestedTimeoutMs = Math.min(Number(args.timeout_ms || 30000), 300000);
  // Keep a small reserve below Codex/App MCP call limits so a max-length
  // remote.exec returns a structured timeout instead of a transport timeout.
  const timeoutMs = Math.max(1000, Math.min(requestedTimeoutMs, 295000));
  const requestedMaxOutputBytes = Number(args.max_output_bytes || 256 * 1024);
  const maxOutputBytes = Number.isSafeInteger(requestedMaxOutputBytes) && requestedMaxOutputBytes > 0
    ? requestedMaxOutputBytes
    : 256 * 1024;
  const cwd = args.cwd || remoteRoot;
  const childEnvironment = {
    PATH:
      process.env.AGENT_REMOTE_MCP_EXEC_PATH ||
      `${remoteRoot}/bin:${remoteRoot}/background-agents/tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: remoteRoot,
    USER: 'root',
    LOGNAME: 'root',
    ...(args.env || {}),
  };
  for (const [key, value] of Object.entries(childEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid remote.exec environment variable name: ${key}`);
    }
    childEnvironment[key] = String(value);
  }
  const sessionId = `router-long-exec-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const started = await callTool(target, upstreamSession, 'exec_session', {
    cmd: args.cmd,
    cwd,
    env: childEnvironment,
    tty: false,
    session_id: sessionId,
  });
  const upstreamProcessId = started?.sessionId || started?.session_id || sessionId;
  if (typeof upstreamProcessId !== 'string' || upstreamProcessId.length === 0) {
    await callTool(target, upstreamSession, 'kill_session', { session_id: sessionId }).catch(() => {});
    throw new Error('remote exec_session did not return a session identifier');
  }

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let exitCode = null;
  let stdout = '';
  let stderr = '';
  let pty = '';
  const appendLimited = (current, value) => {
    if (current.length >= maxOutputBytes || typeof value !== 'string') return current;
    return `${current}${value}`.slice(0, maxOutputBytes);
  };
  let completed = false;
  try {
    while (Date.now() < deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      const recent = await callTool(target, upstreamSession, 'read_session', {
        session_id: upstreamProcessId,
        wait_ms: Math.min(8000, remainingMs),
        max_output_bytes: maxOutputBytes,
      });
      stdout = appendLimited(stdout, recent?.stdout);
      stderr = appendLimited(stderr, recent?.stderr);
      pty = appendLimited(pty, recent?.pty);
      if (Number.isInteger(recent?.exitCode)) {
        exitCode = recent.exitCode;
      }
      if (recent?.closed) {
        completed = true;
        break;
      }
    }
  } catch (error) {
    await callTool(target, upstreamSession, 'kill_session', { session_id: upstreamProcessId }).catch(() => {});
    throw error;
  }
  if (!completed) {
    timedOut = true;
    await callTool(target, upstreamSession, 'kill_session', { session_id: upstreamProcessId });
  }

  return {
    exitCode,
    timedOut,
    running: false,
    stdout,
    stderr,
    pty,
    cwd,
  };
}

function maybeLongExec(rpc) {
  const params = rpc?.params;
  const args = params?.arguments || {};
  if (
    rpc?.method === 'tools/call' &&
    params?.name === 'exec' &&
    Number(args.timeout_ms || 0) > 60000
  ) {
    return args;
  }
  return null;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(structuredContent, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
    _meta: CODE_MODE_RESULT_META,
  };
}

function writeJson(res, status, payload, sessionId) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  res.end(JSON.stringify(payload));
}

class SessionGate {
  constructor() {
    this.activeReaders = 0;
    this.writer = false;
    this.closed = false;
    this.queue = [];
  }

  runShared(operation) {
    return this.enqueue('shared', operation);
  }

  runExclusive(operation) {
    return this.enqueue('exclusive', operation);
  }

  closeAndWait() {
    this.closed = true;
    return this.enqueue('exclusive', async () => {}, true);
  }

  enqueue(kind, operation, allowClosed = false) {
    if (this.closed && !allowClosed) {
      return Promise.reject(new ToolRoutingError('MCP session is closing'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, operation, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.writer || this.queue.length === 0) return;
    if (this.queue[0].kind === 'exclusive') {
      if (this.activeReaders !== 0) return;
      const entry = this.queue.shift();
      this.writer = true;
      Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.writer = false;
          this.drain();
        });
      return;
    }
    while (!this.writer && this.queue[0]?.kind === 'shared') {
      const entry = this.queue.shift();
      this.activeReaders += 1;
      Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeReaders -= 1;
          this.drain();
        });
    }
  }
}

function withSessionShared(localSession, operation) {
  if (localSession.closing) return Promise.reject(new ToolRoutingError('MCP session is closing'));
  return localSession.gate.runShared(operation);
}

function withSessionExclusive(localSession, operation) {
  if (localSession.closing) return Promise.reject(new ToolRoutingError('MCP session is closing'));
  return localSession.gate.runExclusive(operation);
}

function targetRefForMachineCode(machineCode) {
  const target = registry.resolve(machineCode);
  return target?.ref || null;
}

function persistThreadSession(localSession) {
  const route = effectiveRoute(localSession);
  const targetRef = targetRefForMachineCode(route.machineCode);
  if (localSession.threadId) {
    const threadRoute = localSession.routeMode === 'inherited' ? null : route;
    persistedThreads.set(localSession.threadId, {
      parentThreadId: localSession.parentThreadId,
      routeMode: localSession.routeMode,
      targetRef: threadRoute ? targetRef : null,
      machineCode: threadRoute?.machineCode || null,
      generation: threadRoute?.generation || 0,
      initializeParams: sanitizeInitializeParams(localSession.initializeParams),
    });
  }
  flushRouterState();
}

function restoreThreadRoute(threadId, visited = new Set()) {
  const currentSessionId = threadSessions.get(threadId);
  const currentSession = currentSessionId ? sessions.get(currentSessionId) : null;
  if (currentSession) return currentSession;
  if (visited.has(threadId)) throw new Error('persisted thread route inheritance cycle detected');
  visited.add(threadId);
  const record = persistedThreads.get(threadId);
  if (!record) return null;
  if (record.routeMode === 'inherited' && !restoreThreadRoute(record.parentThreadId, visited)) {
    return null;
  }
  const target = record.routeMode === 'inherited' || !record.targetRef
    ? null
    : registry.resolve(record.targetRef);
  const targetIdentityMatches = Boolean(
    target && target.discovered && target.machineCode === record.machineCode,
  );
  const id = `restored:${crypto.createHash('sha256').update(threadId).digest('hex').slice(0, 24)}`;
  const localSession = {
    id,
    initializeParams: sanitizeInitializeParams(record.initializeParams),
    threadId,
    parentThreadId: record.parentThreadId,
    routeMode: record.routeMode,
    routeGroup: record.routeMode === 'inherited'
      ? null
      : {
        machineCode: targetIdentityMatches ? target.machineCode : null,
        generation: record.generation + (record.targetRef && !targetIdentityMatches ? 1 : 0),
      },
    observedRoute: null,
    activeUpstream: null,
    pendingUpstream: null,
    retiredUpstreams: new Set(),
    handles: new Map(),
    nextExecHandleId: 1,
    gate: new SessionGate(),
    synthetic: true,
  };
  localSession.observedRoute = { ...effectiveRoute(localSession) };
  sessions.set(id, localSession);
  threadSessions.set(threadId, id);
  return localSession;
}

function localSessionFromLineage(localSessionId, threadId, parentThreadId) {
  const previousSessionId = threadSessions.get(threadId);
  const previousSession = previousSessionId ? sessions.get(previousSessionId) : null;
  let record = persistedThreads.get(threadId);
  if (!previousSession && !record) return null;
  const expectedParentThreadId = previousSession?.parentThreadId ?? record?.parentThreadId ?? null;
  if (parentThreadId !== expectedParentThreadId) {
    throw new Error('thread parent lineage changed while recovering MCP session');
  }
  const source = previousSession || restoreThreadRoute(threadId);
  if (!source) return null;
  const localSession = {
    id: localSessionId,
    initializeParams: sanitizeInitializeParams(source.initializeParams),
    threadId,
    parentThreadId: expectedParentThreadId,
    routeMode: source.routeMode,
    routeGroup: source.routeGroup,
    observedRoute: null,
    activeUpstream: null,
    pendingUpstream: null,
    retiredUpstreams: new Set(),
    handles: new Map(),
    nextExecHandleId: 1,
    gate: new SessionGate(),
  };
  localSession.observedRoute = { ...effectiveRoute(localSession) };
  sessions.set(localSessionId, localSession);
  threadSessions.set(threadId, localSessionId);
  if (source.synthetic) sessions.delete(source.id);
  return localSession;
}

async function recoverLocalSession(req, localSessionId) {
  if (!localSessionId || closedSessionIds.has(localSessionId)) {
    return null;
  }
  const lineageEnabled = String(req.headers['x-codex-route-lineage'] || '') === 'current';
  const rawThreadId = String(req.headers['x-codex-thread-id'] || '').trim();
  const rawParentThreadId = String(req.headers['x-codex-parent-thread-id'] || '').trim();
  if (
    !lineageEnabled ||
    !validThreadId(rawThreadId) ||
    (rawParentThreadId && (!rawThreadId || !validThreadId(rawParentThreadId)))
  ) {
    return null;
  }

  const threadId = rawThreadId || null;
  const parentThreadId = rawParentThreadId || null;
  const previousSessionId = threadId ? threadSessions.get(threadId) : null;
  const previousSession = previousSessionId ? sessions.get(previousSessionId) : null;
  const localSession = localSessionFromLineage(localSessionId, threadId, parentThreadId);
  if (!localSession) return null;
  try {
    await ensureCanonicalToolContract(localSession.initializeParams);
    persistThreadSession(localSession);
    console.log('Recovered one local MCP session from durable route state.');
    return localSession;
  } catch (error) {
    sessions.delete(localSessionId);
    if (previousSession) threadSessions.set(threadId, previousSession.id);
    else threadSessions.delete(threadId);
    throw error;
  }
}

function effectiveRoute(localSession, visited = new Set()) {
  if (visited.has(localSession.id)) throw new Error('route inheritance cycle detected');
  visited.add(localSession.id);
  if (localSession.routeMode !== 'inherited') {
    if (!localSession.routeGroup) throw new Error('session has no route group');
    return localSession.routeGroup;
  }
  if (!localSession.parentThreadId) throw new Error('session has no parent route');
  const parentSessionId = threadSessions.get(localSession.parentThreadId);
  const parentSession = parentSessionId ? sessions.get(parentSessionId) : null;
  if (!parentSession) throw new Error('parent route is unavailable');
  return effectiveRoute(parentSession, visited);
}

function sessionStatus(localSession) {
  const route = effectiveRoute(localSession);
  const upstream = localSession.activeUpstream?.session;
  return {
    machine_code: route.machineCode,
    generation: route.generation,
    mode: localSession.routeMode,
    ...(upstream?.rootIsDirectory === true ? {
      remote_root: upstream.root,
      root_is_directory: true,
    } : {}),
  };
}

function targetList(localSession) {
  const route = effectiveRoute(localSession);
  return { targets: registry.listTargets(route.machineCode) };
}

function bindSession(localSession, target) {
  const currentRoute = effectiveRoute(localSession);
  if (localSession.routeMode === 'inherited') {
    localSession.routeMode = 'detached';
    localSession.routeGroup = {
      machineCode: target.machineCode,
      generation: currentRoute.generation + 1,
    };
  } else if (currentRoute.machineCode !== target.machineCode) {
    currentRoute.machineCode = target.machineCode;
    currentRoute.generation += 1;
  }
  return sessionStatus(localSession);
}

function unbindSession(localSession) {
  const currentRoute = effectiveRoute(localSession);
  if (localSession.routeMode === 'inherited') {
    localSession.routeMode = 'detached';
    localSession.routeGroup = {
      machineCode: null,
      generation: currentRoute.generation + 1,
    };
  } else if (currentRoute.machineCode !== null) {
    currentRoute.machineCode = null;
    currentRoute.generation += 1;
  }
  return sessionStatus(localSession);
}

async function rejoinParent(localSession) {
  if (!localSession.parentThreadId) throw new Error('this session has no parent route');
  if (!threadSessions.has(localSession.parentThreadId)) {
    restoreThreadRoute(localSession.parentThreadId);
  }
  const parentSessionId = threadSessions.get(localSession.parentThreadId);
  const parentSession = parentSessionId ? sessions.get(parentSessionId) : null;
  if (!parentSession) throw new Error('parent route is unavailable');
  const parentRoute = effectiveRoute(parentSession);
  localSession.routeMode = 'inherited';
  localSession.routeGroup = null;
  await syncSessionRoute(localSession);
  if (parentRoute.machineCode) {
    const target = registry.resolve(parentRoute.machineCode);
    if (!target) throw new Error('parent target is unavailable');
    await ensureUpstreamSession(localSession, target);
  }
  return sessionStatus(localSession);
}

async function connectWithDeployAdapter(targetRef) {
  // Deployment transports can register a new adapter here after uploading and
  // probing the remote binary. The first version intentionally accepts only
  // configured targets so an unknown reference can never become a guessed host.
  throw new Error(`target is not registered: ${targetRef}`);
}

async function handleControlCall(localSession, name, args) {
  try {
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      throw new Error(`${name} arguments must be an object`);
    }
    if (name === 'router_status' || name === 'router_list') {
      if (Object.keys(args).length !== 0) throw new Error(`${name} accepts no arguments`);
      return toolResult(name === 'router_status' ? sessionStatus(localSession) : targetList(localSession));
    }

    const unexpectedArguments = Object.keys(args).filter((key) => key !== 'target_ref');
    if (unexpectedArguments.length > 0) {
      throw new Error(`${name} does not accept: ${unexpectedArguments.join(', ')}`);
    }

    const ref = args.target_ref;
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new Error('router_connect requires a non-empty target_ref');
    }

    if (ref.trim() === 'main') {
      const result = await rejoinParent(localSession);
      persistThreadSession(localSession);
      return toolResult(result);
    }

    let target = registry.resolve(ref.trim());
    if (!target) target = await connectWithDeployAdapter(ref.trim());
    if (!target) throw new Error(`unknown target: ${ref}`);

    bindSession(localSession, target);
    try {
      await ensureUpstreamSession(localSession, target);
    } catch (error) {
      unbindSession(localSession);
      await syncSessionRoute(localSession);
      persistThreadSession(localSession);
      throw error;
    }
    persistThreadSession(localSession);
    return toolResult(sessionStatus(localSession));
  } catch (error) {
    return toolResult({ ok: false, error: error.message }, true);
  }
}

function toolHandle(argumentsValue) {
  const value = toolHandleValue(argumentsValue);
  if (value === null) return null;
  return String(value);
}

function toolHandleValue(argumentsValue) {
  const value = argumentsValue?.session_id ?? argumentsValue?.sessionId;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const handle = value.trim();
  return handle || null;
}

function targetForToolCall(localSession, rpc) {
  const route = effectiveRoute(localSession);
  if (!route.machineCode) throw new Error('NO_TARGET_BOUND');
  const target = registry.resolve(route.machineCode);
  if (!target) throw new Error('current target is unavailable');
  return target;
}

function localSessionHandle() {
  return `rsh_${crypto.randomUUID().replaceAll('-', '')}`;
}

function localExecHandle(localSession) {
  const handle = localSession.nextExecHandleId;
  localSession.nextExecHandleId += 1;
  return handle;
}

function upstreamSessionHandle() {
  return `router_${crypto.randomUUID().replaceAll('-', '')}`;
}

function withToolHandle(args, handle) {
  const rewritten = { ...(args || {}) };
  delete rewritten.sessionId;
  rewritten.session_id = handle;
  return rewritten;
}

function rewriteHandleFields(value, upstreamHandle, localHandle) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteHandleFields(entry, upstreamHandle, localHandle));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (
      (key === 'session_id' || key === 'sessionId') &&
      (typeof entry === 'string' || typeof entry === 'number') &&
      String(entry) === upstreamHandle
    ) {
      return [key, localHandle];
    }
    return [key, rewriteHandleFields(entry, upstreamHandle, localHandle)];
  }));
}

function prepareForwardedRpc(localSession, rpc) {
  if (rpc.method !== 'tools/call') return { rpc, handleContext: null };
  const name = rpc.params?.name;
  const route = effectiveRoute(localSession);
  let args = rpc.params?.arguments || {};
  let handleContext = null;

  if (name === 'write_stdin' && args.chars === undefined && args.content !== undefined) {
    args = { ...args, chars: args.content };
    delete args.content;
  }

  if (HANDLE_CONSUMERS.has(name)) {
    const localHandleKey = toolHandle(args);
    if (!localHandleKey) throw new ToolRoutingError(`${name} requires a session handle`);
    const binding = localSession.handles.get(localHandleKey);
    if (!binding) throw new ToolRoutingError(`unknown or stale session handle: ${localHandleKey}`);
    if (
      binding.machineCode !== route.machineCode ||
      binding.generation !== route.generation
    ) {
      localSession.handles.delete(localHandleKey);
      throw new ToolRoutingError(`unknown or stale session handle: ${localHandleKey}`);
    }
    args = withToolHandle(args, binding.upstreamValue ?? binding.upstreamHandle);
    handleContext = {
      kind: 'consumer',
      localHandle: binding.localValue ?? localHandleKey,
      localHandleKey,
      upstreamHandle: binding.upstreamHandle,
    };
  } else if (HANDLE_PRODUCERS.has(name)) {
    const requestedLocalHandle = toolHandle(args);
    if (requestedLocalHandle && localSession.handles.has(requestedLocalHandle)) {
      throw new ToolRoutingError(`session handle already exists: ${requestedLocalHandle}`);
    }
    if (name === 'exec_session') {
      const localHandle = requestedLocalHandle || localSessionHandle();
      const requestedUpstreamHandle = upstreamSessionHandle();
      args = withToolHandle(args, requestedUpstreamHandle);
      handleContext = {
        kind: 'producer',
        localHandle,
        localHandleKey: String(localHandle),
        requestedUpstreamHandle,
      };
    } else {
      const localHandle = localExecHandle(localSession);
      handleContext = {
        kind: 'producer',
        localHandle,
        localHandleKey: String(localHandle),
        requestedUpstreamHandle: null,
      };
    }
  }

  return {
    rpc: {
      ...rpc,
      params: { ...rpc.params, name, arguments: args },
    },
    handleContext,
  };
}

function rewriteForwardedResponse(localSession, originalRpc, handleContext, responseBody) {
  if (!handleContext) return responseBody;
  let payload;
  try {
    payload = JSON.parse(responseBody.toString('utf8'));
  } catch {
    return responseBody;
  }
  const result = payload?.result;
  if (!result || result.isError) return responseBody;
  const content = result.structuredContent || {};
  const route = effectiveRoute(localSession);
  const name = originalRpc.params?.name;

  if (handleContext.kind === 'producer') {
    const returnedUpstreamValue = toolHandleValue(content);
    const returnedUpstreamHandle = toolHandle(content);
    if (returnedUpstreamHandle) {
      const localHandle = handleContext.localHandle ?? localSessionHandle();
      const localHandleKey = handleContext.localHandleKey ?? String(localHandle);
      localSession.handles.set(localHandleKey, {
        localValue: localHandle,
        upstreamHandle: returnedUpstreamHandle,
        upstreamValue: returnedUpstreamValue,
        machineCode: route.machineCode,
        generation: route.generation,
      });
      payload.result = rewriteHandleFields(result, returnedUpstreamHandle, localHandle);
    }
  } else {
    payload.result = rewriteHandleFields(
      result,
      handleContext.upstreamHandle,
      handleContext.localHandle,
    );
    if (
      handleContext.localHandle &&
      (
        name === 'kill_session' ||
        content.closed === true ||
        (name === 'write_stdin' && toolHandle(content) === null && content.exit_code !== undefined)
      )
    ) {
      localSession.handles.delete(handleContext.localHandleKey ?? String(handleContext.localHandle));
    }
  }
  return Buffer.from(JSON.stringify(payload));
}

async function forwardRpc(req, rpc, body, localSession, target) {
  let upstreamSession = await ensureUpstreamSession(localSession, target);
  const prepared = prepareForwardedRpc(localSession, rpc);
  const upstreamBody = Buffer.from(JSON.stringify(prepared.rpc));
  const readOnly = isReadOnlyRpc(rpc.method, rpc.params);
  const send = async () => {
    const targetAdapter = upstreamSession.target || target;
    const response = await fetchUpstream(targetAdapter, {
      method: 'POST',
      headers: upstreamHeaders(targetAdapter, {
        accept: req.headers.accept || 'application/json',
        contentType: req.headers['content-type'] || 'application/json',
        sessionId: upstreamSession.sessionId,
      }),
      body: upstreamBody,
    }, readOnly, upstreamRpcTimeout(rpc.method, rpc.params));
    return {
      response,
      responseBody: Buffer.from(await response.arrayBuffer()),
    };
  };
  let forwarded = await send();
  if (readOnly && isExpiredUpstreamSession(forwarded.response, forwarded.responseBody)) {
    discardExpiredUpstreamSession(localSession, upstreamSession);
    upstreamSession = await ensureUpstreamSession(localSession, target);
    forwarded = await send();
  }
  let responseBody = forwarded.responseBody;
  const nextUpstreamSession = forwarded.response.headers.get('mcp-session-id');
  if (nextUpstreamSession) upstreamSession.sessionId = nextUpstreamSession;
  if (forwarded.response.status >= 200 && forwarded.response.status < 300) {
    responseBody = rewriteForwardedResponse(
      localSession,
      rpc,
      prepared.handleContext,
      responseBody,
    );
  }
  return {
    status: forwarded.response.status,
    contentType: forwarded.response.headers.get('content-type') || 'application/json',
    body: responseBody,
  };
}

function isExpiredUpstreamSession(response, responseBody) {
  if (response.status !== 404) return false;
  try {
    const error = JSON.parse(responseBody.toString('utf8'))?.error;
    return error?.code === -32001 || /mcp[- ]session/i.test(String(error?.message || ''));
  } catch {
    return false;
  }
}

function discardExpiredUpstreamSession(localSession, upstreamSession) {
  if (localSession.activeUpstream?.session === upstreamSession) {
    localSession.activeUpstream = null;
  }
  localSession.handles.clear();
  persistThreadSession(localSession);
}

async function closeLocalSession(localSessionId) {
  const localSession = sessions.get(localSessionId);
  if (!localSession) return false;
  localSession.closing = true;
  sessions.delete(localSessionId);
  closedSessionIds.add(localSessionId);
  flushRouterState();
  if (localSession.threadId && threadSessions.get(localSession.threadId) === localSessionId) {
    const replacement = [...sessions.values()].reverse().find(
      (candidate) => candidate.threadId === localSession.threadId,
    );
    if (replacement) {
      threadSessions.set(localSession.threadId, replacement.id);
      persistThreadSession(replacement);
    } else {
      threadSessions.delete(localSession.threadId);
    }
  }
  await localSession.gate.closeAndWait().catch(() => {});
  if (localSession.pendingUpstream?.promise) {
    await localSession.pendingUpstream.promise.catch(() => {});
  }
  const upstreams = new Set(localSession.retiredUpstreams);
  if (localSession.activeUpstream?.session) {
    upstreams.add(localSession.activeUpstream.session);
  }
  localSession.activeUpstream = null;
  localSession.handles.clear();
  await Promise.allSettled([...upstreams].map(closeUpstreamSession));
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, {
      ok: true,
      name: 'remote-router',
      registered_targets: registry.targets().length,
      discovered_targets: registry.discoveredTargets(null).length,
      sessions: sessions.size,
      health_check_interval_ms: ROUTER_HEALTH_CHECK_INTERVAL_MS,
      health_checks_running: targetChecks.size,
      target_health: healthSummary(),
    });
    return;
  }

  if (req.url === '/mcp' && !hasValidLocalBearerToken(req)) {
    res.setHeader('www-authenticate', 'Bearer');
    writeJson(res, 401, { error: 'valid bearer token required' });
    return;
  }

  if (req.method === 'DELETE' && req.url === '/mcp') {
    const localSessionId = String(req.headers['mcp-session-id'] || '');
    if (!await closeLocalSession(localSessionId)) {
      writeJson(res, 404, { error: 'unknown or missing Mcp-Session-Id' });
      return;
    }
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    writeJson(res, 404, { error: 'Use POST /mcp for the remote MCP endpoint.' });
    return;
  }

  let rpc;
  try {
    const body = await readBody(req);
    rpc = parseRpcBody(body);
    if (!rpc || typeof rpc.method !== 'string') {
      writeJson(res, 400, jsonRpcError(null, -32700, 'invalid JSON-RPC request'));
      return;
    }

    if (rpc.method === 'initialize') {
      const localSessionId = crypto.randomUUID();
      const lineageEnabled = String(req.headers['x-codex-route-lineage'] || '') === 'current';
      const threadId = lineageEnabled
        ? String(req.headers['x-codex-thread-id'] || '').trim() || null
        : null;
      const parentThreadId = threadId
        ? String(req.headers['x-codex-parent-thread-id'] || '').trim() || null
        : null;
      if (threadId && !threadSessions.has(threadId)) restoreThreadRoute(threadId);
      if (parentThreadId && !threadSessions.has(parentThreadId)) {
        restoreThreadRoute(parentThreadId);
      }
      const previousSessionId = threadId ? threadSessions.get(threadId) : null;
      const previousSession = previousSessionId ? sessions.get(previousSessionId) : null;
      if (previousSession && previousSession.parentThreadId !== parentThreadId) {
        throw new Error('thread parent lineage changed across MCP sessions');
      }
      const routeMode = previousSession?.routeMode || (parentThreadId ? 'inherited' : 'owner');
      const localSession = {
        id: localSessionId,
        initializeParams: rpc.params || {},
        threadId,
        parentThreadId,
        routeMode,
        routeGroup:
          routeMode === 'inherited'
            ? null
            : previousSession?.routeGroup
              ? previousSession.routeGroup
              : { machineCode: null, generation: 0 },
        observedRoute: null,
        activeUpstream: null,
        pendingUpstream: null,
        retiredUpstreams: new Set(),
        handles: new Map(),
        nextExecHandleId: 1,
        gate: new SessionGate(),
      };
      localSession.observedRoute = { ...effectiveRoute(localSession) };
      sessions.set(localSessionId, localSession);
      if (threadId) threadSessions.set(threadId, localSessionId);
      try {
        await ensureCanonicalToolContract(localSession.initializeParams);
        persistThreadSession(localSession);
        writeJson(res, 200, jsonRpcResult(rpc.id, {
          protocolVersion: rpc.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'remote-router',
            title: 'Agent-Native Remote',
            version: '0.1.0',
            description: 'Session-scoped router for agent-native remote computer targets.',
          },
        }), localSessionId);
        if (previousSession) await closeLocalSession(previousSession.id);
      } catch (error) {
        sessions.delete(localSessionId);
        if (threadId && threadSessions.get(threadId) === localSessionId) {
          if (previousSession) threadSessions.set(threadId, previousSession.id);
          else threadSessions.delete(threadId);
        }
        throw error;
      }
      return;
    }

    const localSessionId = String(req.headers['mcp-session-id'] || '');
    const localSession = sessions.get(localSessionId) || await recoverLocalSession(
      req,
      localSessionId,
    );
    if (!localSession) {
      console.warn(JSON.stringify({
        event: 'unknown-local-session',
        present: Boolean(localSessionId),
        length: localSessionId.length,
        method: rpc.method,
        tool: rpc.params?.name || null,
      }));
      writeJson(
        res,
        404,
        jsonRpcError(rpc.id, -32001, 'unknown or missing Mcp-Session-Id'),
      );
      return;
    }

    if (rpc.id === undefined || rpc.id === null) {
      res.writeHead(202, { 'cache-control': 'no-store', 'mcp-session-id': localSessionId });
      res.end();
      return;
    }

    if (rpc.method === 'ping') {
      writeJson(res, 200, jsonRpcResult(rpc.id, {}), localSessionId);
      return;
    }

    if (rpc.method === 'tools/list') {
      writeJson(res, 200, jsonRpcResult(rpc.id, {
        tools: [...CONTROL_TOOLS, ...(canonicalBusinessTools || [])],
        nextCursor: null,
      }), localSessionId);
      return;
    }

    if (rpc.method === 'tools/call' && CONTROL_TOOL_NAMES.has(rpc.params?.name)) {
      const lock = rpc.params.name === 'router_connect' ? withSessionExclusive : withSessionShared;
      const result = await lock(
        localSession,
        () => handleControlCall(
          localSession,
          rpc.params.name,
          rpc.params.arguments || {},
        ),
      );
      writeJson(res, 200, jsonRpcResult(rpc.id, result), localSessionId);
      return;
    }

    const outcome = await withSessionShared(localSession, async () => {
      let target;
      try {
        target = targetForToolCall(localSession, rpc);
      } catch (error) {
        if (rpc.method === 'tools/call') {
          return {
            kind: 'json',
            status: 200,
            payload: jsonRpcResult(
              rpc.id,
              toolResult({ ok: false, error: error.message }, true),
            ),
          };
        }
        throw error;
      }
      if (!target) {
        return {
          kind: 'json',
          status: 409,
          payload: jsonRpcError(rpc.id, -32002, 'current target is unavailable'),
        };
      }

      const longExecArgs = maybeLongExec(rpc);
      if (longExecArgs) {
        const structuredContent = await runLongExec(localSession, target, longExecArgs);
        return {
          kind: 'json',
          status: 200,
          payload: jsonRpcResult(rpc.id, {
            content: [],
            structuredContent,
            isError: false,
            _meta: CODE_MODE_RESULT_META,
          }),
        };
      }

      try {
        return {
          kind: 'forward',
          forwarded: await forwardRpc(req, rpc, body, localSession, target),
        };
      } catch (error) {
        if (error instanceof ToolRoutingError && rpc.method === 'tools/call') {
          return {
            kind: 'json',
            status: 200,
            payload: jsonRpcResult(
              rpc.id,
              toolResult({ ok: false, error: error.message }, true),
            ),
          };
        }
        throw error;
      }
    });
    if (outcome.kind === 'json') {
      writeJson(res, outcome.status, outcome.payload, localSessionId);
      return;
    }
    res.writeHead(outcome.forwarded.status, {
      'content-type': outcome.forwarded.contentType,
      'cache-control': 'no-store',
      'mcp-session-id': localSessionId,
    });
    res.end(outcome.forwarded.body);
  } catch (error) {
    writeJson(
      res,
      502,
      jsonRpcError(rpc?.id, -32000, `Agent remote MCP router failed: ${error.message}`),
    );
  }
});

server.listen(port, host, () => {
  console.log(`Agent remote MCP router listening on http://${host}:${port}/mcp`);
  console.log(`Registered ${registry.targets().length} remote target adapter(s)`);
  console.log(`Persistent state: ${routerStateFile}`);
});

const healthTimer = setInterval(() => {
  runHealthSweep();
}, ROUTER_HEALTH_CHECK_INTERVAL_MS);
healthTimer.unref?.();
