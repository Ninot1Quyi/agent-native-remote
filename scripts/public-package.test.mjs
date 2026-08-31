#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptDirectory);
const thisFile = fileURLToPath(import.meta.url);

function literal(...parts) {
  return parts.join('');
}

function boundary(...parts) {
  return `(^|[^a-z0-9])${literal(...parts)}([^a-z0-9]|$)`;
}

const forbidden = [
  ['company or product identifier', new RegExp([
    literal('kua', 'ishou'),
    literal('kua', 'ishow'),
    literal('k', 'wai'),
    literal('ke', 'ling'),
    literal('kl', 'ing'),
    literal('天', '琴'),
    literal('天', '问'),
  ].join('|'), 'iu')],
  ['legacy machine-platform identifier', new RegExp(boundary('k', 'm', 'l'), 'iu')],
  ['private platform integration', new RegExp(
    `(^|[^a-z0-9])(?:${[
      literal('ha', 'lo'),
      literal('kd', 'ev'),
      `${literal('k', 'c', 's')}(?:ctl)?`,
      literal('ke', 'ss'),
      literal('kc', 'onf'),
      literal('k', 's', '-cli'),
      literal('open', 'cli'),
    ].join('|')})([^a-z0-9]|$)`,
    'iu',
  )],
  ['private package namespace', new RegExp(literal('@', 'k', 's', '-'), 'iu')],
  ['corporate hostname pattern', new RegExp(`\\.${literal('co', 'rp')}(?:\\.|[/:])`, 'iu')],
  ['private lane label', new RegExp(`(^|[^a-z0-9])${literal('p', 'r', 't')}(?:\\.|[^a-z0-9]|$)`, 'iu')],
  ['removed adapter integration', new RegExp(`${literal('web', 'shell')}|${literal('service', '-container')}`, 'iu')],
  ['private service prefix', new RegExp(`(^|[^a-z0-9])${literal('m', 'm', 'u', '-')}`, 'iu')],
  ['personal or private runtime path', new RegExp(
    `/Users/[^/\\s]+|/${literal('ho', 'me', '/web', '_server')}`,
    'iu',
  )],
];

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(item));
    else if (entry.isFile()) files.push(item);
  }
  return files;
}

function inspect(label, bytes, findings) {
  const text = bytes.toString('utf8');
  for (const [reason, pattern] of forbidden) {
    if (pattern.test(label) || pattern.test(text)) findings.push(`${label}: ${reason}`);
  }
}

test('public package contains no organization-specific identifiers', () => {
  const roots = [
    path.join(packageRoot, 'SKILL.md'),
    path.join(packageRoot, 'README.md'),
    path.join(packageRoot, 'PUBLIC_MIGRATION.md'),
    path.join(packageRoot, 'agents'),
    path.join(packageRoot, 'references'),
    path.join(packageRoot, 'scripts'),
    path.join(packageRoot, 'assets', 'codex-remote-mcp-server', 'install.sh'),
    path.join(
      packageRoot,
      'assets',
      'codex-remote-mcp-server',
      'codex-rs',
      'mcp-server',
      'remote',
    ),
    path.join(
      packageRoot,
      'assets',
      'codex-remote-mcp-server',
      'prebuilt',
      'x86_64-unknown-linux-gnu',
      'codex-remote-mcp-server',
    ),
  ];
  const findings = [];
  for (const root of roots) {
    const files = fs.statSync(root).isDirectory() ? filesBelow(root) : [root];
    for (const file of files) {
      if (file === thisFile) continue;
      inspect(path.relative(packageRoot, file), fs.readFileSync(file), findings);
    }
  }

  const archive = path.join(
    packageRoot,
    'assets',
    'codex-remote-mcp-server',
    'prebuilt',
    'x86_64-unknown-linux-gnu',
    'codex-remote-mcp-package.tar.xz',
  );
  const archivedInstaller = spawnSync('tar', ['-xJOf', archive, 'install.sh'], {
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(archivedInstaller.status, 0, archivedInstaller.stderr?.toString('utf8'));
  inspect('prebuilt archive:install.sh', archivedInstaller.stdout, findings);

  assert.deepEqual(findings, [], findings.join('\n'));
});

test('configuration prefixes stay on their public local and remote boundaries', () => {
  const files = filesBelow(path.join(packageRoot, 'scripts'))
    .filter((file) => file !== thisFile);
  const findings = [];
  for (const file of files) {
    const relative = path.relative(packageRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    if (/AGENT_REMOTE_(?!MCP_)/u.test(text)) {
      findings.push(`${relative}: legacy local configuration prefix`);
    }
  }

  assert.deepEqual(findings, [], findings.join('\n'));
});
