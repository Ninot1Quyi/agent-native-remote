#!/usr/bin/env node
import assert from 'node:assert/strict';

import { mergedEnv, readRouterBearerToken, routerBearerTokenPath } from './env.mjs';

const [endpoint, targetRef, expectedMachineCode, expectedRoot] = process.argv.slice(2);
if (!endpoint || !targetRef || !expectedMachineCode || !expectedRoot) {
  console.error(
    'usage: test-router-live-target.mjs <router-endpoint> <target-ref> <machine-code> <remote-root>',
  );
  process.exit(2);
}
const env = mergedEnv();
const authorization = `Bearer ${readRouterBearerToken(routerBearerTokenPath(env))}`;

const threadId = process.env.MCP_TEST_THREAD_ID || 'router-live-target-test';
const shouldConnect = process.env.MCP_TEST_CONNECT === '1';
const expectUnbound = process.env.MCP_TEST_EXPECT_UNBOUND === '1';
const lineageHeaders = {
  authorization,
  'x-codex-route-lineage': 'current',
  'x-codex-thread-id': threadId,
};
let sessionId;

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...lineageHeaders,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok || payload?.error) {
    throw new Error(`Router ${method} failed: HTTP ${response.status} ${text}`);
  }
  if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
  return payload.result;
}

async function callTool(name, args = {}) {
  return rpc('tools/call', { name, arguments: args });
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'router-live-target-test', version: '1' },
  });
  assert.ok(sessionId);

  const tools = await rpc('tools/list');
  assert.deepEqual(tools.tools.slice(0, 3).map((tool) => tool.name), ['router_list', 'router_connect', 'router_status']);

  const listed = await callTool('router_list');
  const target = listed.structuredContent.targets.find((entry) => entry.target_ref === targetRef);
  assert.ok(target, `target ${targetRef} was not listed`);
  assert.ok(['http-mcp', 'ssh-server'].includes(target.kind));

  const initialStatus = await callTool('router_status');
  if (expectUnbound) assert.equal(initialStatus.structuredContent.machine_code, null);
  if (shouldConnect) {
    const connected = await callTool('router_connect', { target_ref: targetRef });
    assert.equal(connected.isError, false);
    assert.equal(connected.structuredContent.machine_code, expectedMachineCode);
  }

  const status = await callTool('router_status');
  assert.equal(status.structuredContent.machine_code, expectedMachineCode);

  const executed = await callTool('exec', { cmd: 'hostname; pwd' });
  assert.equal(executed.isError, false);
  assert.equal(executed.structuredContent.cwd, expectedRoot);
  assert.match(executed.structuredContent.stdout, new RegExp(`${expectedRoot.replaceAll('/', '\\/')}\\s*$`));

  const files = await callTool('list', { path: '.' });
  assert.equal(files.isError, false);
  assert.equal(files.structuredContent.path, expectedRoot);
  assert.ok(Array.isArray(files.structuredContent.entries));

  console.log(JSON.stringify({
    ok: true,
    thread_id: threadId,
    target_ref: targetRef,
    target_kind: target.kind,
    machine_code: status.structuredContent.machine_code,
    remote_output: executed.structuredContent.stdout.trim().split(/\r?\n/),
    remote_cwd: executed.structuredContent.cwd,
    remote_files: files.structuredContent.entries.slice(0, 20),
  }, null, 2));
} finally {
  if (sessionId) {
    await fetch(endpoint, {
      method: 'DELETE',
      headers: { authorization, 'mcp-session-id': sessionId },
    }).catch(() => {});
  }
}
