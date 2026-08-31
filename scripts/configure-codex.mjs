#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateRouterBearerToken,
  parseEnvFile,
  readRouterBearerToken,
  routerBearerTokenPath,
  routerStatePath,
  writeEnvFile,
  writeRouterBearerToken,
  writeRouterState,
} from './env.mjs';

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const configFile = path.join(codexHome, 'config.toml');
const mcpName = process.env.AGENT_REMOTE_MCP_CODEX_NAME || 'remote';
const listen = process.env.AGENT_REMOTE_MCP_LOCAL_LISTEN || '127.0.0.1:7891';

if (!/^[A-Za-z0-9_-]{1,64}$/.test(mcpName)) {
  throw new Error('AGENT_REMOTE_MCP_CODEX_NAME must be a TOML bare key');
}
if (!/^127\.0\.0\.1:\d{1,5}$/.test(listen)) {
  throw new Error('AGENT_REMOTE_MCP_LOCAL_LISTEN must be a loopback IPv4 host and port');
}

const env = parseEnvFile();
const stateFile = routerStatePath({ ...env, AGENT_REMOTE_MCP_STATE_FILE: env.AGENT_REMOTE_MCP_STATE_FILE });
const bearerTokenFile = routerBearerTokenPath({ ...env, ...process.env });
const bearerToken = fs.existsSync(bearerTokenFile)
  ? readRouterBearerToken(bearerTokenFile)
  : generateRouterBearerToken();
const authorizationValue = `Bearer ${bearerToken}`;

fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const original = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
const newline = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
if (lines.at(-1) === '') lines.pop();

const header = `[mcp_servers.${mcpName}]`;
function parseTomlKeyPath(expression) {
  const segments = [];
  let token = '';
  let quote = '';
  let escaped = false;
  for (const character of expression) {
    if (quote) {
      token += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      token += character;
    } else if (character === '.') {
      segments.push(token.trim());
      token = '';
    } else {
      token += character;
    }
  }
  if (quote) return null;
  segments.push(token.trim());

  try {
    return segments.map((segment) => {
      if (/^[A-Za-z0-9_-]+$/.test(segment)) return segment;
      if (segment.startsWith('"') && segment.endsWith('"')) return JSON.parse(segment);
      if (segment.startsWith("'") && segment.endsWith("'") && !segment.slice(1, -1).includes("'")) {
        return segment.slice(1, -1);
      }
      throw new Error('unsupported TOML table key');
    });
  } catch {
    return null;
  }
}

function parseTomlTablePath(line) {
  const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  if (!match || match[1].trimStart().startsWith('[')) return null;
  return parseTomlKeyPath(match[1]);
}

function parseTomlAssignment(line) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return null;
    } else if (character === '=') {
      const assignmentPath = parseTomlKeyPath(line.slice(0, index).trim());
      return assignmentPath ? { path: assignmentPath, value: line.slice(index + 1).trim() } : null;
    }
  }
  return null;
}

function stripTomlComment(value) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseTomlString(value) {
  const normalized = stripTomlComment(value);
  try {
    if (normalized.startsWith('"') && normalized.endsWith('"')) return JSON.parse(normalized);
    if (normalized.startsWith("'") && normalized.endsWith("'") && !normalized.slice(1, -1).includes("'")) {
      return normalized.slice(1, -1);
    }
  } catch {
    // Fall through to a non-string result.
  }
  return null;
}

function parseTomlInlineStringTable(value) {
  const normalized = stripTomlComment(value);
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return null;
  const body = normalized.slice(1, -1);
  const parts = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return null;
  parts.push(body.slice(start).trim());

  const entries = new Map();
  for (const part of parts.filter(Boolean)) {
    const assignment = parseTomlAssignment(part);
    if (!assignment || assignment.path.length !== 1) return null;
    const key = assignment.path[0];
    const parsedValue = parseTomlString(assignment.value);
    if (parsedValue === null || entries.has(key)) return null;
    entries.set(key, parsedValue);
  }
  return entries;
}

function appendInlineStringTableEntry(line, key, value) {
  let quote = '';
  let escaped = false;
  let commentIndex = line.length;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      commentIndex = index;
      break;
    }
  }
  const valueEnd = line.slice(0, commentIndex).lastIndexOf('}');
  if (valueEnd === -1) throw new Error('http_headers must be a single-line inline TOML table');
  const beforeClose = line.slice(0, valueEnd).trimEnd();
  const separator = beforeClose.endsWith('{') ? ' ' : ', ';
  return `${beforeClose}${separator}${JSON.stringify(key)} = ${JSON.stringify(value)} ${line.slice(valueEnd)}`;
}

function normalizeHttpHeaderEntries(entries, context) {
  const normalized = new Map();
  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (normalized.has(normalizedKey)) {
      throw new Error(`${context} declares HTTP header ${key} more than once (header names are case-insensitive)`);
    }
    normalized.set(normalizedKey, value);
  }
  return normalized;
}

const matchingSections = lines
  .map((line, index) => ({ index, path: parseTomlTablePath(line) }))
  .filter(({ path: tablePath }) =>
    tablePath?.length === 2 && tablePath[0] === 'mcp_servers' && tablePath[1] === mcpName,
  );
if (matchingSections.length > 1) {
  throw new Error(`${header} is declared more than once; refusing to create an ambiguous Codex config`);
}
const nestedTargetSections = lines
  .map((line, index) => ({ index, path: parseTomlTablePath(line) }))
  .filter(({ path: tablePath }) =>
    tablePath?.length > 2 && tablePath[0] === 'mcp_servers' && tablePath[1] === mcpName,
  );
if (matchingSections.length === 0 && nestedTargetSections.length > 0) {
  throw new Error(
    `${header} is already defined implicitly by a nested TOML table; add the parent table explicitly before running this configurator`,
  );
}

let currentTablePath = [];
for (let index = 0; index < lines.length; index += 1) {
  const tablePath = parseTomlTablePath(lines[index]);
  if (tablePath) {
    currentTablePath = tablePath;
    continue;
  }
  const assignment = parseTomlAssignment(lines[index]);
  if (!assignment) continue;
  const effectivePath = [...currentTablePath, ...assignment.path];
  const definesTarget = effectivePath[0] === 'mcp_servers' && effectivePath[1] === mcpName;
  const definesParentAsValue = effectivePath.length === 1 && effectivePath[0] === 'mcp_servers';
  const insideTargetTable = currentTablePath.length >= 2 &&
    currentTablePath[0] === 'mcp_servers' && currentTablePath[1] === mcpName;
  if (definesParentAsValue || (definesTarget && !insideTargetTable)) {
    throw new Error(
      `${header} is already defined by a dotted or inline TOML key at line ${index + 1}; refusing to create an ambiguous Codex config`,
    );
  }
}

const sectionStart = matchingSections[0]?.index ?? -1;
const expectedUrl = `http://${listen}/mcp`;
const urlLine = `url = ${JSON.stringify(expectedUrl)}`;
const authorizationLine = `Authorization = ${JSON.stringify(authorizationValue)}`;
const lineageLine = `http_headers = { "Authorization" = ${JSON.stringify(authorizationValue)}, "X-Codex-Route-Lineage" = "current" }`;

if (sectionStart === -1) {
  if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
  lines.push(header, urlLine, lineageLine);
} else {
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const assignment = parseTomlAssignment(lines[index]);
    if (!assignment) continue;
    if (assignment.path.length === 1 && assignment.path[0] === 'bearer_token_env_var') {
      throw new Error(`${lines[sectionStart].trim()} already delegates bearer authentication through bearer_token_env_var`);
    }
    if (assignment.path[0] === 'http_headers' && assignment.path.length > 1) {
      throw new Error(`${lines[sectionStart].trim()} uses dotted http_headers keys; use one inline table or one nested table`);
    }
    if (assignment.path[0] === 'env_http_headers') {
      if (assignment.path.length > 1) {
        if (assignment.path[1].toLowerCase() === 'authorization') {
          throw new Error(`${lines[sectionStart].trim()} already delegates Authorization through env_http_headers`);
        }
      } else {
        const environmentHeaders = parseTomlInlineStringTable(assignment.value);
        if (!environmentHeaders) {
          throw new Error(`${lines[sectionStart].trim()} has an unsupported env_http_headers value`);
        }
        if (normalizeHttpHeaderEntries(environmentHeaders, 'env_http_headers').has('authorization')) {
          throw new Error(`${lines[sectionStart].trim()} already delegates Authorization through env_http_headers`);
        }
      }
    }
  }
  const nestedEnvironmentHeaderSections = lines
    .map((line, index) => ({ index, path: parseTomlTablePath(line) }))
    .filter(({ path: tablePath }) =>
      tablePath?.length === 3 && tablePath[0] === 'mcp_servers' &&
      tablePath[1] === mcpName && tablePath[2] === 'env_http_headers',
    );
  for (const environmentHeaderSection of nestedEnvironmentHeaderSections) {
    let environmentHeaderEnd = lines.length;
    for (let index = environmentHeaderSection.index + 1; index < lines.length; index += 1) {
      if (parseTomlTablePath(lines[index])) {
        environmentHeaderEnd = index;
        break;
      }
    }
    const environmentHeaderNames = [];
    for (let index = environmentHeaderSection.index + 1; index < environmentHeaderEnd; index += 1) {
      const assignment = parseTomlAssignment(lines[index]);
      if (assignment?.path.length === 1) environmentHeaderNames.push(assignment.path[0]);
    }
    const normalizedNames = new Set(environmentHeaderNames.map((name) => name.toLowerCase()));
    if (normalizedNames.size !== environmentHeaderNames.length) {
      throw new Error(`${lines[environmentHeaderSection.index].trim()} declares a case-insensitive duplicate HTTP header`);
    }
    if (normalizedNames.has('authorization')) {
      throw new Error(`${lines[sectionStart].trim()} already delegates Authorization through env_http_headers`);
    }
  }
  const urlIndexes = lines
    .map((line, index) => ({ assignment: parseTomlAssignment(line), index }))
    .filter(({ assignment, index }) =>
      index > sectionStart && index < sectionEnd &&
      assignment?.path.length === 1 && assignment.path[0] === 'url',
    )
    .map(({ index }) => index);
  if (urlIndexes.length > 1) {
    throw new Error(`${lines[sectionStart].trim()} declares url more than once`);
  }
  const urlIndex = urlIndexes[0] ?? -1;
  if (urlIndex !== -1 && parseTomlString(parseTomlAssignment(lines[urlIndex]).value) !== expectedUrl) {
    throw new Error(`${lines[sectionStart].trim()} already exists with a different URL; refusing to overwrite it`);
  }
  if (urlIndex === -1) {
    lines.splice(sectionStart + 1, 0, urlLine);
    sectionEnd += 1;
  }
  const headerIndexes = lines
    .map((line, index) => ({ assignment: parseTomlAssignment(line), index }))
    .filter(({ assignment, index }) =>
      index > sectionStart && index < sectionEnd &&
      assignment?.path.length === 1 && assignment.path[0] === 'http_headers',
    )
    .map(({ index }) => index);
  if (headerIndexes.length > 1) {
    throw new Error(`${lines[sectionStart].trim()} declares http_headers more than once`);
  }
  const nestedHeaderSections = lines
    .map((line, index) => ({ index, path: parseTomlTablePath(line) }))
    .filter(({ path: tablePath }) =>
      tablePath?.length === 3 && tablePath[0] === 'mcp_servers' &&
      tablePath[1] === mcpName && tablePath[2] === 'http_headers',
    );
  if (nestedHeaderSections.length > 1) {
    throw new Error(`${lines[sectionStart].trim()} declares the http_headers table more than once`);
  }
  const headerIndex = headerIndexes[0] ?? -1;
  const nestedHeaderStart = nestedHeaderSections[0]?.index ?? -1;
  if (headerIndex !== -1 && nestedHeaderStart !== -1) {
    throw new Error(`${lines[sectionStart].trim()} declares http_headers both inline and as a table`);
  }
  if (nestedHeaderStart !== -1) {
    let nestedHeaderEnd = lines.length;
    for (let index = nestedHeaderStart + 1; index < lines.length; index += 1) {
      if (parseTomlTablePath(lines[index])) {
        nestedHeaderEnd = index;
        break;
      }
    }
    const lineageIndexes = lines
      .map((line, index) => ({ assignment: parseTomlAssignment(line), index }))
      .filter(({ assignment, index }) =>
        index > nestedHeaderStart && index < nestedHeaderEnd &&
        assignment?.path.length === 1 && assignment.path[0].toLowerCase() === 'x-codex-route-lineage',
      )
      .map(({ index }) => index);
    const authorizationIndexes = lines
      .map((line, index) => ({ assignment: parseTomlAssignment(line), index }))
      .filter(({ assignment, index }) =>
        index > nestedHeaderStart && index < nestedHeaderEnd &&
        assignment?.path.length === 1 && assignment.path[0].toLowerCase() === 'authorization',
      )
      .map(({ index }) => index);
    if (lineageIndexes.length > 1) {
      throw new Error(`${lines[nestedHeaderStart].trim()} declares X-Codex-Route-Lineage more than once`);
    }
    if (authorizationIndexes.length > 1) {
      throw new Error(`${lines[nestedHeaderStart].trim()} declares Authorization more than once`);
    }
    const lineageIndex = lineageIndexes[0] ?? -1;
    const lineageValue = lineageIndex === -1
      ? null
      : parseTomlString(parseTomlAssignment(lines[lineageIndex]).value);
    if (lineageValue !== 'current') {
      throw new Error(
        `${lines[nestedHeaderStart].trim()} must contain X-Codex-Route-Lineage = "current"`,
      );
    }
    const authorizationIndex = authorizationIndexes[0] ?? -1;
    const configuredAuthorization = authorizationIndex === -1
      ? null
      : parseTomlString(parseTomlAssignment(lines[authorizationIndex]).value);
    if (authorizationIndex !== -1 && configuredAuthorization !== authorizationValue) {
      throw new Error(
        `${lines[nestedHeaderStart].trim()} has a conflicting Authorization header; refusing to overwrite it`,
      );
    }
    if (authorizationIndex === -1) {
      lines.splice(lineageIndex + 1, 0, authorizationLine);
    }
  } else if (headerIndex === -1) {
    lines.splice(sectionStart + 2, 0, lineageLine);
  } else {
    const assignment = parseTomlAssignment(lines[headerIndex]);
    const headers = parseTomlInlineStringTable(assignment.value);
    const normalizedHeaders = headers
      ? normalizeHttpHeaderEntries(headers, `${lines[sectionStart].trim()} http_headers`)
      : null;
    if (!normalizedHeaders || normalizedHeaders.get('x-codex-route-lineage') !== 'current') {
      throw new Error(`${lines[sectionStart].trim()} already has custom http_headers; add X-Codex-Route-Lineage=current manually`);
    }
    if (normalizedHeaders.has('authorization') && normalizedHeaders.get('authorization') !== authorizationValue) {
      throw new Error(
        `${lines[sectionStart].trim()} has a conflicting Authorization header; refusing to overwrite it`,
      );
    }
    if (!normalizedHeaders.has('authorization')) {
      lines[headerIndex] = appendInlineStringTableEntry(
        lines[headerIndex],
        'Authorization',
        authorizationValue,
      );
    }
  }
}

const next = `${lines.join(newline)}${newline}`;
writeRouterBearerToken(bearerToken, bearerTokenFile);
writeEnvFile({
  ...env,
  AGENT_REMOTE_MCP_LOCAL_LISTEN: listen,
  AGENT_REMOTE_MCP_STATE_FILE: stateFile,
  AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: bearerTokenFile,
});
if (!fs.existsSync(stateFile)) {
  writeRouterState({ version: 1, targets: [], threads: {} }, stateFile);
}
if (next !== original) {
  if (fs.existsSync(configFile)) {
    const backup = `${configFile}.backup-before-agent-native-remote`;
    if (!fs.existsSync(backup)) fs.copyFileSync(configFile, backup);
    fs.chmodSync(backup, 0o600);
  }
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  fs.renameSync(temporary, configFile);
}
fs.chmodSync(configFile, 0o600);

console.log(`Codex MCP ${mcpName}: ${expectedUrl}`);
console.log(`Router state: ${stateFile}`);
console.log(`Router bearer token: ${bearerTokenFile}`);
console.log('A new Codex conversation is required after first-time MCP configuration.');
