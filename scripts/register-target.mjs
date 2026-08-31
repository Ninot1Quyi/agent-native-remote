#!/usr/bin/env node
import {
  parseEnvFile,
  routerStatePath,
  upsertRouterTarget,
  writeEnvFile,
} from './env.mjs';

const [ref, kind, upstream, ...options] = process.argv.slice(2);
if (!ref || !kind || !upstream) {
  console.error(
    'usage: register-target.mjs <ref> <http-mcp|ssh-server> <upstream> ' +
    '[--name DISPLAY_NAME] [--origin URL] [--cookie-env NAME] [--authorization-env NAME] [--alias NAME]',
  );
  process.exit(2);
}

const target = { ref, kind, upstream, aliases: [] };
for (let index = 0; index < options.length; index += 2) {
  const option = options[index];
  const value = options[index + 1];
  if (!value) throw new Error(`missing value for ${option}`);
  if (option === '--name') target.name = value;
  else if (option === '--origin') target.origin = value;
  else if (option === '--cookie-env') target.cookieEnv = value;
  else if (option === '--authorization-env') target.authorizationEnv = value;
  else if (option === '--alias') {
    target.aliases.push(value);
  } else {
    throw new Error(`unknown option: ${option}`);
  }
}
if (target.aliases.length === 0) delete target.aliases;

const env = parseEnvFile();
const stateFile = routerStatePath(env);
upsertRouterTarget(target, stateFile);
writeEnvFile({ ...env, AGENT_REMOTE_MCP_STATE_FILE: stateFile });

console.log(`registered ${kind} target ${ref}`);
console.log(`state: ${stateFile}`);
