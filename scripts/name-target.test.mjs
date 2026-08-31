import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./name-target.mjs', import.meta.url));

test('assigns a persistent Unicode target name and keeps the previous name as an alias', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'name-remote-target-'));
  const stateFile = path.join(directory, 'router-state.json');
  await writeFile(stateFile, `${JSON.stringify({
    version: 1,
    targets: [
      { ref: 'alpha-main', name: 'Alpha host', kind: 'http-mcp', upstream: 'http://127.0.0.1:7892/mcp' },
      { ref: 'build-main', name: 'Build host', kind: 'http-mcp', upstream: 'http://127.0.0.1:7893/mcp' },
    ],
    threads: {},
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    const renamed = spawnSync(process.execPath, [script, 'alpha-main', 'Dev host', '--alias', 'DEV'], {
      env: { ...process.env, AGENT_REMOTE_MCP_STATE_FILE: stateFile },
      encoding: 'utf8',
    });
    assert.equal(renamed.status, 0, renamed.stderr);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.targets[0].name, 'Dev host');
    assert.deepEqual(state.targets[0].aliases, ['Alpha host', 'DEV']);

    const collision = spawnSync(process.execPath, [script, 'alpha-main', 'Build host'], {
      env: { ...process.env, AGENT_REMOTE_MCP_STATE_FILE: stateFile },
      encoding: 'utf8',
    });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /already registered/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
