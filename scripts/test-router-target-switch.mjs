#!/usr/bin/env node
import assert from 'node:assert/strict';

import { mergedEnv, readRouterBearerToken, routerBearerTokenPath } from './env.mjs';

const [endpoint, firstRef, firstCode, secondRef, secondCode] = process.argv.slice(2);
if (!endpoint || !firstRef || !firstCode || !secondRef || !secondCode) {
  console.error(
    'usage: test-router-target-switch.mjs <endpoint> <first-ref> <first-code> <second-ref> <second-code>',
  );
  process.exit(2);
}
const env = mergedEnv();
const authorization = `Bearer ${readRouterBearerToken(routerBearerTokenPath(env))}`;

const threadId = process.env.MCP_TEST_THREAD_ID || `router-switch-${Date.now()}`;
const headers = {
  authorization,
  'content-type': 'application/json',
  'x-codex-route-lineage': 'current',
  'x-codex-thread-id': threadId,
};
let sessionId;

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...headers,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  assert.equal(response.status, 200, text);
  assert.equal(payload?.error, undefined, text);
  if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
  return payload.result;
}

async function tool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
}

async function connectAndProbe(targetRef, expectedCode) {
  const connected = await tool('router_connect', { target_ref: targetRef });
  assert.equal(connected.machine_code, expectedCode);
  const status = await tool('router_status');
  assert.equal(status.machine_code, expectedCode);
  const executed = await tool('exec', { cmd: 'hostname; pwd' });
  return {
    target_ref: targetRef,
    machine_code: expectedCode,
    output: executed.stdout.trim().split(/\r?\n/),
    cwd: executed.cwd,
  };
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'router-target-switch-test', version: '1' },
  });
  assert.ok(sessionId);

  const listed = await tool('router_list');
  assert.ok(listed.targets.some((target) => target.target_ref === firstRef));
  assert.ok(listed.targets.some((target) => target.target_ref === secondRef));

  const first = await connectAndProbe(firstRef, firstCode);
  const second = await connectAndProbe(secondRef, secondCode);
  const returned = await connectAndProbe(firstRef, firstCode);
  assert.notEqual(first.output[0], second.output[0]);
  assert.equal(returned.output[0], first.output[0]);

  console.log(JSON.stringify({ ok: true, thread_id: threadId, listed: listed.targets, route: [first, second, returned] }, null, 2));
} finally {
  if (sessionId) {
    await fetch(endpoint, {
      method: 'DELETE',
      headers: { authorization, 'mcp-session-id': sessionId },
    }).catch(() => {});
  }
}
