#!/usr/bin/env node
import assert from 'node:assert/strict';

const endpoint = process.argv[2];
if (!endpoint) {
  console.error('usage: test-mcp-endpoint-session-isolation.mjs <mcp-endpoint>');
  process.exit(2);
}

const authorization = process.env.MCP_TEST_AUTHORIZATION || '';
const sessions = new Set();

async function rpc(method, params, sessionId) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
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

async function initialize() {
  const response = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'endpoint-session-isolation-test', version: '1' },
  });
  assert.equal(response.status, 200);
  assert.ok(response.sessionId);
  sessions.add(response.sessionId);
  return response.sessionId;
}

async function callTool(sessionId, name, args = {}) {
  return rpc('tools/call', { name, arguments: args }, sessionId);
}

async function deleteSession(sessionId) {
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      ...(authorization ? { authorization } : {}),
      'mcp-session-id': sessionId,
    },
  });
  if (response.status === 204 || response.status === 404) sessions.delete(sessionId);
  return response;
}

let sessionA;
let sessionB;
try {
  sessionA = await initialize();
  sessionB = await initialize();
  assert.notEqual(sessionA, sessionB);

  const missingHeader = await rpc('tools/list', {});
  assert.equal(missingHeader.status, 404);

  for (const sessionId of [sessionA, sessionB]) {
    const started = await callTool(sessionId, 'exec_session', {
      cmd: 'sleep 60',
      tty: false,
      session_id: 'same-external-handle',
    });
    assert.equal(started.status, 200);
    assert.equal(started.payload.result.structuredContent.sessionId, 'same-external-handle');
  }

  assert.deepEqual(
    (await callTool(sessionA, 'sessions')).payload.result.structuredContent.sessions
      .map((entry) => entry.sessionId),
    ['same-external-handle'],
  );
  assert.deepEqual(
    (await callTool(sessionB, 'sessions')).payload.result.structuredContent.sessions
      .map((entry) => entry.sessionId),
    ['same-external-handle'],
  );

  assert.equal((await deleteSession(sessionA)).status, 204);
  assert.equal((await callTool(sessionA, 'sessions')).status, 404);
  assert.deepEqual(
    (await callTool(sessionB, 'sessions')).payload.result.structuredContent.sessions
      .map((entry) => entry.sessionId),
    ['same-external-handle'],
  );

  const killed = await callTool(sessionB, 'kill_session', {
    session_id: 'same-external-handle',
  });
  assert.equal(killed.payload.result.structuredContent.killed, true);
  assert.equal((await deleteSession(sessionB)).status, 204);
  console.log('MCP endpoint session isolation: ok');
} finally {
  for (const sessionId of sessions) {
    await callTool(sessionId, 'kill_session', {
      session_id: 'same-external-handle',
    }).catch(() => {});
    await deleteSession(sessionId).catch(() => {});
  }
}
