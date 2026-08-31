#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: test-remote-mcp-session-isolation.mjs <remote-mcp-binary>');
  process.exit(2);
}
const bearerToken = '0123456789abcdef0123456789abcdef';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function rpc(port, method, params, sessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearerToken}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    payload: text ? JSON.parse(text) : null,
  };
}

async function initialize(port) {
  return rpc(port, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'session-isolation-test', version: '1' },
  });
}

async function callTool(port, sessionId, name, args = {}) {
  return rpc(port, 'tools/call', { name, arguments: args }, sessionId);
}

async function deleteSession(port, sessionId) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${bearerToken}`, 'mcp-session-id': sessionId },
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'remote-mcp-session-test-'));
const bearerTokenFile = path.join(root, 'bearer-token');
await writeFile(bearerTokenFile, `${bearerToken}\n`);
await chmod(bearerTokenFile, 0o600);
const port = await freePort();
const child = spawn(binary, [
  '--listen', `127.0.0.1:${port}`,
  '--root', root,
  '--machine-code-file', path.join(root, 'machine-code'),
  '--bearer-token-file', bearerTokenFile,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let errors = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { errors += chunk; });

try {
  let sessionA;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${errors}`);
    try {
      const initialized = await initialize(port);
      if (initialized.status === 200) {
        sessionA = initialized.sessionId;
        break;
      }
    } catch {
      // The loopback listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(sessionA, `server did not become ready: ${errors}`);

  const initializedB = await initialize(port);
  assert.equal(initializedB.status, 200);
  const sessionB = initializedB.sessionId;
  assert.ok(sessionB);
  assert.notEqual(sessionA, sessionB);

  const missingHeader = await rpc(port, 'tools/list', {});
  assert.equal(missingHeader.status, 404);

  const startedA = await callTool(port, sessionA, 'exec_session', {
    cmd: 'sleep 60',
    tty: false,
    session_id: 'same-external-handle',
  });
  const startedB = await callTool(port, sessionB, 'exec_session', {
    cmd: 'sleep 60',
    tty: false,
    session_id: 'same-external-handle',
  });
  assert.equal(startedA.status, 200);
  assert.equal(startedB.status, 200);
  assert.equal(startedA.payload.result.structuredContent.sessionId, 'same-external-handle');
  assert.equal(startedB.payload.result.structuredContent.sessionId, 'same-external-handle');

  const listedA = await callTool(port, sessionA, 'sessions');
  const listedB = await callTool(port, sessionB, 'sessions');
  assert.deepEqual(
    listedA.payload.result.structuredContent.sessions.map((entry) => entry.sessionId),
    ['same-external-handle'],
  );
  assert.deepEqual(
    listedB.payload.result.structuredContent.sessions.map((entry) => entry.sessionId),
    ['same-external-handle'],
  );

  const deletedA = await deleteSession(port, sessionA);
  assert.equal(deletedA.status, 204);
  const staleA = await callTool(port, sessionA, 'sessions');
  assert.equal(staleA.status, 404);
  const survivingB = await callTool(port, sessionB, 'sessions');
  assert.equal(survivingB.status, 200);
  assert.deepEqual(
    survivingB.payload.result.structuredContent.sessions.map((entry) => entry.sessionId),
    ['same-external-handle'],
  );

  const killedB = await callTool(port, sessionB, 'kill_session', {
    session_id: 'same-external-handle',
  });
  assert.equal(killedB.payload.result.structuredContent.killed, true);
  assert.equal((await deleteSession(port, sessionB)).status, 204);

  console.log('remote MCP session isolation: ok');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  await rm(root, { recursive: true, force: true });
}
