import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const installer = fileURLToPath(
  new URL('../assets/codex-remote-mcp-server/install.sh', import.meta.url),
);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('installer shell-quotes paths, keeps state owner-only, and never kills a stale unrelated PID', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mcp-installer-'));
  const marker = path.join(directory, 'injected-marker');
  const workdir = path.join(directory, `work $(touch\${IFS}${marker})`);
  const installDirectory = path.join(directory, 'install dir');
  const sourceBinary = path.join(directory, 'fake-server');
  const tokenSource = path.join(directory, 'token-source');
  const port = await freePort();
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(tokenSource, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(sourceBinary, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const listen = process.argv[process.argv.indexOf('--listen') + 1];
const root = process.argv[process.argv.indexOf('--root') + 1];
const port = Number(listen.slice(listen.lastIndexOf(':') + 1));
fs.writeFileSync(path.join(root, 'server-cwd'), process.cwd());
http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'DELETE') {
    response.end('{}');
    return;
  }
  response.setHeader('mcp-session-id', 'installer-test-session');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }));
}).listen(port, '127.0.0.1');
`, { mode: 0o700 });

  let pid = null;
  const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(Number.isInteger(unrelated.pid) && unrelated.pid > 0);
    fs.mkdirSync(installDirectory, { recursive: true });
    fs.writeFileSync(path.join(installDirectory, 'server.pid'), `${unrelated.pid}\n`, { mode: 0o600 });
    const result = spawnSync('/bin/bash', [installer], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        REMOTE_MCP_INSTALL_DIR: installDirectory,
        REMOTE_MCP_WORKDIR: workdir,
        REMOTE_MCP_BINARY: sourceBinary,
        REMOTE_MCP_LISTEN: `127.0.0.1:${port}`,
        REMOTE_MCP_BEARER_TOKEN_SOURCE: tokenSource,
        REMOTE_MCP_SERVICE_MODE: 'detached',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotThrow(
      () => process.kill(unrelated.pid, 0),
      'a stale PID file must not allow the installer to kill an unrelated process',
    );
    assert.equal(fs.existsSync(marker), false, 'path text must never execute as shell code');
    const launcher = path.join(installDirectory, 'start.sh');
    const syntax = spawnSync('/bin/bash', ['-n', launcher], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(fs.statSync(installDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(installDirectory, 'bearer-token')).mode & 0o777, 0o600);
    assert.equal(
      fs.realpathSync(fs.readFileSync(path.join(workdir, 'server-cwd'), 'utf8')),
      fs.realpathSync(workdir),
    );
    pid = Number(fs.readFileSync(path.join(installDirectory, 'server.pid'), 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The fixture server may already have exited.
      }
    }
    unrelated.kill('SIGTERM');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installer replaces its own listener when the remote workspace root changes', {
  skip: process.platform !== 'linux' ? 'ownership validation uses Linux /proc semantics' : false,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mcp-reconfigure-'));
  const firstRoot = path.join(directory, 'first-root');
  const secondRoot = path.join(directory, 'second-root');
  const installDirectory = path.join(directory, 'install');
  const sourceBinary = path.join(directory, 'fake-server');
  const tokenSource = path.join(directory, 'token-source');
  const port = await freePort();
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  fs.writeFileSync(tokenSource, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(sourceBinary, `#!/usr/bin/env node
const http = require('node:http');
const listen = process.argv[process.argv.indexOf('--listen') + 1];
const port = Number(listen.slice(listen.lastIndexOf(':') + 1));
http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'DELETE') return response.end('{}');
  response.setHeader('mcp-session-id', 'reconfigure-session');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }));
}).listen(port, '127.0.0.1');
`, { mode: 0o700 });

  let finalPid = null;
  const install = (workdir) => spawnSync('/bin/bash', [installer], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      REMOTE_MCP_INSTALL_DIR: installDirectory,
      REMOTE_MCP_WORKDIR: workdir,
      REMOTE_MCP_BINARY: sourceBinary,
      REMOTE_MCP_LISTEN: `127.0.0.1:${port}`,
      REMOTE_MCP_BEARER_TOKEN_SOURCE: tokenSource,
      REMOTE_MCP_SERVICE_MODE: 'detached',
    },
  });

  try {
    const first = install(firstRoot);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstPid = Number(fs.readFileSync(path.join(installDirectory, 'server.pid'), 'utf8').trim());

    const second = install(secondRoot);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    finalPid = Number(fs.readFileSync(path.join(installDirectory, 'server.pid'), 'utf8').trim());
    assert.notEqual(finalPid, firstPid);
    const previousCommand = spawnSync('/bin/ps', ['-ww', '-p', String(firstPid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert.doesNotMatch(
      previousCommand.stdout || '',
      new RegExp(`${installDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/codex-remote-mcp-server`),
      'the previous PID must no longer own this install directory server',
    );
    assert.match(
      fs.readFileSync(path.join(installDirectory, 'start.sh'), 'utf8'),
      new RegExp(secondRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    if (finalPid) {
      try {
        process.kill(finalPid, 'SIGTERM');
      } catch {
        // The fixture server may already have exited.
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
