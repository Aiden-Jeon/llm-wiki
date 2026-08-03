import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backfillFields,
  computeSyncDiff,
  contentHash,
  loadRemoteMap,
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

// diff·상태만 검증하는 최소 스텁 provider.
function stubProvider(calls = { create: 0, update: 0 }) {
  return {
    name: 'stub',
    calls,
    async createRemotePage() { calls.create += 1; return `remote-${calls.create}`; },
    async updateRemotePage() { calls.update += 1; },
  };
}

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
      changed: { remoteId: 'id-c', hash: contentHash({ title: 'C' }, 'old body') },
      same: { remoteId: 'id-s', hash: contentHash({ title: 'S' }, 'same body') },
    },
  };
  const diff = computeSyncDiff(pages, map);
  assert.deepEqual(diff.create.map((p) => p.slug), ['new-page']);
  assert.deepEqual(diff.update.map((p) => p.slug), ['changed']);
  assert.deepEqual(diff.unchanged.map((p) => p.slug), ['same']);
  assert.equal(diff.update[0].remoteId, 'id-c');
});

test('scanLocalPages reads only the given subdirs', () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  writePage(vault, 'wiki/entities', 'openai', { ...BASE_FIELDS, type: 'entity' });
  const pages = scanLocalPages(vault, ['wiki/concepts']);
  assert.deepEqual(pages.map((p) => p.slug), ['rag']);
});

test('backfillFields fills status/created/updated but never invents other fields', () => {
  const filled = backfillFields({ title: 'x', type: 'concept' }, { gitDates: { created: '2024-05-01', updated: '2024-06-02' }, fallbackDate: '2026-01-01' });
  assert.equal(filled.status, 'active');
  assert.equal(filled.created, '2024-05-01');
  assert.equal(filled.updated, '2024-06-02');
  assert.equal(filled.tags, undefined);
  assert.equal(filled.summary, undefined);
});

test('backfillFields falls back to file date when no git history, and keeps existing values', () => {
  const filled = backfillFields({ title: 'x', type: 'concept', status: 'draft' }, { gitDates: null, fallbackDate: '2026-01-01' });
  assert.equal(filled.status, 'draft'); // 기존 값 보존
  assert.equal(filled.created, '2026-01-01');
  assert.equal(filled.updated, '2026-01-01');
});

test('scanLocalPages backfills sparse frontmatter', () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'sparse', { title: '머신 B', type: 'concept' });
  const [page] = scanLocalPages(vault, ['wiki/concepts']);
  assert.equal(page.fields.status, 'active');
  assert.match(page.fields.created, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(page.fields.updated, /^\d{4}-\d{2}-\d{2}$/);
});

test('pushSync --dry-run reports the plan and writes nothing', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const summary = await pushSync(vault, { provider: stubProvider(), subdirs: ['wiki/concepts'], dryRun: true });
  assert.equal(summary.planned.create, 1);
  assert.equal(summary.created, 0);
  assert.ok(!fs.existsSync(path.join(vault, '_meta', 'remote-map.json')));
});

test('pushSync creates pages via the provider and records the mapping', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const provider = stubProvider();
  const summary = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.equal(summary.created, 1);
  assert.equal(provider.calls.create, 1);
  const map = loadRemoteMap(vault);
  assert.equal(map.provider, 'stub');
  assert.equal(map.pages.rag.remoteId, 'remote-1');
  assert.match(map.pages.rag.hash, /^sha256:/);
});

test('pushSync updates a changed page and rewrites the stored hash', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2 body');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'remote-map.json'), JSON.stringify({
    version: 1,
    pages: { rag: { remoteId: 'remote-1', hash: 'sha256:old', syncedAt: '2024-01-01', title: 'RAG' } },
  }));
  const provider = stubProvider();
  const summary = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.equal(summary.updated, 1);
  assert.equal(provider.calls.update, 1);
  assert.equal(loadRemoteMap(vault).pages.rag.hash, contentHash({ ...BASE_FIELDS }, 'v2 body'));
});

test('pushSync auto-creates views once on first publish, then skips on the next run', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const provider = stubProvider();
  let viewCalls = 0;
  provider.createViews = async () => { viewCalls += 1; return ['All', 'By Type', 'Gallery', 'Recent']; };

  const first = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.deepEqual(first.viewsCreated, ['All', 'By Type', 'Gallery', 'Recent']);
  assert.equal(viewCalls, 1);
  assert.match(loadRemoteMap(vault).viewsCreated, /^\d{4}-\d{2}-\d{2}$/);

  // 두 번째 실행: 플래그가 있어 뷰를 다시 만들지 않는다(탭 중복 방지).
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'changed');
  const second = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.equal(second.viewsCreated, null);
  assert.equal(viewCalls, 1);
});

test('pushSync keeps publishing even if view creation fails', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);
  const provider = stubProvider();
  provider.createViews = async () => { throw new Error('boom'); };
  const summary = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.equal(summary.created, 1); // 발행은 성공
  assert.equal(summary.viewsError, 'boom');
  assert.equal(loadRemoteMap(vault).viewsCreated, undefined); // 실패 시 플래그 안 세움 → 다음에 재시도
});
