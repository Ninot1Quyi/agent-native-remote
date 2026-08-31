#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callRemoteTool, withRemoteSession } from './remote-tool.mjs';

const [localPathArg, remotePath] = process.argv.slice(2);
if (!localPathArg || !remotePath) {
  console.error('usage: upload-local-path.mjs <local-file-or-dir> <remote-target-dir>');
  process.exit(2);
}

const localPath = path.resolve(localPathArg);
const stat = fs.statSync(localPath);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-upload-'));
const archive = path.join(tempDir, 'upload.tar.gz');
const DIRECT_ARCHIVE_LIMIT_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function structured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const payload = result?.content?.find((item) => item?.type === 'text')?.text;
  return payload ? JSON.parse(payload) : {};
}

function requireRemoteSuccess(result, action) {
  const value = structured(result);
  if (result?.isError === true || value?.ok === false) {
    throw new Error(`${action} failed: ${value?.error || 'remote tool error'}`);
  }
  return value;
}

function isTransientUploadError(error) {
  const message = String(error?.message || error);
  return /502|503|504|timeout|aborted|ECONNRESET|socket hang up|remote terminal is not connected/i
    .test(message);
}

async function callWithRetry(call, name, args, action, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return requireRemoteSuccess(await call(name, args), action);
    } catch (error) {
      lastError = error;
      if (!isTransientUploadError(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

try {
  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  const tarArgs = ['--no-xattrs', '-czf', archive];
  if (stat.isDirectory()) {
    execFileSync('tar', [...tarArgs, '-C', localPath, '.'], { env: tarEnv });
  } else {
    execFileSync('tar', [...tarArgs, '-C', path.dirname(localPath), path.basename(localPath)], { env: tarEnv });
  }
  const bytes = fs.readFileSync(archive);
  if (bytes.length <= DIRECT_ARCHIVE_LIMIT_BYTES) {
    const result = await callRemoteTool('upload_archive', {
      path: remotePath,
      base64: bytes.toString('base64'),
    });
    requireRemoteSuccess(result, 'upload archive');
    process.stdout.write(`${JSON.stringify({
      uploaded: localPath,
      remotePath,
      transport: 'upload_archive',
      archiveBytes: bytes.length,
      result,
    }, null, 2)}\n`);
  } else {
    const scratchName = `.agent-native-upload-${process.pid}-${Date.now()}`;
    const scratchRoot = `${remotePath.replace(/\/$/, '')}/${scratchName}`;
    const partPaths = [];
    const extracted = await withRemoteSession(async ({ call }) => {
      for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index += 1) {
        const partPath = `${scratchRoot}/part-${String(index).padStart(6, '0')}`;
        partPaths.push(partPath);
        await callWithRetry(call, 'upload', {
          path: partPath,
          base64: bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES)).toString('base64'),
          create_parent_dirs: true,
        }, `upload chunk ${index + 1}`);
      }
      const unpacked = await callWithRetry(call, 'exec', {
        cmd: `mkdir -p ${shellQuote(remotePath)} && cat ${partPaths.map(shellQuote).join(' ')} | tar -xzf - -C ${shellQuote(remotePath)} && rm -rf ${shellQuote(scratchRoot)}`,
        timeout_ms: 120_000,
      }, 'extract chunks');
      if (Number(unpacked.exitCode ?? unpacked.exit_code ?? 0) !== 0) {
        throw new Error(`remote chunk extraction failed: ${unpacked.stderr || unpacked.stdout || 'unknown error'}`);
      }
      return unpacked;
    });
    process.stdout.write(`${JSON.stringify({
      uploaded: localPath,
      remotePath,
      transport: 'chunked-upload',
      archiveBytes: bytes.length,
      chunks: partPaths.length,
      result: extracted,
    }, null, 2)}\n`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
