#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { parseEnvFile } from './env.mjs';

const [packageRoot, privateEnvFile] = process.argv.slice(2);
if (!packageRoot || !privateEnvFile) {
  console.error('usage: audit-share-package.mjs <package-root> <private-env-file>');
  process.exit(2);
}

const privateKeys = /(?:COOKIE|TOKEN|PASSWORD|SECRET|AUTHORIZATION|API_?KEY|PRIVATE_?KEY|BEARER|CREDENTIALS?)$/i;
const privateValues = Object.entries(parseEnvFile(privateEnvFile))
  .filter(([key, value]) => privateKeys.test(key) && String(value).length >= 4)
  .map(([key, value]) => ({ key, bytes: Buffer.from(String(value)) }));

const sshConfigDirectory = path.join(process.env.HOME || '', '.ssh', 'codex-remote-mcp.d');
if (fs.existsSync(sshConfigDirectory)) {
  for (const entry of fs.readdirSync(sshConfigDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.conf')) continue;
    const config = fs.readFileSync(path.join(sshConfigDirectory, entry.name), 'utf8');
    for (const match of config.matchAll(/^\s*(HostName|IdentityFile)\s+(\S+)\s*$/gim)) {
      if (match[2].length >= 4) {
        privateValues.push({ key: `SSH_${match[1].toUpperCase()}`, bytes: Buffer.from(match[2]) });
      }
    }
  }
}

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(item));
    else if (entry.isFile()) files.push(item);
  }
  return files;
}

const findings = [];
for (const file of filesBelow(packageRoot)) {
  const content = fs.readFileSync(file);
  for (const secret of privateValues) {
    if (content.includes(secret.bytes)) {
      findings.push({ key: secret.key, file: path.relative(packageRoot, file) });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`private ${finding.key} value appears in ${finding.file}`);
  }
  process.exit(1);
}

console.log(`private-value audit: ok (${privateValues.length} local values checked)`);
