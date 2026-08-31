import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  newManagedInstanceToken,
  stopManagedPidFile,
  writeManagedPidFile,
} from './managed-process.mjs';
import { remoteStartCommand } from './ssh-mcp-tunnel-supervisor.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !alive(child.pid)) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

for (const fixture of [
  {
    name: 'SSH tunnel supervisor',
    expected: (token) => [
      '/private/skill/scripts/ssh-mcp-tunnel-supervisor.mjs',
      '/private/state/ssh-tunnels/server.json',
      '--managed-instance', token,
      '--managed-ref', 'server',
    ],
  },
  {
    name: 'local Router',
    expected: (token) => [
      '/private/skill/scripts/remote-mcp-router.mjs',
      '--managed-instance', token,
      '--managed-listen', '127.0.0.1:7891',
      '--managed-state-file', '/private/state/router-state.json',
    ],
  },
]) {
  test(`${fixture.name} clears a stale PID file without killing sleep`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-pid-stale-'));
    const pidFile = path.join(directory, 'process.pid');
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      const token = newManagedInstanceToken();
      writeManagedPidFile(pidFile, child.pid, token);
      const stopped = await stopManagedPidFile(pidFile, fixture.expected, 100);
      assert.equal(stopped, false);
      assert.equal(fs.existsSync(pidFile), false);
      assert.equal(alive(child.pid), true, 'unrelated sleep process must remain alive');
    } finally {
      await stopChild(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a matching managed instance is stopped', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-pid-match-'));
  const pidFile = path.join(directory, 'process.pid');
  const token = newManagedInstanceToken();
  const markerArguments = [
    '/private/skill/scripts/remote-mcp-router.mjs',
    '--managed-instance', token,
    '--managed-listen', '127.0.0.1:7891',
  ];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...markerArguments], {
    stdio: 'ignore',
  });
  try {
    writeManagedPidFile(pidFile, child.pid, token);
    const stopped = await stopManagedPidFile(pidFile, () => markerArguments, 3_000);
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(pidFile), false);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    assert.equal(alive(child.pid), false);
  } finally {
    await stopChild(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('remote recovery clears an unrelated stale PID and starts the managed launcher', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-recovery-stale-'));
  const logs = path.join(directory, 'logs');
  const marker = path.join(directory, 'start-marker');
  fs.mkdirSync(logs);
  fs.writeFileSync(
    path.join(directory, 'start.sh'),
    '#!/bin/sh\ntouch "$(dirname "$0")/start-marker"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(path.join(directory, 'codex-remote-mcp-server'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(directory, 'server.pid'), `${child.pid}\n`, { mode: 0o600 });
    const result = spawnSync('/bin/sh', ['-c', remoteStartCommand(directory)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(alive(child.pid), true, 'remote recovery must not treat sleep as its server');
    assert.equal(fs.existsSync(path.join(directory, 'server.pid')), false);
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(marker), true, 'the stale PID must not block server recovery');
  } finally {
    await stopChild(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('remote recovery restarts an active but unhealthy systemd service', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-recovery-systemd-'));
  const fakeBin = path.join(directory, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(directory, 'start.sh'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'service-name'), 'codex-remote-mcp.service\n', { mode: 0o600 });
  fs.writeFileSync(
    path.join(fakeBin, 'systemctl'),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$(dirname "$0")/../systemctl-call"\n',
    { mode: 0o700 },
  );
  try {
    const result = spawnSync('/bin/sh', ['-c', remoteStartCommand(directory)], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(directory, 'systemctl-call'), 'utf8').trim(),
      'restart codex-remote-mcp.service',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
