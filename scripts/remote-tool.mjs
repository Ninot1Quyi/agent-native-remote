#!/usr/bin/env node
import {
  mergedEnv,
  readRouterBearerToken,
  routerBearerTokenPath,
} from './env.mjs';

const env = mergedEnv();
const endpoint = `http://${env.AGENT_REMOTE_MCP_LOCAL_LISTEN || '127.0.0.1:7891'}/mcp`;
const bearerToken = readRouterBearerToken(routerBearerTokenPath(env));
const authorization = `Bearer ${bearerToken}`;
const threadId = process.env.AGENT_REMOTE_MCP_CLI_THREAD_ID || 'agent-native-remote-cli';
let nextId = 1;

async function request(method, params = {}, sessionId = '') {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'x-codex-route-lineage': 'current',
      'x-codex-thread-id': threadId,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') || sessionId };
}

async function closeSession(sessionId) {
  if (!sessionId) return;
  await fetch(endpoint, {
    method: 'DELETE',
    headers: { authorization, 'mcp-session-id': sessionId },
  }).catch(() => {});
}

export async function withRemoteSession(fn) {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-native-remote-cli', version: '1' },
  });
  if (!initialized.sessionId) throw new Error('Router initialize did not return Mcp-Session-Id');
  try {
    const call = async (name, args = {}) => {
      const called = await request(
        'tools/call',
        { name, arguments: args },
        initialized.sessionId,
      );
      return called.result;
    };
    return await fn({ call, sessionId: initialized.sessionId });
  } finally {
    await closeSession(initialized.sessionId);
  }
}

export async function callRemoteTool(name, args = {}) {
  return withRemoteSession(({ call }) => call(name, args));
}

async function main() {
  const [name, argsJson = '{}'] = process.argv.slice(2);
  if (!name) {
    console.error("usage: remote-tool.mjs <tool-name> ['{\"arg\":\"value\"}']");
    process.exit(2);
  }
  const result = await callRemoteTool(name, JSON.parse(argsJson));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
