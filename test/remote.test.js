import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRemoteConfig, upsertRemoteConfig, writeRemoteConfig } from '../src/remote.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-remote-'));
}

test('writeRemoteConfig writes token-free JSON that round-trips via loadRemoteConfig', () => {
  const vault = tmpVault();
  writeRemoteConfig(vault, { version: 1, provider: 'notion', publish: { databaseId: 'db1' } });
  const raw = fs.readFileSync(path.join(vault, '_meta', 'remote.json'), 'utf8');
  assert.doesNotMatch(raw, /token/i);
  const config = loadRemoteConfig(vault);
  assert.equal(config.provider, 'notion');
  assert.equal(config.publish.databaseId, 'db1');
});

test('upsertRemoteConfig defaults provider and version when starting fresh', () => {
  const vault = tmpVault();
  const { config } = upsertRemoteConfig(vault, { inbox: { databaseId: 'ibx' } });
  assert.equal(config.provider, 'notion');
  assert.equal(config.version, 1);
  assert.equal(config.inbox.databaseId, 'ibx');
});

test('upsertRemoteConfig merges publish/inbox without clobbering other fields', () => {
  const vault = tmpVault();
  upsertRemoteConfig(vault, { publish: { databaseId: 'db1', titleProperty: 'Name' }, allowPublish: true });
  const { config } = upsertRemoteConfig(vault, { inbox: { databaseId: 'ibx' } });
  assert.equal(config.publish.databaseId, 'db1');
  assert.equal(config.publish.titleProperty, 'Name');
  assert.equal(config.allowPublish, true);
  assert.equal(config.inbox.databaseId, 'ibx');
});
