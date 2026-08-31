import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryDirectories = [];
const TEST_BEARER_TOKEN = 'configure-test-token-0123456789abcdef0123456789abcdef';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-remote-mcp-'));
  temporaryDirectories.push(directory);
  const skillDirectory = path.join(directory, 'skill');
  const scriptDirectory = path.join(skillDirectory, 'scripts');
  const codexHome = path.join(directory, 'codex-home');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  for (const file of ['configure-codex.mjs', 'env.mjs']) {
    fs.copyFileSync(path.join(sourceDirectory, file), path.join(scriptDirectory, file));
  }
  const configFile = path.join(codexHome, 'config.toml');
  const bearerTokenFile = path.join(codexHome, 'state', 'agent-remote-mcp', 'router-bearer-token');
  fs.writeFileSync(configFile, config, { mode: 0o600 });
  return {
    bearerTokenFile,
    codexHome,
    configFile,
    configure: path.join(scriptDirectory, 'configure-codex.mjs'),
    skillDirectory,
  };
}

function seedToken(current, token = TEST_BEARER_TOKEN) {
  fs.mkdirSync(path.dirname(current.bearerTokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(current.bearerTokenFile, `${token}\n`, { mode: 0o600 });
}

function run(current) {
  return spawnSync(process.execPath, [current.configure], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.dirname(current.codexHome),
      CODEX_HOME: current.codexHome,
      AGENT_REMOTE_MCP_CODEX_NAME: 'remote',
      AGENT_REMOTE_MCP_LOCAL_LISTEN: '127.0.0.1:7891',
      AGENT_REMOTE_MCP_LOCAL_BEARER_TOKEN_FILE: current.bearerTokenFile,
    },
  });
}

test('generates one private persistent token and configures both Router headers idempotently', () => {
  const current = fixture('');
  const first = run(current);
  assert.equal(first.status, 0, first.stderr);
  const token = fs.readFileSync(current.bearerTokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(current.bearerTokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(current.bearerTokenFile)).mode & 0o777, 0o700);

  const configured = fs.readFileSync(current.configFile, 'utf8');
  assert.match(configured, /"X-Codex-Route-Lineage" = "current"/);
  assert.ok(configured.includes(`"Authorization" = "Bearer ${token}"`));
  assert.equal(fs.statSync(current.configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(current.skillDirectory, '.env')).mode & 0o777, 0o600);

  const second = run(current);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(current.bearerTokenFile, 'utf8').trim(), token);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), configured);
});

test('repairs an already-correct config file that became world-readable', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    `http_headers = { "Authorization" = "Bearer ${TEST_BEARER_TOKEN}", "X-Codex-Route-Lineage" = "current" }`,
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  fs.chmodSync(current.configFile, 0o644);
  const result = run(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
  assert.equal(fs.statSync(current.configFile).mode & 0o777, 0o600);
});

test('upgrades a lineage-only inline header without dropping formatting or comments', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    '"http_headers" = { "X-Codex-Route-Lineage" = "current" } # keep this comment',
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const first = run(current);
  assert.equal(first.status, 0, first.stderr);
  const configured = fs.readFileSync(current.configFile, 'utf8');
  assert.ok(configured.includes(
    `"http_headers" = { "X-Codex-Route-Lineage" = "current", "Authorization" = "Bearer ${TEST_BEARER_TOKEN}" } # keep this comment`,
  ));
  const second = run(current);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), configured);
});

test('adds the generated Authorization value to a nested header table idempotently', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    '',
    '[mcp_servers.remote.http_headers]',
    '"X-Codex-Route-Lineage" = "current"',
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const first = run(current);
  assert.equal(first.status, 0, first.stderr);
  const configured = fs.readFileSync(current.configFile, 'utf8');
  assert.ok(configured.includes(
    `"X-Codex-Route-Lineage" = "current"\nAuthorization = "Bearer ${TEST_BEARER_TOKEN}"`,
  ));
  const second = run(current);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), configured);
});

test('refuses a conflicting Router Authorization value without creating local state', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    'http_headers = { "X-Codex-Route-Lineage" = "current", Authorization = "Bearer unrelated-existing-token-value-1234567890" }',
    '',
  ].join('\n');
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting Authorization header/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
  assert.equal(fs.existsSync(current.bearerTokenFile), false);
  assert.equal(fs.existsSync(path.join(current.skillDirectory, '.env')), false);
});

test('treats HTTP header names case-insensitively and rejects conflicts or duplicates', async (context) => {
  const cases = [
    {
      header: `http_headers = { authorization = "Bearer unrelated-existing-token-value-1234567890", "X-Codex-Route-Lineage" = "current" }`,
      expected: /conflicting Authorization header/,
    },
    {
      header: `http_headers = { Authorization = "Bearer ${TEST_BEARER_TOKEN}", authorization = "Bearer ${TEST_BEARER_TOKEN}", "X-Codex-Route-Lineage" = "current" }`,
      expected: /more than once.*case-insensitive/,
    },
  ];
  for (const currentCase of cases) {
    await context.test(currentCase.header, () => {
      const original = [
        '[mcp_servers.remote]',
        'url = "http://127.0.0.1:7891/mcp"',
        currentCase.header,
        '',
      ].join('\n');
      const current = fixture(original);
      seedToken(current);
      const result = run(current);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, currentCase.expected);
      assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
    });
  }
});

test('refuses alternate Codex bearer sources that could override managed local auth', async (context) => {
  const cases = [
    'bearer_token_env_var = "REMOTE_ROUTER_TOKEN"',
    'env_http_headers = { Authorization = "REMOTE_ROUTER_TOKEN" }',
    'env_http_headers.authorization = "REMOTE_ROUTER_TOKEN"',
  ];
  for (const alternative of cases) {
    await context.test(alternative, () => {
      const original = [
        '[mcp_servers.remote]',
        'url = "http://127.0.0.1:7891/mcp"',
        alternative,
        '',
      ].join('\n');
      const current = fixture(original);
      const result = run(current);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /bearer authentication|delegates Authorization/);
      assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
      assert.equal(fs.existsSync(current.bearerTokenFile), false);
    });
  }

  await context.test('nested env_http_headers Authorization', () => {
    const original = [
      '[mcp_servers.remote]',
      'url = "http://127.0.0.1:7891/mcp"',
      '',
      '[mcp_servers.remote.env_http_headers]',
      'authorization = "REMOTE_ROUTER_TOKEN"',
      '',
    ].join('\n');
    const current = fixture(original);
    const result = run(current);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delegates Authorization/);
    assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
    assert.equal(fs.existsSync(current.bearerTokenFile), false);
  });
});

test('reuses a quoted equivalent MCP table without adding a duplicate', () => {
  const original = [
    '[mcp_servers."remote"]',
    'url = "http://127.0.0.1:7891/mcp"',
    `http_headers = { "Authorization" = "Bearer ${TEST_BEARER_TOKEN}", "X-Codex-Route-Lineage" = "current" }`,
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const first = run(current);
  assert.equal(first.status, 0, first.stderr);
  const second = run(current);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
  assert.equal((original.match(/\[mcp_servers/g) || []).length, 1);
});

test('reuses quoted assignment keys and literal URL strings', () => {
  const original = [
    '[mcp_servers.remote]',
    '"url" = \'http://127.0.0.1:7891/mcp\' # keep this style',
    `"http_headers" = { "X-Codex-Route-Lineage" = "current", Authorization = "Bearer ${TEST_BEARER_TOKEN}" }`,
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const result = run(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('preserves nested configuration tables below the MCP server', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    `http_headers = { "Authorization" = "Bearer ${TEST_BEARER_TOKEN}", "X-Codex-Route-Lineage" = "current" }`,
    '',
    '[mcp_servers.remote.tools.exec]',
    'approval_mode = "never"',
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const result = run(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('preserves a nested http_headers table with the required lineage', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    '',
    '[mcp_servers."remote"."http_headers"]',
    '"X-Codex-Route-Lineage" = "current"',
    `Authorization = "Bearer ${TEST_BEARER_TOKEN}"`,
    '',
  ].join('\n');
  const current = fixture(original);
  seedToken(current);
  const first = run(current);
  assert.equal(first.status, 0, first.stderr);
  const second = run(current);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('refuses a nested http_headers table without the required lineage', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    '',
    '[mcp_servers.remote.http_headers]',
    'Authorization = "Bearer existing-value"',
    '',
  ].join('\n');
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain X-Codex-Route-Lineage/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(current.skillDirectory, '.env')), false);
});

test('refuses simultaneous inline and nested http_headers declarations', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    'http_headers = { "X-Codex-Route-Lineage" = "current" }',
    '',
    '[mcp_servers.remote.http_headers]',
    '"X-Codex-Route-Lineage" = "current"',
    '',
  ].join('\n');
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /both inline and as a table/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('refuses an implicit MCP parent created only by a nested table', () => {
  const original = [
    '[mcp_servers.remote.http_headers]',
    '"X-Codex-Route-Lineage" = "current"',
    '',
  ].join('\n');
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /defined implicitly by a nested TOML table/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('refuses a conflicting quoted MCP table without changing config', () => {
  const original = '[mcp_servers."remote"]\nurl = "http://127.0.0.1:9999/mcp"\n';
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different URL/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(current.skillDirectory, '.env')), false);
});

test('refuses duplicate bare and quoted equivalent tables', () => {
  const original = [
    '[mcp_servers.remote]',
    'url = "http://127.0.0.1:7891/mcp"',
    '',
    '[mcp_servers."remote"]',
    'url = "http://127.0.0.1:7891/mcp"',
    '',
  ].join('\n');
  const current = fixture(original);
  const result = run(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /declared more than once/);
  assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
});

test('refuses dotted and inline definitions that would conflict with a table', async (context) => {
  const cases = [
    'mcp_servers.remote.url = "http://127.0.0.1:7891/mcp"\n',
    'mcp_servers.remote = { url = "http://127.0.0.1:7891/mcp" }\n',
    '[mcp_servers]\nremote = { url = "http://127.0.0.1:7891/mcp" }\n',
    'mcp_servers = { remote = { url = "http://127.0.0.1:7891/mcp" } }\n',
  ];
  for (const original of cases) {
    await context.test(original.split('\n')[0], () => {
      const current = fixture(original);
      const result = run(current);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /dotted or inline TOML key/);
      assert.equal(fs.readFileSync(current.configFile, 'utf8'), original);
    });
  }
});
