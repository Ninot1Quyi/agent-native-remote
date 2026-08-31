#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { mergedEnv, readRouterBearerToken, routerBearerTokenPath } from './env.mjs';

const [endpoint, targetRef, expectedMachineCode] = process.argv.slice(2);
if (!endpoint || !targetRef || !expectedMachineCode) {
  console.error('usage: test-router-ssh-full-tools.mjs <router-endpoint> <target-ref> <machine-code>');
  process.exit(2);
}
const env = mergedEnv();
const authorization = `Bearer ${readRouterBearerToken(routerBearerTokenPath(env))}`;

async function initialize(name) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-initialize`,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name, version: '1' },
      },
    }),
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId);
  return sessionId;
}

async function rpc(sessionId, method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  assert.equal(response.status, 200, text);
  assert.equal(payload?.error, undefined, text);
  return payload.result;
}

async function tool(sessionId, name, arguments_ = {}) {
  const result = await rpc(sessionId, 'tools/call', { name, arguments: arguments_ });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
}

async function close(sessionId) {
  if (!sessionId) return;
  await fetch(endpoint, {
    method: 'DELETE',
    headers: { authorization, 'mcp-session-id': sessionId },
  }).catch(() => {});
}

const sessionA = await initialize('ssh-full-tools-a');
const sessionB = await initialize('ssh-full-tools-b');
const testDirectory = '.codex-tmp/full-mcp-e2e';
let interactiveHandle;

try {
  for (const session of [sessionA, sessionB]) {
    const connected = await tool(session, 'router_connect', { target_ref: targetRef });
    assert.equal(connected.machine_code, expectedMachineCode);
  }

  const listed = await rpc(sessionA, 'tools/list');
  const names = listed.tools.map((entry) => entry.name);
  for (const required of [
    'exec', 'read', 'write', 'upload', 'download', 'exec_session', 'read_session',
    'write_stdin', 'kill_session', 'search', 'apply_patch',
  ]) assert.ok(names.includes(required), `missing tool ${required}`);

  const concurrentStart = performance.now();
  const concurrent = await Promise.all([
    tool(sessionA, 'exec', { cmd: 'sleep 2; printf first', timeout_ms: 10_000 }),
    tool(sessionA, 'exec', { cmd: 'sleep 2; printf second', timeout_ms: 10_000 }),
  ]);
  const concurrentMs = Math.round(performance.now() - concurrentStart);
  assert.match(concurrent[0].stdout, /first/);
  assert.match(concurrent[1].stdout, /second/);
  assert.ok(concurrentMs < 3_500, `same-session calls were serialized: ${concurrentMs}ms`);

  const secondSession = await tool(sessionB, 'pwd');
  const remoteRoot = secondSession.root;
  assert.ok(remoteRoot?.startsWith('/'));

  const started = await tool(sessionA, 'exec_session', {
    cmd: 'IFS= read -r line; printf "received:%s\\n" "$line"; sleep 30',
    tty: true,
    session_id: 'full-mcp-interactive',
  });
  interactiveHandle = started.sessionId;
  assert.ok(interactiveHandle);
  const written = await tool(sessionA, 'write_stdin', {
    session_id: interactiveHandle,
    chars: 'hello-from-router\n',
    yield_time_ms: 250,
  });
  const interactive = await tool(sessionA, 'read_session', {
    session_id: interactiveHandle,
    wait_ms: 1_000,
  });
  assert.match(
    `${written.output || ''}${interactive.stdout || ''}${interactive.pty || ''}`,
    /received:hello-from-router/,
  );
  const killed = await tool(sessionA, 'kill_session', { session_id: interactiveHandle });
  assert.equal(killed.killed, true);
  interactiveHandle = null;

  const piped = await tool(sessionA, 'exec_session', {
    cmd: 'printf pipe-session-ok',
    tty: false,
    session_id: 'full-mcp-pipe',
  });
  const pipedDeadline = Date.now() + 5_000;
  let pipedStdout = '';
  let pipedResult;
  do {
    pipedResult = await tool(sessionA, 'read_session', {
      session_id: piped.sessionId,
      wait_ms: Math.max(1, Math.min(1_000, pipedDeadline - Date.now())),
    });
    pipedStdout += pipedResult.stdout || '';
  } while (!pipedResult.closed && Date.now() < pipedDeadline);
  assert.equal(pipedResult.closed, true);
  assert.equal(pipedResult.exitCode, 0);
  assert.equal(pipedStdout, 'pipe-session-ok');

  await tool(sessionA, 'mkdir', { path: testDirectory });
  const testDirectoryStat = await tool(sessionA, 'stat', { path: testDirectory });
  assert.equal(testDirectoryStat.isDirectory, true);
  const patch = `*** Begin Patch\n*** Add File: ${testDirectory}/patched.txt\n+native ssh mcp\n*** End Patch`;
  await tool(sessionA, 'apply_patch', { patch, cwd: remoteRoot });
  const patched = await tool(sessionA, 'read', { path: `${testDirectory}/patched.txt` });
  assert.equal(patched.content, 'native ssh mcp\n');
  const searched = await tool(sessionA, 'search', {
    pattern: 'native ssh mcp',
    path: testDirectory,
  });
  assert.ok(JSON.stringify(searched).includes('patched.txt'));

  const largeBytes = 20 * 1024 * 1024;
  const large = Buffer.alloc(largeBytes);
  for (let offset = 0; offset < large.length; offset += 1) large[offset] = offset % 251;
  const largeHash = crypto.createHash('sha256').update(large).digest('hex');
  const largePath = `${testDirectory}/large.bin`;
  await tool(sessionA, 'upload', {
    path: largePath,
    base64: large.toString('base64'),
    create_parent_dirs: true,
  });
  const remoteHash = await tool(sessionA, 'exec', {
    cmd: `sha256sum ${largePath} | awk '{print $1}'`,
    timeout_ms: 10_000,
  });
  assert.equal(remoteHash.stdout.trim(), largeHash);
  const downloaded = await tool(sessionA, 'download', { path: largePath });
  assert.equal(downloaded.base64.length, Math.ceil(largeBytes / 3) * 4);
  assert.equal(
    crypto.createHash('sha256').update(Buffer.from(downloaded.base64, 'base64')).digest('hex'),
    largeHash,
  );

  console.log(JSON.stringify({
    ok: true,
    tool_count: names.length,
    same_session_parallel_ms: concurrentMs,
    interactive: true,
    second_router_session: true,
    large_round_trip_bytes: largeBytes,
    large_round_trip_sha256: largeHash,
  }));
} finally {
  if (interactiveHandle) {
    await tool(sessionA, 'kill_session', { session_id: interactiveHandle }).catch(() => {});
  }
  await tool(sessionA, 'rm', { path: testDirectory, recursive: true, force: true }).catch(() => {});
  await Promise.all([close(sessionA), close(sessionB)]);
}
