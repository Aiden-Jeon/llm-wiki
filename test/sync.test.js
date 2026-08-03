import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkBlocks,
  computeSyncDiff,
  contentHash,
  loadNotionMap,
  pushSync,
  scanLocalPages,
} from '../src/sync.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-sync-'));
}

function writePage(vault, subdir, slug, fields, body = 'content') {
  const dir = path.join(vault, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) { fm.push(`${key}:`); for (const v of value) fm.push(`  - ${v}`); }
    else fm.push(`${key}: ${value}`);
  }
  fm.push('---', '', body, '');
  fs.writeFileSync(path.join(dir, `${slug}.md`), fm.join('\n'));
}

const BASE_FIELDS = { title: 'RAG', type: 'concept', status: 'active', created: '2024-01-01', updated: '2024-01-01', tags: ['llm'], sources: [] };

test('contentHash is stable regardless of frontmatter key order', () => {
  const a = contentHash({ title: 'X', type: 'concept' }, 'body');
  const b = contentHash({ type: 'concept', title: 'X' }, 'body');
  assert.equal(a, b);
  assert.notEqual(a, contentHash({ title: 'X', type: 'concept' }, 'different'));
});

test('computeSyncDiff classifies create/update/unchanged with no delete branch', () => {
  const pages = [
    { slug: 'new-page', fields: { title: 'N' }, body: 'a' },
    { slug: 'changed', fields: { title: 'C' }, body: 'new body' },
    { slug: 'same', fields: { title: 'S' }, body: 'same body' },
  ];
  const map = {
    pages: {
      changed: { notionPageId: 'id-c', hash: contentHash({ title: 'C' }, 'old body') },
      same: { notionPageId: 'id-s', hash: contentHash({ title: 'S' }, 'same body') },
    },
  };
  const diff = computeSyncDiff(pages, map);
  assert.deepEqual(diff.create.map((p) => p.slug), ['new-page']);
  assert.deepEqual(diff.update.map((p) => p.slug), ['changed']);
  assert.deepEqual(diff.unchanged.map((p) => p.slug), ['same']);
  assert.equal(diff.update[0].notionPageId, 'id-c');
});

test('scanLocalPages reads only the given subdirs', () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  writePage(vault, 'wiki/entities', 'openai', { ...BASE_FIELDS, type: 'entity' });
  const pages = scanLocalPages(vault, ['wiki/concepts']);
  assert.deepEqual(pages.map((p) => p.slug), ['rag']);
});

test('chunkBlocks splits at the 100-block limit', () => {
  const blocks = Array.from({ length: 250 }, (_, i) => i);
  const chunks = chunkBlocks(blocks);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
});

test('pushSync --dry-run reports the plan and writes nothing', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const summary = await pushSync(vault, { databaseId: 'db', subdirs: ['wiki/concepts'], dryRun: true });
  assert.equal(summary.planned.create, 1);
  assert.equal(summary.created, 0);
  assert.ok(!fs.existsSync(path.join(vault, '_meta', 'notion-map.json')));
});

test('pushSync creates pages via the injected client and records the mapping', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const calls = { create: 0, update: 0 };
  const client = {
    pages: {
      create: async () => { calls.create += 1; return { id: 'notion-1' }; },
      update: async () => { calls.update += 1; },
    },
    blocks: { children: { append: async () => {}, list: async () => ({ results: [] }) }, delete: async () => {} },
  };
  const summary = await pushSync(vault, { client, databaseId: 'db', subdirs: ['wiki/concepts'] });
  assert.equal(summary.created, 1);
  assert.equal(calls.create, 1);
  const map = loadNotionMap(vault);
  assert.equal(map.pages.rag.notionPageId, 'notion-1');
  assert.match(map.pages.rag.hash, /^sha256:/);
});

test('pushSync updates a changed page by replacing its blocks', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2 body');
  // 이전 sync 기록: 다른 hash로 두어 update 브랜치를 태운다.
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'notion-map.json'), JSON.stringify({
    version: 1,
    pages: { rag: { notionPageId: 'notion-1', hash: 'sha256:old', syncedAt: '2024-01-01', title: 'RAG' } },
  }));
  const calls = { update: 0, deleted: 0, appended: 0 };
  const client = {
    pages: { create: async () => ({ id: 'x' }), update: async () => { calls.update += 1; } },
    blocks: {
      children: {
        append: async () => { calls.appended += 1; },
        list: async () => ({ results: [{ id: 'old-block' }] }),
      },
      delete: async () => { calls.deleted += 1; },
    },
  };
  const summary = await pushSync(vault, { client, databaseId: 'db', subdirs: ['wiki/concepts'] });
  assert.equal(summary.updated, 1);
  assert.equal(calls.update, 1);
  assert.equal(calls.deleted, 1);
  assert.equal(loadNotionMap(vault).pages.rag.hash, contentHash({ ...BASE_FIELDS }, 'v2 body'));
});
