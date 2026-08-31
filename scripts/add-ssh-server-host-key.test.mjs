import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const addServer = fileURLToPath(new URL('./add-ssh-server.sh', import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function executable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o700 });
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mcp-host-key-'));
  temporaryDirectories.push(directory);
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const hostKey = path.join(directory, 'host-ed25519');
  const generated = spawnSync('/usr/bin/ssh-keygen', [
    '-q', '-t', 'ed25519', '-N', '', '-f', hostKey,
  ]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const publicKey = fs.readFileSync(`${hostKey}.pub`, 'utf8').trim();
  const hostLine = `example.test ${publicKey}`;
  const hostLineFile = path.join(directory, 'host-line');
  fs.writeFileSync(hostLineFile, `${hostLine}\n`, { mode: 0o600 });
  const fingerprintResult = spawnSync('/usr/bin/ssh-keygen', [
    '-lf', hostLineFile, '-E', 'sha256',
  ], { encoding: 'utf8' });
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.trim().split(/\s+/)[1];
  const copyMarker = path.join(directory, 'copy-id-called');

  executable(path.join(bin, 'ssh-keyscan'), `#!/bin/sh\nprintf '%s\\n' "$MOCK_HOST_LINE"\n`);
  executable(path.join(bin, 'ssh'), `#!/bin/sh
known_hosts=''
tofu=false
for argument in "$@"; do
  case "$argument" in
    UserKnownHostsFile=*) known_hosts="\${argument#UserKnownHostsFile=}" ;;
    StrictHostKeyChecking=accept-new) tofu=true ;;
  esac
done
if [ "$tofu" = true ] && [ -n "$known_hosts" ]; then
  printf '%s\\n' "$MOCK_HOST_LINE" > "$known_hosts"
fi
exit 1
`);
  executable(path.join(bin, 'ssh-copy-id'), `#!/bin/sh
: > "$MOCK_COPY_MARKER"
exit 42
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_COPY_MARKER: copyMarker,
    MOCK_HOST_LINE: hostLine,
  };
  return { copyMarker, env, fingerprint, home };
}

function runOnboarding(fixture_, ...extra) {
  return spawnSync(addServer, [
    'test-target', 'example.test', '2222', 'root', ...extra,
  ], { env: fixture_.env, encoding: 'utf8' });
}

test('stops before password entry when no trusted host identity exists', () => {
  const current = fixture();
  const result = runOnboarding(current);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(fs.existsSync(current.copyMarker), false);
  assert.match(result.stderr, /password has not been requested/);
});

test('rejects a mismatched host-key fingerprint before password entry', () => {
  const current = fixture();
  const wrong = `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=$/, '')}`;
  const result = runOnboarding(current, '--host-key-sha256', wrong);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(current.copyMarker), false);
  assert.match(result.stderr, /did not present the trusted host-key fingerprint/);
});

test('accepts an exact independent fingerprint before invoking ssh-copy-id', () => {
  const current = fixture();
  const result = runOnboarding(current, '--host-key-sha256', current.fingerprint);
  assert.equal(result.status, 42, result.stderr);
  assert.equal(fs.existsSync(current.copyMarker), true);
  const pinned = path.join(current.home, '.ssh', 'test-target_remote_mcp_known_hosts');
  const pinnedFingerprint = spawnSync('/usr/bin/ssh-keygen', [
    '-lf', pinned, '-E', 'sha256',
  ], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[1];
  assert.equal(pinnedFingerprint, current.fingerprint);
});

test('requires explicit TOFU and records the native SSH handshake key first', () => {
  const current = fixture();
  const result = runOnboarding(current, '--trust-on-first-use');
  assert.equal(result.status, 42, result.stderr);
  assert.equal(fs.existsSync(current.copyMarker), true);
  assert.match(result.stderr, /native OpenSSH TOFU/);
  const pinned = path.join(current.home, '.ssh', 'test-target_remote_mcp_known_hosts');
  assert.match(fs.readFileSync(pinned, 'utf8'), /example\.test ssh-ed25519/);
});
