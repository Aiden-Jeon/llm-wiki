import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider, listProviders } from '../src/providers/index.js';
import { resolveRemoteToken } from '../src/providers/token.js';
import { loadRemoteConfig } from '../src/remote.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-provider-'));
}

test('getProvider returns a registered provider and rejects unknown names', () => {
  const notion = getProvider('notion');
  assert.equal(notion.name, 'notion');
  assert.equal(typeof notion.createRemotePage, 'function');
  assert.ok(listProviders().includes('notion'));
  assert.throws(() => getProvider('bogus'), /알 수 없는 원격 provider/);
});

test('resolveRemoteToken honors precedence per provider prefix', () => {
  const env = {
    LLMWIKI_NOTION_TOKEN: 'generic',
    LLMWIKI_NOTION_TOKEN_PERSONAL: 'per-vault',
    CUSTOM: 'custom',
  };
  assert.equal(resolveRemoteToken(env, { prefix: 'NOTION', vaultName: 'personal', config: { tokenEnv: 'CUSTOM' } }), 'custom');
  assert.equal(resolveRemoteToken(env, { prefix: 'NOTION', vaultName: 'personal' }), 'per-vault');
  assert.equal(resolveRemoteToken(env, { prefix: 'NOTION', vaultName: 'other' }), 'generic');
  assert.equal(resolveRemoteToken({ LLMWIKI_NOTION_TOKEN_PERSONAL_WIKI: 't' }, { prefix: 'NOTION', vaultName: 'personal-wiki' }), 't');
});

test('resolveRemoteToken throws listing the checked env vars when none set', () => {
  assert.throws(() => resolveRemoteToken({}, { prefix: 'NOTION', vaultName: 'work' }), /LLMWIKI_NOTION_TOKEN_WORK/);
});

test('loadRemoteConfig returns null when absent and defaults provider to notion', () => {
  const vault = tmpVault();
  assert.equal(loadRemoteConfig(vault), null);
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'remote.json'), '{"sync":{"databaseId":"db"}}');
  const config = loadRemoteConfig(vault);
  assert.equal(config.provider, 'notion');
  assert.equal(config.sync.databaseId, 'db');
});

test('loadRemoteConfig keeps an explicit provider and raises on invalid JSON', () => {
  const vault = tmpVault();
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'remote.json'), '{"provider":"confluence"}');
  assert.equal(loadRemoteConfig(vault).provider, 'confluence');
  fs.writeFileSync(path.join(vault, '_meta', 'remote.json'), '{bad');
  assert.throws(() => loadRemoteConfig(vault), /파싱 실패/);
});
