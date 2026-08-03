import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider, listProviders } from '../src/providers/index.js';
import { resolveRemoteToken } from '../src/providers/token.js';
import { loadRemoteConfig } from '../src/remote.js';
import { addConnection } from '../src/secrets.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-provider-'));
}

function tmpPublishPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-provider-')), 'publish.json');
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

test('resolveRemoteToken falls back to the secrets store when env is empty', () => {
  const file = path.join(tmpVault(), 'secrets.json');
  addConnection(file, 'notion', 'personal', { token: 'stored-token' });
  assert.equal(
    resolveRemoteToken({}, { prefix: 'NOTION', vaultName: 'personal', secretsPath: file, provider: 'notion' }),
    'stored-token',
  );
});

test('resolveRemoteToken lets env win over the secrets store', () => {
  const file = path.join(tmpVault(), 'secrets.json');
  addConnection(file, 'notion', 'personal', { token: 'stored-token' });
  assert.equal(
    resolveRemoteToken({ LLMWIKI_NOTION_TOKEN_PERSONAL: 'env-token' }, { prefix: 'NOTION', vaultName: 'personal', secretsPath: file, provider: 'notion' }),
    'env-token',
  );
});

test('loadRemoteConfig returns null when absent and defaults provider to notion', () => {
  const publishPath = tmpPublishPath();
  assert.equal(loadRemoteConfig(publishPath, 'personal'), null);
  fs.writeFileSync(publishPath, '{"version":1,"vaults":{"personal":{"publish":{"databaseId":"db"}}}}');
  const config = loadRemoteConfig(publishPath, 'personal');
  assert.equal(config.provider, 'notion');
  assert.equal(config.publish.databaseId, 'db');
});

test('loadRemoteConfig keeps an explicit provider and raises on invalid JSON', () => {
  const publishPath = tmpPublishPath();
  fs.writeFileSync(publishPath, '{"version":1,"vaults":{"personal":{"provider":"confluence"}}}');
  assert.equal(loadRemoteConfig(publishPath, 'personal').provider, 'confluence');
  fs.writeFileSync(publishPath, '{bad');
  assert.throws(() => loadRemoteConfig(publishPath, 'personal'), /파싱 실패/);
});
