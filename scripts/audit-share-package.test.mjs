#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const auditor = fileURLToPath(new URL('./audit-share-package.mjs', import.meta.url));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-share-audit-'));
  const packageRoot = path.join(directory, 'package');
  const privateEnv = path.join(directory, '.env');
  fs.mkdirSync(packageRoot);
  return { directory, packageRoot, privateEnv };
}

test('rejects common API key and authorization values copied into a share package', (context) => {
  const current = fixture();
  context.after(() => fs.rmSync(current.directory, { recursive: true, force: true }));
  fs.writeFileSync(
    current.privateEnv,
    "PUBLIC_LISTEN='127.0.0.1:7891'\nFOO_API_KEY='api-key-value-123456'\nMCP_AUTHORIZATION='authorization-value-123456'\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(current.packageRoot, 'leak.txt'), 'authorization-value-123456\n');

  const result = spawnSync(process.execPath, [auditor, current.packageRoot, current.privateEnv], {
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(current.directory, 'home') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private MCP_AUTHORIZATION value appears in leak\.txt/);
});

test('passes when credential values are absent from the share package', (context) => {
  const current = fixture();
  context.after(() => fs.rmSync(current.directory, { recursive: true, force: true }));
  fs.writeFileSync(
    current.privateEnv,
    "FOO_API_KEY='api-key-value-123456'\nMCP_BEARER='bearer-value-123456'\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(current.packageRoot, 'README.md'), 'public content\n');

  const result = spawnSync(process.execPath, [auditor, current.packageRoot, current.privateEnv], {
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(current.directory, 'home') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /private-value audit: ok \(2 local values checked\)/);
});
