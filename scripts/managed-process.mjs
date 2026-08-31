import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function linuxProcessArguments(pid) {
  const file = `/proc/${pid}/cmdline`;
  if (!fs.existsSync(file)) return null;
  try {
    const value = fs.readFileSync(file);
    return value.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function processCommand(pid) {
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function containsOrderedValues(values, expected) {
  let offset = 0;
  for (const value of expected) {
    const index = values.indexOf(value, offset);
    if (index === -1) return false;
    offset = index + 1;
  }
  return true;
}

export function processMatchesArguments(pid, expectedArguments) {
  if (!processExists(pid) || !Array.isArray(expectedArguments) || expectedArguments.length === 0) {
    return false;
  }
  if (expectedArguments.some((value) => typeof value !== 'string' || value.length === 0)) return false;
  const argumentsFromProc = linuxProcessArguments(pid);
  if (argumentsFromProc) return containsOrderedValues(argumentsFromProc, expectedArguments);

  // macOS does not expose /proc. A random per-launch token is one of the expected
  // arguments, so ordered full-command matching still rejects a reused PID.
  const command = processCommand(pid);
  if (!command) return false;
  let offset = 0;
  for (const value of expectedArguments) {
    const index = command.indexOf(value, offset);
    if (index === -1) return false;
    offset = index + value.length;
  }
  return true;
}

export function newManagedInstanceToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function writeManagedPidFile(pidFile, pid, token) {
  if (!Number.isInteger(pid) || pid < 1 || !TOKEN_PATTERN.test(token)) {
    throw new Error('invalid managed process identity');
  }
  const temporary = `${pidFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, pid, token })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, pidFile);
  fs.chmodSync(pidFile, 0o600);
}

function readManagedPidFile(pidFile) {
  try {
    const value = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (
      value?.version !== 1 ||
      !Number.isInteger(value.pid) || value.pid < 1 ||
      !TOKEN_PATTERN.test(value.token || '') ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['pid', 'token', 'version'])
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function waitForExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

export async function stopManagedPidFile(pidFile, expectedArgumentsForToken, milliseconds = 3_000) {
  if (!fs.existsSync(pidFile)) return false;
  const identity = readManagedPidFile(pidFile);
  if (!identity) {
    fs.rmSync(pidFile, { force: true });
    return false;
  }
  const expectedArguments = expectedArgumentsForToken(identity.token);
  if (!processMatchesArguments(identity.pid, expectedArguments)) {
    fs.rmSync(pidFile, { force: true });
    return false;
  }

  try {
    process.kill(identity.pid, 'SIGTERM');
  } catch {
    fs.rmSync(pidFile, { force: true });
    return false;
  }
  if (!(await waitForExit(identity.pid, milliseconds))
      && processMatchesArguments(identity.pid, expectedArguments)) {
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch {
      // It exited between the identity check and signal delivery.
    }
  }
  fs.rmSync(pidFile, { force: true });
  return true;
}
