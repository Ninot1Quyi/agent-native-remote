import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const proxyScript = fileURLToPath(new URL('./remote-mcp-router.mjs', import.meta.url));
const LOCAL_BEARER_TOKEN = 'router-local-test-token-0123456789abcdef0123456789abcdef';

const BUSINESS_TOOLS = [
  tool('whoami', true),
  tool('health', true),
  tool('list', true),
  tool('search', true),
  tool('read_session', true),
  tool('exec', false),
  tool('exec_command', false),
  tool('exec_session', false),
  tool('write_stdin', false),
  tool('kill_session', false),
  tool('read', true),
];

function machineCode(name) {
  const character = name === 'beta' ? 'b' : name === 'same' ? 'c' : 'a';
  return `rmc_${character.repeat(32)}`;
}

function tool(name, readOnly) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    annotations: { readOnlyHint: readOnly },
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function createUpstream(name, behavior = {}) {
  const remoteMachineCode = behavior.machineCode || machineCode(name);
  const remoteRoot = behavior.root || `/workspace/${name}`;
  const state = {
    initializeCount: 0,
    toolCounts: new Map(),
    requests: [],
    deletedSessions: [],
  };
  let serialized = Promise.resolve();
  const enqueue = (work) => {
    if (!behavior.serialize) return work();
    const run = serialized.then(work, work);
    serialized = run.catch(() => {});
    return run;
  };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      state.deletedSessions.push(String(request.headers['mcp-session-id'] || ''));
      response.writeHead(204);
      response.end();
      return;
    }
    if (behavior.availabilityFile) {
      const availability = await readFile(behavior.availabilityFile, 'utf8').catch(() => 'down');
      if (availability.trim() !== 'healthy') {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('temporarily unavailable');
        return;
      }
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sessionId = String(request.headers['mcp-session-id'] || '');
    state.requests.push({
      method: rpc.method,
      name: rpc.params?.name,
      arguments: rpc.params?.arguments,
      sessionId,
      authorization: String(request.headers.authorization || ''),
      origin: String(request.headers.origin || ''),
    });

    await enqueue(async () => {
    if (rpc.method === 'initialize') {
      if (behavior.initializeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.initializeDelayMs));
      }
      state.initializeCount += 1;
      const newSessionId = `up-${name}-${state.initializeCount}`;
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': newSessionId,
      });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name, version: 'test', machineCode: remoteMachineCode },
      })));
      return;
    }

    if (rpc.method === 'tools/list') {
      if (behavior.listDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.listDelayMs));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        tools: behavior.tools || BUSINESS_TOOLS,
        nextCursor: null,
      })));
      return;
    }

    const toolName = rpc.params?.name;
    state.toolCounts.set(toolName, (state.toolCounts.get(toolName) || 0) + 1);
    const handled = await behavior.call?.({ request, response, rpc, sessionId, state });
    if (handled) return;

    if (toolName === 'health') {
      if (behavior.healthDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.healthDelayMs));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: behavior.healthContent || {
          machineCode: remoteMachineCode,
          root: remoteRoot,
          rootIsDirectory: true,
        },
        isError: false,
      })));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(rpcResult(rpc.id, {
      content: [],
      structuredContent: { machine: name, upstream_session: sessionId },
      isError: false,
    })));
    });
  });
  const port = await listen(server);
  return {
    name,
    port,
    state,
    server,
    target: {
      ref: name,
      upstream: `http://127.0.0.1:${port}/mcp`,
    },
  };
}

async function startRouter(targets, extraEnv = {}) {
  const port = await freePort();
  const configuredStateFile = extraEnv.AGENT_REMOTE_MCP_STATE_FILE;
  const ownedStateDirectory = configuredStateFile
    ? null
    : await mkdtemp(path.join(os.tmpdir(), 'remote-router-state-'));
  const stateFile = configuredStateFile || path.join(ownedStateDirectory, 'router-state.json');
  const bearerTokenFile = extraEnv.AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE ||
    path.join(path.dirname(stateFile), 'router-bearer-token');
  try {
    await readFile(stateFile, 'utf8');
  } catch {
    await writeFile(stateFile, `${JSON.stringify({
      version: 1,
      targets: targets.map((target) => ({ ...target, kind: target.kind || 'http-mcp' })),
      threads: {},
    }, null, 2)}\n`, { mode: 0o600 });
    await chmod(stateFile, 0o600);
  }
  try {
    await readFile(bearerTokenFile, 'utf8');
  } catch {
    await writeFile(bearerTokenFile, `${LOCAL_BEARER_TOKEN}\n`, { mode: 0o600 });
    await chmod(bearerTokenFile, 0o600);
  }
  const child = spawn(process.execPath, [proxyScript], {
    env: {
      ...process.env,
      AGENT_REMOTE_MCP_STATE_FILE: stateFile,
      AGENT_REMOTE_MCP_LOCAL_LISTEN: `127.0.0.1:${port}`,
      AGENT_REMOTE_MCP_UPSTREAM_PROBE_TIMEOUT_MS: '500',
      ...extraEnv,
      AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: bearerTokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.includes('Agent remote MCP router listening')) {
      return { child, port, stateFile, ownedStateDirectory };
    }
    if (child.exitCode !== null) {
      if (ownedStateDirectory) await rm(ownedStateDirectory, { recursive: true, force: true });
      throw new Error(`router exited early with ${child.exitCode}: ${output}${errors}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`router did not start: ${output}${errors}`);
}

async function request(port, method, params = {}, sessionId, extraHeaders = {}) {
  const id = `${method}-${Math.random()}`;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${LOCAL_BEARER_TOKEN}`,
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    payload,
    text,
  };
}

async function initialize(port, headers = {}) {
  const response = await request(port, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'router-test', version: '1' },
  }, undefined, headers);
  assert.equal(response.status, 200);
  assert.match(response.sessionId, /^[0-9a-f-]{36}$/);
  return response.sessionId;
}

async function callTool(port, sessionId, name, args = {}, extraHeaders = {}) {
  return request(port, 'tools/call', { name, arguments: args }, sessionId, extraHeaders);
}

async function connectSession(port, sessionId, targetRef) {
  const response = await callTool(port, sessionId, 'router_connect', { target_ref: targetRef });
  assert.equal(response.status, 200);
  assert.equal(response.payload.result.isError, false);
  return response;
}

async function deleteSession(port, sessionId) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${LOCAL_BEARER_TOKEN}`,
      'mcp-session-id': sessionId,
    },
  });
}

async function stopRouter(router) {
  if (router.child.exitCode === null) router.child.kill('SIGTERM');
  await Promise.race([
    once(router.child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (router.ownedStateDirectory) {
    await rm(router.ownedStateDirectory, { recursive: true, force: true });
  }
}

async function closeUpstreams(...upstreams) {
  await Promise.all(upstreams.map(
    (upstream) => new Promise((resolve) => upstream.server.close(resolve)),
  ));
}

async function waitUntil(check, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for router health monitor');
}

test('starts with an empty target registry and exposes only control tools', async () => {
  const router = await startRouter([]);
  try {
    const session = await initialize(router.port);
    const tools = await request(router.port, 'tools/list', {}, session);
    assert.deepEqual(tools.payload.result.tools.map((entry) => entry.name), [
      'router_list',
      'router_connect',
      'router_status',
    ]);
    for (const entry of tools.payload.result.tools) {
      assert.equal(entry._meta['codex/codeModeResult'], 'structuredContent');
      assert.ok(entry.outputSchema);
    }

    const available = await callTool(router.port, session, 'router_list');
    assert.deepEqual(available.payload.result.structuredContent.targets, []);
    assert.equal(
      available.payload.result._meta['codex/codeModeResult'],
      'structuredContent',
    );

    const status = await callTool(router.port, session, 'router_status');
    assert.equal(status.payload.result.structuredContent.machine_code, null);
  } finally {
    await stopRouter(router);
  }
});

test('repairs only the failed SSH target during a health sweep', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'router-ssh-health-monitor-'));
  const stateFile = path.join(root, 'router-state.json');
  const alphaAvailability = path.join(root, 'alpha-availability');
  const betaAvailability = path.join(root, 'beta-availability');
  const repairLog = path.join(root, 'repair.log');
  const fakeStarter = path.join(root, 'fake-ssh-starter.mjs');
  await writeFile(alphaAvailability, 'healthy\n');
  await writeFile(betaAvailability, 'healthy\n');
  await writeFile(fakeStarter, `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(repairLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--ref' && args[1] === 'alpha') {
  fs.writeFileSync(${JSON.stringify(alphaAvailability)}, 'healthy\\n');
  process.exit(0);
}
process.exit(2);
`);
  const alpha = await createUpstream('alpha', { availabilityFile: alphaAvailability });
  const beta = await createUpstream('beta', { availabilityFile: betaAvailability });
  const router = await startRouter([
    { ...alpha.target, kind: 'ssh-server' },
    { ...beta.target, kind: 'ssh-server' },
  ], {
    NODE_ENV: 'test',
    AGENT_REMOTE_MCP_STATE_FILE: stateFile,
    AGENT_REMOTE_MCP_HEALTH_CHECK_INTERVAL_MS: '50',
    AGENT_REMOTE_MCP_TEST_SSH_TUNNEL_STARTER: fakeStarter,
  });
  try {
    const session = await initialize(router.port);
    await writeFile(alphaAvailability, 'down\n');
    await waitUntil(async () => {
      try {
        return (await readFile(repairLog, 'utf8')).trim().length > 0;
      } catch {
        return false;
      }
    });
    const repairs = (await readFile(repairLog, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(repairs, [['--ref', 'alpha']]);
    const connected = await connectSession(router.port, session, 'beta');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('beta'));
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
    await rm(root, { recursive: true, force: true });
  }
});

test('lists and connects a target by its persistent user-facing name', async () => {
  const alpha = await createUpstream('alpha');
  const router = await startRouter([{
    ...alpha.target,
    name: '我的测试机',
    aliases: ['test-main'],
  }]);
  try {
    const session = await initialize(router.port);
    const listed = await callTool(router.port, session, 'router_list');
    assert.deepEqual(listed.payload.result.structuredContent.targets[0], {
      name: '我的测试机',
      target_ref: 'alpha',
      kind: 'http-mcp',
      machine_code: machineCode('alpha'),
      selected: false,
    });

    const connected = await connectSession(router.port, session, '我的测试机');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('alpha'));
    const byAlias = await connectSession(router.port, session, 'test-main');
    assert.equal(byAlias.payload.result.structuredContent.machine_code, machineCode('alpha'));

    const persisted = JSON.parse(await readFile(router.stateFile, 'utf8'));
    const target = persisted.targets.find((entry) => entry.ref === 'alpha');
    assert.equal(target.name, '我的测试机');
    assert.deepEqual(target.aliases, ['test-main']);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('uses the HTTP MCP discovery timeout for slow HTTP upstream initialization', async () => {
  const alpha = await createUpstream('alpha', { initializeDelayMs: 800 });
  const router = await startRouter([{ ...alpha.target, kind: 'http-mcp' }], {
    AGENT_REMOTE_MCP_HTTP_DISCOVERY_TIMEOUT_MS: '1500',
  });

  try {
    const session = await initialize(router.port);
    assert.match(session, /^[0-9a-f-]{36}$/);
    assert.equal(alpha.state.initializeCount, 1);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('keeps slow SSH discovery on the short probe timeout', async () => {
  const alpha = await createUpstream('alpha', { initializeDelayMs: 800 });
  const router = await startRouter([{ ...alpha.target, kind: 'ssh-server' }]);

  try {
    const response = await request(router.port, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'router-test', version: '1' },
    });
    assert.equal(response.status, 502);
    assert.match(response.payload.error.message, /no registered target could provide the remote tool contract/i);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('keeps health open and requires the local bearer token for every MCP request', async () => {
  const router = await startRouter([]);
  const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'router-auth-test', version: '1' },
    },
  });
  try {
    const health = await fetch(`http://127.0.0.1:${router.port}/health`);
    assert.equal(health.status, 200);

    const missing = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: initializeBody,
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');

    const wrong = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer definitely-the-wrong-local-router-token',
        'content-type': 'application/json',
      },
      body: initializeBody,
    });
    assert.equal(wrong.status, 401);

    const unauthenticatedDelete = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'not-a-session' },
    });
    assert.equal(unauthenticatedDelete.status, 401);

    const session = await initialize(router.port);
    assert.match(session, /^[0-9a-f-]{36}$/);
  } finally {
    await stopRouter(router);
  }
});

test('isolates two local sessions, reconnects only the caller, and keeps a fixed tool list', async () => {
  const alpha = await createUpstream('alpha');
  const beta = await createUpstream('beta');
  const router = await startRouter([alpha.target, { ...beta.target, kind: 'http-mcp' }]);

  try {
    const sessionA = await initialize(router.port);
    const sessionB = await initialize(router.port);
    assert.notEqual(sessionA, sessionB);
    assert.equal(alpha.state.initializeCount, 1);
    assert.ok(
      alpha.state.requests
        .filter((entry) => entry.sessionId)
        .every((entry) => entry.sessionId !== sessionA && entry.sessionId !== sessionB),
    );
    const unbound = await callTool(router.port, sessionA, 'whoami');
    assert.equal(unbound.payload.result.isError, true);
    assert.equal(unbound.payload.result.structuredContent.error, 'NO_TARGET_BOUND');

    await connectSession(router.port, sessionA, 'alpha');
    await connectSession(router.port, sessionB, 'alpha');
    const sameTargetA = await callTool(router.port, sessionA, 'whoami');
    const sameTargetB = await callTool(router.port, sessionB, 'whoami');
    assert.equal(sameTargetA.payload.result.structuredContent.machine, 'alpha');
    assert.equal(sameTargetB.payload.result.structuredContent.machine, 'alpha');
    assert.notEqual(
      sameTargetA.payload.result.structuredContent.upstream_session,
      sameTargetB.payload.result.structuredContent.upstream_session,
    );

    const beforeList = await request(router.port, 'tools/list', {}, sessionA);
    assert.equal(beforeList.status, 200);
    const names = beforeList.payload.result.tools.map((entry) => entry.name);
    assert.deepEqual(names.slice(0, 3), ['router_list', 'router_connect', 'router_status']);
    assert.equal(names.filter((name) => ['router_list', 'router_connect', 'router_status'].includes(name)).length, 3);
    assert.deepEqual(
      names.slice(3),
      BUSINESS_TOOLS.map((entry) => entry.name).sort(),
    );
    assert.equal(new Set(names).size, names.length);

    const available = await callTool(router.port, sessionA, 'router_list');
    const alphaTarget = available.payload.result.structuredContent.targets.find(
      (target) => target.target_ref === 'alpha',
    );
    const betaTarget = available.payload.result.structuredContent.targets.find(
      (target) => target.target_ref === 'beta',
    );
    assert.equal(alphaTarget.machine_code, machineCode('alpha'));
    assert.equal(alphaTarget.kind, 'http-mcp');
    assert.equal(betaTarget.machine_code, null);
    assert.equal(betaTarget.kind, 'http-mcp');
    assert.doesNotMatch(JSON.stringify(available.payload), /temporary-/);

    const connected = await connectSession(router.port, sessionA, 'beta');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('beta'));
    assert.equal(connected.payload.result.structuredContent.generation, 2);
    const availableAfterConnect = await callTool(router.port, sessionA, 'router_list');
    assert.equal(
      availableAfterConnect.payload.result.structuredContent.targets.find(
        (target) => target.target_ref === 'beta',
      ).machine_code,
      machineCode('beta'),
    );

    const statusA = await callTool(router.port, sessionA, 'router_status');
    const statusB = await callTool(router.port, sessionB, 'router_status');
    assert.equal(statusA.payload.result.structuredContent.machine_code, machineCode('beta'));
    assert.equal(statusB.payload.result.structuredContent.machine_code, machineCode('alpha'));

    const whoA = await callTool(router.port, sessionA, 'whoami');
    const whoB = await callTool(router.port, sessionB, 'whoami');
    assert.equal(whoA.payload.result.structuredContent.machine, 'beta');
    assert.equal(whoB.payload.result.structuredContent.machine, 'alpha');

    const reconnectedB = await connectSession(router.port, sessionB, machineCode('beta'));
    assert.equal(reconnectedB.payload.result.structuredContent.machine_code, machineCode('beta'));
    const reconnectedA = await connectSession(router.port, sessionA, machineCode('alpha'));
    assert.equal(reconnectedA.payload.result.structuredContent.machine_code, machineCode('alpha'));

    const finalA = await callTool(router.port, sessionA, 'whoami');
    const finalB = await callTool(router.port, sessionB, 'whoami');
    assert.equal(finalA.payload.result.structuredContent.machine, 'alpha');
    assert.equal(finalB.payload.result.structuredContent.machine, 'beta');
    assert.notEqual(
      finalA.payload.result.structuredContent.upstream_session,
      finalB.payload.result.structuredContent.upstream_session,
    );

    const fileList = await callTool(router.port, sessionA, 'list', { path: '.' });
    assert.equal(fileList.status, 200);
    assert.equal(alpha.state.requests.at(-1).name, 'list');

    const afterList = await request(router.port, 'tools/list', {}, sessionB);
    assert.deepEqual(afterList.payload.result.tools, beforeList.payload.result.tools);
    assert.equal(beta.state.initializeCount, 2);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
  }
});

test('fails closed for a missing or unknown local Mcp-Session-Id', async () => {
  const alpha = await createUpstream('alpha');
  const router = await startRouter([alpha.target]);

  try {
    const missing = await request(router.port, 'tools/list');
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error.code, -32001);

    const unknown = await callTool(router.port, 'not-a-real-session', 'router_status');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.message, 'unknown or missing Mcp-Session-Id');
    assert.equal(alpha.state.requests.length, 0);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('treats a native SSH tunnel as a first-class ssh-server target', async () => {
  const server = await createUpstream('ssh-server');
  const router = await startRouter([{ ...server.target, kind: 'ssh-server' }]);

  try {
    const session = await initialize(router.port);
    const listed = await callTool(router.port, session, 'router_list');
    const target = listed.payload.result.structuredContent.targets.find(
      (entry) => entry.target_ref === 'ssh-server',
    );
    assert.equal(target.kind, 'ssh-server');
    const connected = await connectSession(router.port, session, 'ssh-server');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('ssh-server'));
  } finally {
    await stopRouter(router);
    await closeUpstreams(server);
  }
});

test('recovers a stale local session and selected route after a router restart', async () => {
  const alpha = await createUpstream('alpha');
  const beta = await createUpstream('beta');
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'remote-router-state-'));
  const stateFile = path.join(stateDirectory, 'router-state.json');
  const extraEnv = { AGENT_REMOTE_MCP_STATE_FILE: stateFile };
  const lineage = {
    'x-codex-route-lineage': 'current',
    'x-codex-thread-id': 'thread-restart',
  };
  let firstRouter;
  let secondRouter;

  try {
    firstRouter = await startRouter([alpha.target, beta.target], extraEnv);
    const staleSession = await initialize(firstRouter.port, lineage);
    const connected = await connectSession(firstRouter.port, staleSession, 'beta');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('beta'));
    await stopRouter(firstRouter);
    firstRouter = null;

    const persistedState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(persistedState.version, 1);
    assert.equal(
      persistedState.targets.find((target) => target.ref === 'beta').machineCode,
      machineCode('beta'),
    );
    assert.equal(persistedState.threads['thread-restart'].targetRef, 'beta');
    assert.equal(persistedState.threads['thread-restart'].machineCode, machineCode('beta'));
    assert.equal(persistedState.threads['thread-restart'].routeMode, 'owner');
    assert.equal('handles' in persistedState.threads['thread-restart'], false);
    assert.deepEqual(Object.keys(persistedState).sort(), ['targets', 'threads', 'version']);
    assert.equal(JSON.stringify(persistedState).includes(staleSession), false);
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

    secondRouter = await startRouter([alpha.target, beta.target], extraEnv);
    const recovered = await callTool(secondRouter.port, staleSession, 'router_status', {}, lineage);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.sessionId, staleSession);
    assert.equal(recovered.payload.result.structuredContent.machine_code, machineCode('beta'));
    assert.equal(recovered.payload.result.structuredContent.mode, 'owner');
  } finally {
    if (firstRouter) await stopRouter(firstRouter);
    if (secondRouter) await stopRouter(secondRouter);
    await closeUpstreams(alpha, beta);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('deletes only the requested local session and closes its layered upstream session', async () => {
  const alpha = await createUpstream('alpha');
  const router = await startRouter([alpha.target]);

  try {
    const sessionA = await initialize(router.port);
    const sessionB = await initialize(router.port);
    await connectSession(router.port, sessionA, 'alpha');
    await connectSession(router.port, sessionB, 'alpha');
    const deletedBefore = alpha.state.deletedSessions.length;
    const deleted = await deleteSession(router.port, sessionA);
    assert.equal(deleted.status, 204);
    assert.equal(alpha.state.deletedSessions.length, deletedBefore + 1);
    assert.equal(alpha.state.deletedSessions.at(-1), 'up-alpha-2');

    const deletedStatus = await callTool(router.port, sessionA, 'router_status');
    assert.equal(deletedStatus.status, 404);
    const survivingStatus = await callTool(router.port, sessionB, 'router_status');
    assert.equal(survivingStatus.status, 200);
    assert.equal(
      survivingStatus.payload.result.structuredContent.machine_code,
      machineCode('alpha'),
    );

    const missing = await deleteSession(router.port, 'not-a-real-session');
    assert.equal(missing.status, 404);
    assert.equal(alpha.state.deletedSessions.length, deletedBefore + 1);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('rejects the legacy single-upstream configuration', async () => {
  const alpha = await createUpstream('alpha');
  const upstream = `http://127.0.0.1:${alpha.port}/mcp`;
  const port = await freePort();
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'remote-router-no-legacy-'));
  const missingStateFile = path.join(stateDirectory, 'missing.json');
  const bearerTokenFile = path.join(stateDirectory, 'router-bearer-token');
  await writeFile(bearerTokenFile, `${LOCAL_BEARER_TOKEN}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [proxyScript], {
    env: {
      ...process.env,
      AGENT_REMOTE_MCP_LOCAL_LISTEN: `127.0.0.1:${port}`,
      AGENT_REMOTE_MCP_STATE_FILE: missingStateFile,
      AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: bearerTokenFile,
      AGENT_REMOTE_MCP_UPSTREAM: upstream,
      AGENT_REMOTE_MCP_TARGETS_JSON: JSON.stringify([alpha.target]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });

  try {
    const [exitCode] = await once(child, 'exit');
    assert.notEqual(exitCode, 0);
    assert.match(errors, /state file does not exist/);
    assert.equal(alpha.state.requests.length, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closeUpstreams(alpha);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('rejects missing credentials, unknown fields, and credential-bearing upstream URLs', async () => {
  const alpha = await createUpstream('alpha');
  try {
    await assert.rejects(
      startRouter([{ ...alpha.target, authorizationEnv: 'MISSING_ROUTER_TEST_TOKEN' }]),
      /target credential environment is missing/,
    );
    await assert.rejects(
      startRouter([{ ...alpha.target, cookie: 'inline-secret-is-forbidden' }]),
      /unknown field\(s\): cookie/,
    );
    await assert.rejects(
      startRouter([{ ...alpha.target, upstream: `http://user:pass@127.0.0.1:${alpha.port}/mcp` }]),
      /must not contain credentials/,
    );
    assert.equal(alpha.state.requests.length, 0);
  } finally {
    await closeUpstreams(alpha);
  }
});

test('inherits the parent route, detaches on child router_connect, and rejoins with router_connect main', async () => {
  const alpha = await createUpstream('alpha');
  const beta = await createUpstream('beta');
  const router = await startRouter([alpha.target, beta.target]);
  const lineage = { 'x-codex-route-lineage': 'current' };

  try {
    const main = await initialize(router.port, {
      ...lineage,
      'x-codex-thread-id': 'thread-main',
    });
    await connectSession(router.port, main, 'alpha');
    let child = await initialize(router.port, {
      ...lineage,
      'x-codex-thread-id': 'thread-child',
      'x-codex-parent-thread-id': 'thread-main',
    });

    const initialChild = await callTool(router.port, child, 'router_status');
    assert.equal(initialChild.payload.result.structuredContent.mode, 'inherited');
    assert.equal(initialChild.payload.result.structuredContent.machine_code, machineCode('alpha'));

    await callTool(router.port, main, 'router_connect', { target_ref: 'beta' });
    const followed = await callTool(router.port, child, 'router_status');
    assert.equal(followed.payload.result.structuredContent.machine_code, machineCode('beta'));
    assert.equal(followed.payload.result.structuredContent.mode, 'inherited');

    const detached = await callTool(router.port, child, 'router_connect', { target_ref: machineCode('alpha') });
    assert.equal(detached.payload.result.structuredContent.machine_code, machineCode('alpha'));
    assert.equal(detached.payload.result.structuredContent.mode, 'detached');
    const mainStillBeta = await callTool(router.port, main, 'router_status');
    assert.equal(mainStillBeta.payload.result.structuredContent.machine_code, machineCode('beta'));

    const rejectedOverride = await callTool(router.port, child, 'router_connect', {
      target_ref: machineCode('beta'),
      session_id: main,
    });
    assert.equal(rejectedOverride.payload.result.isError, true);
    const stillDetached = await callTool(router.port, child, 'router_status');
    assert.equal(stillDetached.payload.result.structuredContent.machine_code, machineCode('alpha'));
    const detachedGeneration = stillDetached.payload.result.structuredContent.generation;

    child = await initialize(router.port, {
      ...lineage,
      'x-codex-thread-id': 'thread-child',
      'x-codex-parent-thread-id': 'thread-main',
    });
    const detachedAfterReinitialize = await callTool(router.port, child, 'router_status');
    assert.equal(detachedAfterReinitialize.payload.result.structuredContent.mode, 'detached');
    assert.equal(detachedAfterReinitialize.payload.result.structuredContent.machine_code, machineCode('alpha'));
    assert.equal(detachedAfterReinitialize.payload.result.structuredContent.generation, detachedGeneration);

    const mismatchedParent = await request(router.port, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'router-test', version: '1' },
    }, undefined, {
      ...lineage,
      'x-codex-thread-id': 'thread-child',
      'x-codex-parent-thread-id': 'different-parent',
    });
    assert.equal(mismatchedParent.status, 502);

    const rejoined = await callTool(router.port, child, 'router_connect', { target_ref: 'main' });
    assert.equal(rejoined.payload.result.structuredContent.machine_code, machineCode('beta'));
    assert.equal(rejoined.payload.result.structuredContent.mode, 'inherited');

    await callTool(router.port, main, 'router_connect', { target_ref: machineCode('alpha') });
    const followedAgain = await callTool(router.port, child, 'router_status');
    assert.equal(followedAgain.payload.result.structuredContent.machine_code, machineCode('alpha'));

    child = await initialize(router.port, {
      ...lineage,
      'x-codex-thread-id': 'thread-child',
      'x-codex-parent-thread-id': 'thread-main',
    });
    const inheritedAfterReinitialize = await callTool(router.port, child, 'router_status');
    assert.equal(inheritedAfterReinitialize.payload.result.structuredContent.mode, 'inherited');
    assert.equal(inheritedAfterReinitialize.payload.result.structuredContent.machine_code, machineCode('alpha'));

    const rootCannotInherit = await callTool(router.port, main, 'router_connect', { target_ref: 'main' });
    assert.equal(rootCannotInherit.payload.result.isError, true);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
  }
});

test('deduplicates adapters by remote machineCode and reads authorization only from env', async () => {
  const first = await createUpstream('first', { machineCode: machineCode('same') });
  const second = await createUpstream('second', {
    machineCode: machineCode('same'),
    healthContent: { machine_code: machineCode('same'), root: '/workspace/second', rootIsDirectory: true },
  });
  const targets = [first.target, second.target].map((target) => ({
    ...target,
    authorizationEnv: 'ROUTER_TEST_TOKEN',
  }));
  const router = await startRouter(targets, { ROUTER_TEST_TOKEN: 'test-secret' });

  try {
    const session = await initialize(router.port);
    const connected = await callTool(router.port, session, 'router_connect', { target_ref: 'second' });
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('same'));
    const listed = await callTool(router.port, session, 'router_list');
    assert.equal(listed.payload.result.structuredContent.targets.length, 2);
    assert.ok(listed.payload.result.structuredContent.targets.every(
      (target) => target.machine_code === machineCode('same'),
    ));
    assert.ok(listed.payload.result.structuredContent.targets.every(
      (target) => assert.deepEqual(
        Object.keys(target).sort(),
        ['kind', 'machine_code', 'name', 'selected', 'target_ref'],
      ) === undefined,
    ));
    assert.doesNotMatch(
      JSON.stringify(listed.payload.result.structuredContent),
      /127\.0\.0\.1|workspace|test-secret/i,
    );

    const connectedAgain = await callTool(router.port, session, 'router_connect', { target_ref: 'second' });
    assert.equal(connectedAgain.payload.result.structuredContent.machine_code, machineCode('same'));
    assert.equal(first.state.initializeCount, 1);
    assert.equal(second.state.initializeCount, 1);
    assert.ok(first.state.requests.every((entry) => entry.authorization === 'Bearer test-secret'));
    assert.ok(second.state.requests.every((entry) => entry.authorization === 'Bearer test-secret'));
    assert.ok(first.state.requests.every((entry) => entry.origin === ''));
    assert.ok(second.state.requests.every((entry) => entry.origin === ''));
  } finally {
    await stopRouter(router);
    await closeUpstreams(first, second);
  }
});

test('virtualizes identical process handles per session and invalidates them on reconnect', async () => {
  const handleBehavior = (name) => ({
    call: ({ response, rpc }) => {
      const toolName = rpc.params?.name;
      if (!['exec_session', 'read_session', 'write_stdin', 'kill_session'].includes(toolName)) {
        return false;
      }
      const handle = rpc.params.arguments.session_id || 'handle-1';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: {
          machine: name,
          sessionId: handle,
          ...(toolName === 'read_session' ? { exited: true, closed: false, running: false } : {}),
          ...(toolName === 'kill_session' ? { running: false } : {}),
        },
        isError: false,
      })));
      return true;
    },
  });
  const alpha = await createUpstream('alpha', handleBehavior('alpha'));
  const beta = await createUpstream('beta', handleBehavior('beta'));
  const router = await startRouter([alpha.target, beta.target]);

  try {
    const sessionA = await initialize(router.port);
    const sessionB = await initialize(router.port);
    await connectSession(router.port, sessionA, 'alpha');
    await connectSession(router.port, sessionB, 'alpha');

    const startedA = await callTool(router.port, sessionA, 'exec_session', {
      cmd: 'sleep 10',
      session_id: 'same-local-handle',
    });
    const startedB = await callTool(router.port, sessionB, 'exec_session', {
      cmd: 'sleep 10',
      session_id: 'same-local-handle',
    });
    assert.equal(startedA.payload.result.structuredContent.sessionId, 'same-local-handle');
    assert.equal(startedB.payload.result.structuredContent.sessionId, 'same-local-handle');

    const upstreamStarts = alpha.state.requests.filter((entry) => entry.name === 'exec_session');
    const upstreamHandleA = upstreamStarts[0].arguments.session_id;
    const upstreamHandleB = upstreamStarts[1].arguments.session_id;
    assert.match(upstreamHandleA, /^router_[0-9a-f]{32}$/);
    assert.match(upstreamHandleB, /^router_[0-9a-f]{32}$/);
    assert.notEqual(upstreamHandleA, upstreamHandleB);

    const readA = await callTool(router.port, sessionA, 'read_session', {
      session_id: 'same-local-handle',
    });
    const readB = await callTool(router.port, sessionB, 'read_session', {
      session_id: 'same-local-handle',
    });
    assert.equal(readA.payload.result.structuredContent.sessionId, 'same-local-handle');
    assert.equal(readB.payload.result.structuredContent.sessionId, 'same-local-handle');
    const upstreamReads = alpha.state.requests.filter((entry) => entry.name === 'read_session');
    assert.equal(upstreamReads[0].arguments.session_id, upstreamHandleA);
    assert.equal(upstreamReads[1].arguments.session_id, upstreamHandleB);

    const drainAfterExit = await callTool(router.port, sessionA, 'read_session', {
      session_id: 'same-local-handle',
    });
    assert.equal(drainAfterExit.payload.result.isError, false);
    const readsAfterExit = alpha.state.requests.filter((entry) => entry.name === 'read_session');
    assert.equal(readsAfterExit[2].arguments.session_id, upstreamHandleA);

    const readsBeforeSwitch = alpha.state.toolCounts.get('read_session');
    const deletesBeforeSwitch = alpha.state.deletedSessions.length;
    await connectSession(router.port, sessionA, 'beta');
    assert.equal(alpha.state.deletedSessions.length, deletesBeforeSwitch + 1);
    const stale = await callTool(router.port, sessionA, 'read_session', {
      session_id: 'same-local-handle',
    });
    assert.equal(stale.payload.result.isError, true);
    assert.match(stale.payload.result.structuredContent.error, /unknown or stale/);
    assert.equal(alpha.state.toolCounts.get('read_session'), readsBeforeSwitch);
    assert.equal(beta.state.toolCounts.get('read_session') || 0, 0);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
  }
});

test('accepts metadata-only drift and compatible terminal/image schemas', async () => {
  const canonicalTools = [
    tool('health', true),
    {
      name: 'view_image',
      description: 'canonical image tool',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'remote path' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_stdin',
      inputSchema: {
        type: 'object',
        properties: {
          chars: { type: 'string' },
          content: { type: 'string' },
          session_id: { type: ['string', 'integer'] },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  ];
  const compatibleTools = [
    { ...tool('health', true), description: 'new health docs', _meta: { 'codex/codeModeResult': 'structuredContent' } },
    {
      name: 'view_image',
      _meta: { 'codex/codeModeResult': 'structuredContent' },
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['high', 'original'], description: 'optional detail' },
          path: { type: 'string', description: 'new remote path docs' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_stdin',
      _meta: { 'codex/codeModeResult': 'structuredContent' },
      inputSchema: {
        type: 'object',
        properties: {
          chars: { type: 'string', description: 'input bytes' },
          session_id: { type: 'integer', description: 'remote numeric handle' },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  ];
  const alpha = await createUpstream('alpha', { tools: canonicalTools });
  const beta = await createUpstream('beta', { tools: compatibleTools });
  const router = await startRouter([alpha.target, beta.target]);

  try {
    const session = await initialize(router.port);
    const connected = await callTool(router.port, session, 'router_connect', { target_ref: 'beta' });
    assert.equal(connected.payload.result.isError, false);
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('beta'));
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
  }
});

test('waits for in-flight business calls before reconnecting one local session', async () => {
  let markEntered;
  let releaseCall;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const release = new Promise((resolve) => { releaseCall = resolve; });
  const alpha = await createUpstream('alpha', {
    call: async ({ response, rpc, sessionId }) => {
      if (rpc.params?.name !== 'whoami') return false;
      markEntered();
      await release;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: { machine: 'alpha', upstream_session: sessionId },
        isError: false,
      })));
      return true;
    },
  });
  const beta = await createUpstream('beta');
  const router = await startRouter([alpha.target, beta.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const inFlight = callTool(router.port, session, 'whoami');
    await entered;
    const reconnect = connectSession(router.port, session, 'beta');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(beta.state.initializeCount, 0);

    releaseCall();
    const [completed, connected] = await Promise.all([inFlight, reconnect]);
    assert.equal(completed.payload.result.structuredContent.machine, 'alpha');
    assert.equal(connected.payload.result.structuredContent.machine_code, machineCode('beta'));
    const status = await callTool(router.port, session, 'router_status');
    assert.equal(status.payload.result.structuredContent.machine_code, machineCode('beta'));
  } finally {
    releaseCall();
    await stopRouter(router);
    await closeUpstreams(alpha, beta);
  }
});

test('runs independent business calls concurrently within one local session', async () => {
  let markSlowEntered;
  let releaseSlow;
  const slowEntered = new Promise((resolve) => { markSlowEntered = resolve; });
  const slowRelease = new Promise((resolve) => { releaseSlow = resolve; });
  const alpha = await createUpstream('alpha', {
    call: async ({ response, rpc, sessionId }) => {
      if (rpc.params?.name !== 'whoami') return false;
      if (rpc.params?.arguments?.slow === true) {
        markSlowEntered();
        await slowRelease;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: {
          machine: 'alpha',
          slow: rpc.params?.arguments?.slow === true,
          upstream_session: sessionId,
        },
        isError: false,
      })));
      return true;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const slow = callTool(router.port, session, 'whoami', { slow: true });
    await slowEntered;
    const fast = callTool(router.port, session, 'whoami', { slow: false });
    const fastResult = await Promise.race([
      fast,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('fast business call was serialized behind the slow call')),
        500,
      )),
    ]);
    assert.equal(fastResult.payload.result.structuredContent.slow, false);
    releaseSlow();
    const slowResult = await slow;
    assert.equal(slowResult.payload.result.structuredContent.slow, true);
  } finally {
    releaseSlow();
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('does not apply the short discovery timeout to normal tool calls', async () => {
  const alpha = await createUpstream('alpha', {
    call: async ({ response, rpc }) => {
      if (rpc.params?.name !== 'whoami') return false;
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: { machine: 'alpha', completed: true },
        isError: false,
      })));
      return true;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const result = await callTool(router.port, session, 'whoami');
    assert.equal(result.status, 200);
    assert.equal(result.payload.result.structuredContent.completed, true);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('preserves numeric unified-exec handles across the router', async () => {
  const alpha = await createUpstream('alpha', {
    call: ({ response, rpc }) => {
      const name = rpc.params?.name;
      if (name !== 'exec_command' && name !== 'write_stdin') return false;
      const structuredContent = name === 'exec_command'
        ? {
            chunk_id: 'remote-start',
            wall_time_seconds: 0.25,
            session_id: 73,
            original_token_count: 0,
            output: '',
          }
        : {
            chunk_id: 'remote-finish',
            wall_time_seconds: 0.5,
            exit_code: 0,
            original_token_count: 1,
            output: 'done',
          };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent,
        isError: false,
      })));
      return true;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const started = await callTool(router.port, session, 'exec_command', {
      cmd: 'sleep 1',
    });
    assert.equal(started.payload.result.structuredContent.session_id, 1);
    assert.equal(typeof started.payload.result.structuredContent.session_id, 'number');

    const completed = await callTool(router.port, session, 'write_stdin', {
      session_id: 1,
      content: '',
    });
    const upstreamWrite = alpha.state.requests.find((entry) => entry.name === 'write_stdin');
    assert.equal(upstreamWrite.arguments.session_id, 73);
    assert.equal(typeof upstreamWrite.arguments.session_id, 'number');
    assert.equal(upstreamWrite.arguments.chars, '');
    assert.equal('content' in upstreamWrite.arguments, false);
    assert.equal(completed.payload.result.structuredContent.exit_code, 0);
    assert.equal(completed.payload.result.structuredContent.output, 'done');

    const stale = await callTool(router.port, session, 'write_stdin', {
      session_id: 1,
      chars: '',
    });
    assert.equal(stale.payload.result.isError, true);
    assert.match(stale.payload.result.structuredContent.error, /unknown or stale/);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('retries transient failures only for truly read-only calls', async () => {
  const alpha = await createUpstream('alpha', {
    call: ({ response, rpc, state }) => {
      const name = rpc.params?.name;
      const count = state.toolCounts.get(name);
      if (name === 'exec_session') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(rpcResult(rpc.id, {
          content: [],
          structuredContent: { sessionId: 's1' },
          isError: false,
        })));
        return true;
      }
      if (name === 'search' && count < 3) {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('temporary gateway failure');
        return true;
      }
      if (name === 'read_session' || name === 'exec') {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('must not retry');
        return true;
      }
      return false;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const search = await callTool(router.port, session, 'search', { pattern: 'runner' });
    assert.equal(search.status, 200);
    assert.equal(alpha.state.toolCounts.get('search'), 3);

    const started = await callTool(router.port, session, 'exec_session', { cmd: 'sleep 1' });
    assert.equal(started.status, 200);
    const localHandle = started.payload.result.structuredContent.sessionId;
    assert.match(localHandle, /^rsh_[0-9a-f]{32}$/);
    const readSession = await callTool(router.port, session, 'read_session', { session_id: localHandle });
    assert.equal(readSession.status, 502);
    assert.equal(alpha.state.toolCounts.get('read_session'), 1);

    const exec = await callTool(router.port, session, 'exec', { cmd: 'true', timeout_ms: 30000 });
    assert.equal(exec.status, 502);
    assert.equal(alpha.state.toolCounts.get('exec'), 1);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('reopens an expired upstream session only for a read-only call', async () => {
  const alpha = await createUpstream('alpha', {
    call: ({ response, rpc, sessionId }) => {
      const name = rpc.params?.name;
      if (name === 'search' && sessionId === 'up-alpha-2') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32001, message: 'unknown or missing Mcp-Session-Id' },
        }));
        return true;
      }
      if (name === 'exec') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32001, message: 'unknown or missing Mcp-Session-Id' },
        }));
        return true;
      }
      return false;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const search = await callTool(router.port, session, 'search', { pattern: 'runner' });
    assert.equal(search.status, 200);
    assert.equal(alpha.state.initializeCount, 3);
    assert.equal(alpha.state.toolCounts.get('search'), 2);

    const exec = await callTool(router.port, session, 'exec', { cmd: 'true', timeout_ms: 30000 });
    assert.equal(exec.status, 404);
    assert.equal(alpha.state.initializeCount, 3);
    assert.equal(alpha.state.toolCounts.get('exec'), 1);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('aggregates long exec output through exec_session and read_session only', async () => {
  const alpha = await createUpstream('alpha', {
    call: ({ response, rpc, sessionId, state }) => {
      const name = rpc.params?.name;
      let structuredContent;
      if (name === 'exec_session') {
        structuredContent = { sessionId: 'remote-long-1', started: true };
      }
      if (name === 'read_session') {
        structuredContent = state.toolCounts.get(name) === 1
          ? {
            sessionId: 'remote-long-1',
            stdout: 'hello ',
            stderr: 'warn ',
            pty: '',
            exited: false,
            closed: false,
            exitCode: null,
          }
          : {
            sessionId: 'remote-long-1',
            stdout: 'world\n',
            stderr: 'done\n',
            pty: 'tty\n',
            exited: true,
            closed: true,
            exitCode: 7,
          };
      }
      if (!structuredContent) return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: { ...structuredContent, upstream_session: sessionId },
        isError: false,
      })));
      return true;
    },
  });
  const router = await startRouter([alpha.target]);

  try {
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const result = await callTool(router.port, session, 'exec', {
      cmd: 'printf done',
      timeout_ms: 60001,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.result.structuredContent, {
      exitCode: 7,
      timedOut: false,
      running: false,
      stdout: 'hello world\n',
      stderr: 'warn done\n',
      pty: 'tty\n',
      cwd: '/workspace/alpha',
    });
    const helperCalls = alpha.state.requests
      .filter((entry) => entry.method === 'tools/call' && entry.name !== 'health');
    assert.deepEqual(helperCalls.map((entry) => entry.name), [
      'exec_session',
      'read_session',
      'read_session',
    ]);
    assert.deepEqual([...new Set(helperCalls.map((entry) => entry.sessionId))], ['up-alpha-2']);
    assert.match(helperCalls[0].arguments.session_id, /^router-long-exec-/);
    assert.deepEqual(
      helperCalls.slice(1).map((entry) => entry.arguments.session_id),
      ['remote-long-1', 'remote-long-1'],
    );
    assert.deepEqual(
      helperCalls.filter((entry) => typeof entry.arguments?.cmd === 'string')
        .map((entry) => entry.arguments.cmd),
      ['printf done'],
    );
    assert.equal(helperCalls.some((entry) => entry.name === 'exec'), false);
    assert.equal(helperCalls.some((entry) => entry.name === 'kill_session'), false);
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});

test('times out long exec with one kill_session call and no shell kill command', async () => {
  const alpha = await createUpstream('alpha', {
    call: ({ response, rpc, sessionId, state }) => {
      const name = rpc.params?.name;
      let structuredContent;
      if (name === 'exec_session') {
        structuredContent = {
          sessionId: `remote-long-timeout-${state.toolCounts.get(name)}`,
          started: true,
        };
      }
      if (name === 'kill_session') {
        structuredContent = {
          sessionId: rpc.params.arguments.session_id,
          killed: state.toolCounts.get(name) !== 2,
        };
      }
      if (!structuredContent) return false;
      const isError = name === 'kill_session' && state.toolCounts.get(name) === 2;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rpcResult(rpc.id, {
        content: [],
        structuredContent: { ...structuredContent, upstream_session: sessionId },
        isError,
      })));
      return true;
    },
  });
  const clockDirectory = await mkdtemp(path.join(os.tmpdir(), 'remote-router-clock-'));
  const clockPreload = path.join(clockDirectory, 'advance-date.cjs');
  await writeFile(clockPreload, `
const realNow = Date.now.bind(Date);
let offset = 0;
const step = Number(process.env.AGENT_REMOTE_MCP_TEST_CLOCK_STEP_MS || 0);
Date.now = () => {
  const value = realNow() + offset;
  offset += step;
  return value;
};
`);
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${clockPreload}`]
    .filter(Boolean)
    .join(' ');
  let router;

  try {
    router = await startRouter([alpha.target], {
      NODE_OPTIONS: nodeOptions,
      AGENT_REMOTE_MCP_TEST_CLOCK_STEP_MS: '120000',
    });
    const session = await initialize(router.port);
    await connectSession(router.port, session, 'alpha');
    const result = await callTool(router.port, session, 'exec', {
      cmd: 'sleep forever',
      timeout_ms: 60001,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.result.structuredContent, {
      exitCode: null,
      timedOut: true,
      running: false,
      stdout: '',
      stderr: '',
      pty: '',
      cwd: '/workspace/alpha',
    });
    const helperCalls = alpha.state.requests
      .filter((entry) => entry.method === 'tools/call' && entry.name !== 'health');
    assert.deepEqual(helperCalls.map((entry) => entry.name), [
      'exec_session',
      'kill_session',
    ]);
    assert.deepEqual([...new Set(helperCalls.map((entry) => entry.sessionId))], ['up-alpha-2']);
    assert.equal(helperCalls[0].arguments.cmd, 'sleep forever');
    assert.equal(helperCalls[1].arguments.session_id, 'remote-long-timeout-1');
    assert.equal('cmd' in helperCalls[1].arguments, false);
    assert.equal(helperCalls.some((entry) => entry.name === 'exec'), false);
    assert.equal(helperCalls.some((entry) => /(?:^|[;&|])\s*(?:exec|kill)\b/.test(
      String(entry.arguments?.cmd || ''),
    )), false);

    const failedCleanup = await callTool(router.port, session, 'exec', {
      cmd: 'sleep failure',
      timeout_ms: 60001,
    });
    assert.equal(failedCleanup.status, 502);
    assert.equal(alpha.state.toolCounts.get('kill_session'), 2);
    const allHelperCalls = alpha.state.requests
      .filter((entry) => entry.method === 'tools/call' && entry.name !== 'health');
    assert.deepEqual(allHelperCalls.map((entry) => entry.name), [
      'exec_session',
      'kill_session',
      'exec_session',
      'kill_session',
    ]);
    assert.equal(allHelperCalls[3].arguments.session_id, 'remote-long-timeout-2');
    assert.equal('cmd' in allHelperCalls[3].arguments, false);
  } finally {
    if (router) await stopRouter(router);
    await closeUpstreams(alpha);
    await rm(clockDirectory, { recursive: true, force: true });
  }
});

test('serializes handshake RPCs so list and health do not share one timeout', async () => {
  const alpha = await createUpstream('alpha', {
    serialize: true,
    listDelayMs: 600,
    healthDelayMs: 600,
  });
  const router = await startRouter([alpha.target], {
    NODE_ENV: 'test',
    AGENT_REMOTE_MCP_HTTP_DISCOVERY_TIMEOUT_MS: '1500',
  });

  try {
    const session = await initialize(router.port);
    const connected = await connectSession(router.port, session, 'alpha');
    assert.equal(connected.status, 200);
    const whoami = await callTool(router.port, session, 'whoami');
    assert.equal(whoami.status, 200);
    assert.equal(whoami.payload.result.structuredContent.machine, 'alpha');
  } finally {
    await stopRouter(router);
    await closeUpstreams(alpha);
  }
});
