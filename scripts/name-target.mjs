#!/usr/bin/env node

import {
  mergedEnv,
  readRouterState,
  routerStatePath,
  writeRouterState,
} from './env.mjs';

const [lookupValue, nameValue, ...options] = process.argv.slice(2);
if (!lookupValue || !nameValue) {
  console.error('usage: name-target.mjs <target-ref-or-machine-code> <display-name> [--alias NAME]');
  process.exit(2);
}

function displayName(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be 1-128 printable characters`);
  }
  return normalized;
}

const lookup = displayName(lookupValue, 'target lookup');
const name = displayName(nameValue, 'display name');
const requestedAliases = [];
for (let index = 0; index < options.length; index += 2) {
  if (options[index] !== '--alias' || !options[index + 1]) {
    throw new Error(`invalid option: ${options[index] || '<missing>'}`);
  }
  requestedAliases.push(displayName(options[index + 1], '--alias'));
}

const stateFile = routerStatePath(mergedEnv());
const state = readRouterState(stateFile);
const matches = state.targets.filter((target) => [
  target.ref,
  target.name || target.ref,
  target.machineCode,
  ...(target.aliases || []),
].includes(lookup));
if (matches.length !== 1) {
  throw new Error(matches.length === 0 ? `target is not registered: ${lookup}` : `target lookup is ambiguous: ${lookup}`);
}

const target = matches[0];
const previousName = target.name || target.ref;
const aliases = [...new Set([
  ...(target.aliases || []),
  ...(previousName !== target.ref ? [previousName] : []),
  ...requestedAliases,
])].filter((value) => value !== target.ref && value !== name);
const requestedNames = new Set([target.ref, name, ...aliases]);
for (const other of state.targets) {
  if (other === target) continue;
  const collision = [other.ref, other.name || other.ref, ...(other.aliases || [])]
    .find((value) => requestedNames.has(value));
  if (collision) throw new Error(`Router target name or alias is already registered: ${collision}`);
}

target.name = name;
if (name === target.ref) delete target.name;
if (aliases.length > 0) target.aliases = aliases;
else delete target.aliases;
writeRouterState(state, stateFile);

console.log(`named target ${target.ref}: ${name}`);
console.log('restart the Router to load the updated name');
