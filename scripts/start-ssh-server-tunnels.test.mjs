import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./start-ssh-server-tunnels.mjs', import.meta.url));

function run(args, root) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_REMOTE_MCP_STATE_FILE: path.join(root, 'router-state.json'),
    },
  });
}

test('accepts an empty all-target reconcile but fails closed for an unknown targeted SSH tunnel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tunnel-selector-'));
  try {
    const all = run([], root);
    assert.equal(all.status, 0, all.stderr);

    const unknown = run(['--ref', 'missing-target'], root);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /registered SSH tunnel not found/);

    const invalid = run(['--ref', '../unsafe'], root);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /usage:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
