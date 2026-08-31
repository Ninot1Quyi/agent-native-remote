#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readRouterState,
  routerBearerTokenPath,
  routerStatePath,
  upsertRouterTarget,
} from './env.mjs';

test('uses company-neutral Router state paths and explicit overrides', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-state-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(
      routerStatePath({}),
      path.join(codexHome, 'state', 'agent-remote-mcp', 'router-state.json'),
    );
    assert.equal(
      routerBearerTokenPath({}),
      path.join(codexHome, 'state', 'agent-remote-mcp', 'router-bearer-token'),
    );
    assert.equal(
      routerStatePath({ AGENT_REMOTE_MCP_STATE_FILE: '/tmp/custom-router-state.json' }),
      '/tmp/custom-router-state.json',
    );
    assert.equal(
      routerBearerTokenPath({ AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: '/tmp/custom-router-token' }),
      '/tmp/custom-router-token',
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('accepts only generic HTTP MCP and SSH Router target kinds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-targets-'));
  const stateFile = path.join(directory, 'router-state.json');
  try {
    upsertRouterTarget({
      ref: 'public-api',
      kind: 'http-mcp',
      upstream: 'https://mcp.example.com/mcp',
    }, stateFile);
    upsertRouterTarget({
      ref: 'build-host',
      kind: 'ssh-server',
      upstream: 'http://127.0.0.1:7892/mcp',
    }, stateFile);
    assert.deepEqual(
      readRouterState(stateFile).targets.map(({ ref, kind }) => ({ ref, kind })),
      [
        { ref: 'public-api', kind: 'http-mcp' },
        { ref: 'build-host', kind: 'ssh-server' },
      ],
    );
    assert.throws(
      () => upsertRouterTarget({ ref: 'unknown', kind: 'platform', upstream: 'https://example.com/mcp' }, stateFile),
      /kind=http-mcp\|ssh-server/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
