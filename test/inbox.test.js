import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInboxState, pullInbox, selectNewItems } from '../src/inbox.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-inbox-'));
}

// provider-agnostic 스텁: 항목 배열을 그대로 목록으로 주고, 각 항목을 노트로 바꾼다.
function stubProvider(items) {
  return {
    name: 'stub',
    itemId: (item) => item.id,
    async listInboxItems() { return items; },
    async fetchInboxNote(_client, item) { return { title: item.title, markdown: 'body', createdAt: '2026-08-03' }; },
  };
}

test('selectNewItems drops already-pulled ids using the provider id function', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(selectNewItems(items, { b: {} }, (i) => i.id).map((i) => i.id), ['a', 'c']);
});

test('pullInbox writes raw notes and records dedup state', async () => {
  const vault = tmpVault();
  const provider = stubProvider([{ id: 'id-1', title: 'First' }, { id: 'id-2', title: 'Second' }]);
  const result = await pullInbox(vault, { provider, client: {}, ctx: { databaseId: 'db' } });
  assert.equal(result.pulled.length, 2);
  assert.equal(result.skipped, 0);

  const notesDir = path.join(vault, 'raw', 'notes');
  const files = fs.readdirSync(notesDir);
  assert.equal(files.length, 2);
  const first = fs.readFileSync(path.join(notesDir, files[0]), 'utf8');
  assert.match(first, /source: inbox/);
  assert.match(first, /remote_id: id-/);

  const state = loadInboxState(vault);
  assert.equal(state.provider, 'stub');
  assert.ok(state.pulled['id-1']);
  assert.ok(state.pulled['id-2']);
});

test('pullInbox skips items already in state and is idempotent', async () => {
  const vault = tmpVault();
  const items = [{ id: 'id-1', title: 'First' }];
  await pullInbox(vault, { provider: stubProvider(items), client: {}, ctx: {} });
  const second = await pullInbox(vault, { provider: stubProvider(items), client: {}, ctx: {} });
  assert.equal(second.pulled.length, 0);
  assert.equal(second.skipped, 1);
  assert.equal(fs.readdirSync(path.join(vault, 'raw', 'notes')).length, 1);
});

test('pullInbox --dry-run lists items without writing files or state', async () => {
  const vault = tmpVault();
  const result = await pullInbox(vault, { provider: stubProvider([{ id: 'id-1', title: 'First' }]), client: {}, ctx: {}, dryRun: true });
  assert.equal(result.pulled.length, 1);
  assert.equal(result.pulled[0].title, 'First');
  assert.ok(!fs.existsSync(path.join(vault, 'raw', 'notes')));
  assert.ok(!fs.existsSync(path.join(vault, '_meta', 'remote-inbox.json')));
});

test('pullInbox respects the limit', async () => {
  const vault = tmpVault();
  const provider = stubProvider([{ id: 'id-1', title: 'A' }, { id: 'id-2', title: 'B' }, { id: 'id-3', title: 'C' }]);
  const result = await pullInbox(vault, { provider, client: {}, ctx: {}, limit: 2 });
  assert.equal(result.pulled.length, 2);
});

test('pullInbox checkpoints completed files before a later fetch failure', async () => {
  const vault = tmpVault();
  const provider = stubProvider([{ id: 'id-1', title: 'First' }, { id: 'id-2', title: 'Second' }]);
  provider.fetchInboxNote = async (_client, item) => {
    if (item.id === 'id-2') throw new Error('fetch failed');
    return { title: item.title, markdown: 'body' };
  };

  await assert.rejects(pullInbox(vault, { provider, client: {}, ctx: {} }), /fetch failed/);
  const state = loadInboxState(vault);
  assert.ok(state.pulled['id-1']);
  assert.equal(state.pulled['id-2'], undefined);
  assert.equal(fs.readdirSync(path.join(vault, 'raw', 'notes')).length, 1);
});
