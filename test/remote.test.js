import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPublishStore,
  loadRemoteConfig,
  upsertRemoteConfig,
  removeRemoteConfig,
  listRemoteConfigs,
} from '../src/remote.js';

function tmpPublishPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-remote-'));
  return path.join(dir, 'publish.json');
}

test('upsertRemoteConfig writes token-free JSON that round-trips via loadRemoteConfig', () => {
  const publishPath = tmpPublishPath();
  upsertRemoteConfig(publishPath, 'personal', { provider: 'notion', publish: { databaseId: 'db1' } });
  const raw = fs.readFileSync(publishPath, 'utf8');
  assert.doesNotMatch(raw, /token/i);
  const config = loadRemoteConfig(publishPath, 'personal');
  assert.equal(config.provider, 'notion');
  assert.equal(config.publish.databaseId, 'db1');
});

test('loadRemoteConfig returns null for an unknown vault', () => {
  const publishPath = tmpPublishPath();
  assert.equal(loadRemoteConfig(publishPath, 'missing'), null);
});

test('upsertRemoteConfig defaults provider and version when starting fresh', () => {
  const publishPath = tmpPublishPath();
  const { config } = upsertRemoteConfig(publishPath, 'personal', { inbox: { databaseId: 'ibx' } });
  assert.equal(config.provider, 'notion');
  assert.equal(config.version, 1);
  assert.equal(config.inbox.databaseId, 'ibx');
});

test('upsertRemoteConfig merges publish/inbox without clobbering other fields', () => {
  const publishPath = tmpPublishPath();
  upsertRemoteConfig(publishPath, 'personal', { publish: { databaseId: 'db1', titleProperty: 'Name' }, connection: 'personal' });
  const { config } = upsertRemoteConfig(publishPath, 'personal', { inbox: { databaseId: 'ibx' } });
  assert.equal(config.publish.databaseId, 'db1');
  assert.equal(config.publish.titleProperty, 'Name');
  assert.equal(config.connection, 'personal');
  assert.equal(config.inbox.databaseId, 'ibx');
});

test('upsertRemoteConfig keeps vault entries independent in one store', () => {
  const publishPath = tmpPublishPath();
  upsertRemoteConfig(publishPath, 'personal', { publish: { databaseId: 'db-a' } });
  upsertRemoteConfig(publishPath, 'work', { publish: { databaseId: 'db-b' } });
  const store = loadPublishStore(publishPath);
  assert.equal(store.vaults.personal.publish.databaseId, 'db-a');
  assert.equal(store.vaults.work.publish.databaseId, 'db-b');
});

test('listRemoteConfigs returns all registered entries', () => {
  const publishPath = tmpPublishPath();
  upsertRemoteConfig(publishPath, 'personal', { publish: { databaseId: 'db-a' } });
  upsertRemoteConfig(publishPath, 'work', { inbox: { databaseId: 'ibx' } });
  const configs = listRemoteConfigs(publishPath);
  assert.deepEqual(Object.keys(configs).sort(), ['personal', 'work']);
});

test('removeRemoteConfig deletes an entry and reports whether it existed', () => {
  const publishPath = tmpPublishPath();
  upsertRemoteConfig(publishPath, 'personal', { publish: { databaseId: 'db-a' } });
  assert.equal(removeRemoteConfig(publishPath, 'personal'), true);
  assert.equal(loadRemoteConfig(publishPath, 'personal'), null);
  assert.equal(removeRemoteConfig(publishPath, 'personal'), false);
});
