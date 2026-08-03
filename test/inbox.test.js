import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInboxState, pullInbox, selectNewItems } from '../src/inbox.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-inbox-'));
}

function fakePage(id, title) {
  return {
    id,
    created_time: '2026-08-03T10:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: title }] } },
  };
}

function stubClient(pages) {
  return {
    databases: { query: async () => ({ results: pages, has_more: false }) },
    blocks: {
      children: {
        list: async () => ({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } }], has_more: false }),
      },
    },
  };
}

test('selectNewItems drops already-pulled page ids', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(selectNewItems(items, { b: {} }).map((i) => i.id), ['a', 'c']);
});

test('pullInbox writes raw notes and records dedup state', async () => {
  const vault = tmpVault();
  const client = stubClient([fakePage('id-1', 'First'), fakePage('id-2', 'Second')]);
  const result = await pullInbox(vault, { client, databaseId: 'db' });
  assert.equal(result.pulled.length, 2);
  assert.equal(result.skipped, 0);

  const notesDir = path.join(vault, 'raw', 'notes');
  const files = fs.readdirSync(notesDir);
  assert.equal(files.length, 2);
  const first = fs.readFileSync(path.join(notesDir, files[0]), 'utf8');
  assert.match(first, /source: inbox/);
  assert.match(first, /notion_id: id-/);

  const state = loadInboxState(vault);
  assert.ok(state.pulled['id-1']);
  assert.ok(state.pulled['id-2']);
});

test('pullInbox skips items already in state and is idempotent', async () => {
  const vault = tmpVault();
  const pages = [fakePage('id-1', 'First')];
  await pullInbox(vault, { client: stubClient(pages), databaseId: 'db' });
  const second = await pullInbox(vault, { client: stubClient(pages), databaseId: 'db' });
  assert.equal(second.pulled.length, 0);
  assert.equal(second.skipped, 1);
  assert.equal(fs.readdirSync(path.join(vault, 'raw', 'notes')).length, 1);
});

test('pullInbox --dry-run lists items without writing files or state', async () => {
  const vault = tmpVault();
  const result = await pullInbox(vault, { client: stubClient([fakePage('id-1', 'First')]), databaseId: 'db', dryRun: true });
  assert.equal(result.pulled.length, 1);
  assert.equal(result.pulled[0].title, 'First');
  assert.ok(!fs.existsSync(path.join(vault, 'raw', 'notes')));
  assert.ok(!fs.existsSync(path.join(vault, '_meta', 'notion-inbox.json')));
});

test('pullInbox respects the limit', async () => {
  const vault = tmpVault();
  const client = stubClient([fakePage('id-1', 'A'), fakePage('id-2', 'B'), fakePage('id-3', 'C')]);
  const result = await pullInbox(vault, { client, databaseId: 'db', limit: 2 });
  assert.equal(result.pulled.length, 2);
});
