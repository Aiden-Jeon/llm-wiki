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
  const summary = await pushSync(vault, { provider: stubProvider(), client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'], dryRun: true });
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
  assert.equal(map.version, 2);
  assert.ok(map.databases.db);
  assert.equal(map.databases.db.pages.rag.remoteId, 'remote-1');
  assert.match(map.databases.db.pages.rag.hash, /^sha256:/);
});

test('pushSync checkpoints completed creates before a later provider failure', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'a', { ...BASE_FIELDS, title: 'A' });
  writePage(vault, 'wiki/concepts', 'b', { ...BASE_FIELDS, title: 'B' });
  let calls = 0;
  const provider = {
    name: 'stub',
    async createRemotePage() {
      calls += 1;
      if (calls === 2) throw new Error('second failed');
      return 'remote-a';
    },
    async updateRemotePage() {},
  };

  await assert.rejects(
    pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] }),
    /second failed/,
  );
  const pages = loadRemoteMap(vault).databases.db.pages;
  assert.equal(pages.a.remoteId, 'remote-a');
  assert.equal(pages.b, undefined);
});

test('pushSync updates a changed page and rewrites the stored hash', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2 body');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'remote-map.json'), JSON.stringify({
    version: 2,
    databases: {
      db: {
        pages: { rag: { remoteId: 'remote-1', hash: 'sha256:old', syncedAt: '2024-01-01', title: 'RAG' } },
      },
    },
  }));
  const provider = stubProvider();
  const summary = await pushSync(vault, { provider, client: {}, ctx: { databaseId: 'db' }, subdirs: ['wiki/concepts'] });
  assert.equal(summary.updated, 1);
  assert.equal(provider.calls.update, 1);
  assert.equal(loadRemoteMap(vault).databases.db.pages.rag.hash, contentHash({ ...BASE_FIELDS }, 'v2 body'));
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
  assert.match(loadRemoteMap(vault).databases.db.viewsCreated, /^\d{4}-\d{2}-\d{2}$/);

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
  assert.equal(loadRemoteMap(vault).databases.db.viewsCreated, undefined); // 실패 시 플래그 안 세움 → 다음에 재시도
});

test('loadRemoteMap migrates v1 flat map with databaseId to v2 databases[dbId]', () => {
  const vault = tmpVault();
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  // v1 레거시 맵
  fs.writeFileSync(path.join(vault, '_meta', 'remote-map.json'), JSON.stringify({
    version: 1,
    provider: 'notion',
    databaseId: 'db-old',
    viewsCreated: '2024-01-01',
    pages: { rag: { remoteId: 'remote-1', hash: 'sha256:abc', syncedAt: '2024-01-01', title: 'RAG' } },
  }));

  const map = loadRemoteMap(vault);
  assert.equal(map.version, 2);
  assert.equal(map.provider, 'notion');
  assert.ok(map.databases['db-old']);
  assert.equal(map.databases['db-old'].viewsCreated, '2024-01-01');
  assert.equal(map.databases['db-old'].pages.rag.remoteId, 'remote-1');
});

test('loadRemoteMap drops pages from v1 map without databaseId (unattributable)', () => {
  const vault = tmpVault();
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  // v1 맵이지만 databaseId가 없다: pages를 버린다
  fs.writeFileSync(path.join(vault, '_meta', 'remote-map.json'), JSON.stringify({
    version: 1,
    pages: { rag: { remoteId: 'remote-1', hash: 'sha256:abc', syncedAt: '2024-01-01', title: 'RAG' } },
  }));

  const map = loadRemoteMap(vault);
  assert.equal(map.version, 2);
  assert.deepEqual(map.databases, {}); // pages 버려짐
});

test('pushSync to database A records under databases.A; switching to B records under databases.B independently', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);

  // DB A에 발행
  const providerA = stubProvider();
  const firstA = await pushSync(vault, { provider: providerA, client: {}, ctx: { databaseId: 'db-a' }, subdirs: ['wiki/concepts'] });
  assert.equal(firstA.created, 1);

  let map = loadRemoteMap(vault);
  assert.ok(map.databases['db-a']);
  assert.equal(map.databases['db-a'].pages.rag.remoteId, 'remote-1');
  assert.ok(!map.databases['db-b']); // db-b는 아직 없다

  // 내용 변경 후 DB B에 발행 (새로운 provider 사용)
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2');
  const providerB = stubProvider();
  const firstB = await pushSync(vault, { provider: providerB, client: {}, ctx: { databaseId: 'db-b' }, subdirs: ['wiki/concepts'] });
  assert.equal(firstB.created, 1); // db-b에 새로 생성 (a의 매핑을 재사용 안 함)

  map = loadRemoteMap(vault);
  assert.ok(map.databases['db-a']); // db-a 매핑은 그대로 보존됨
  assert.equal(map.databases['db-a'].pages.rag.remoteId, 'remote-1');
  assert.ok(map.databases['db-b']); // db-b 매핑도 있다
  assert.equal(map.databases['db-b'].pages.rag.remoteId, 'remote-1'); // 새로 생성됨 (독립적)
});

test('pushSync switches back to database A and uses its preserved mapping', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);

  // DB A, 그 다음 DB B, 다시 DB A로
  const providerA1 = stubProvider();
  await pushSync(vault, { provider: providerA1, client: {}, ctx: { databaseId: 'db-a' }, subdirs: ['wiki/concepts'] });

  const providerB = stubProvider();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2-for-b');
  await pushSync(vault, { provider: providerB, client: {}, ctx: { databaseId: 'db-b' }, subdirs: ['wiki/concepts'] });

  // DB A로 돌아와서, 내용을 변경한다 (원본과 다르게)
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v3-back-to-a');
  const providerA2 = stubProvider();
  const backToA = await pushSync(vault, { provider: providerA2, client: {}, ctx: { databaseId: 'db-a' }, subdirs: ['wiki/concepts'] });

  // db-a의 매핑이 보존돼 있고 내용이 변경됐으므로 update로 처리 (create가 아님)
  assert.equal(backToA.updated, 1);
  assert.equal(backToA.created, 0);
  assert.equal(providerA2.calls.update, 1);
  assert.equal(providerA2.calls.create, 0);
});

test('pushSync per-database viewsCreated: first publish to a DB creates views, second to same DB skips', async () => {
  const vault = tmpVault();
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS);

  // DB A에 처음 발행: 뷰 생성
  const providerA1 = stubProvider();
  let viewCallsA = 0;
  providerA1.createViews = async () => { viewCallsA += 1; return ['All']; };
  const firstA = await pushSync(vault, { provider: providerA1, client: {}, ctx: { databaseId: 'db-a' }, subdirs: ['wiki/concepts'] });
  assert.equal(viewCallsA, 1);
  assert.ok(firstA.viewsCreated);

  // DB A로 다시: 뷰 안 만듦 (플래그 있음)
  writePage(vault, 'wiki/concepts', 'rag', BASE_FIELDS, 'v2');
  const providerA2 = stubProvider();
  providerA2.createViews = async () => { viewCallsA += 1; return ['All']; };
  const secondA = await pushSync(vault, { provider: providerA2, client: {}, ctx: { databaseId: 'db-a' }, subdirs: ['wiki/concepts'] });
  assert.equal(viewCallsA, 1); // 증가 안 함

  // DB B로 발행: db-b는 아직 viewsCreated가 없으므로 뷰 생성
  const providerB = stubProvider();
  let viewCallsB = 0;
  providerB.createViews = async () => { viewCallsB += 1; return ['All']; };
  const firstB = await pushSync(vault, { provider: providerB, client: {}, ctx: { databaseId: 'db-b' }, subdirs: ['wiki/concepts'] });
  assert.equal(viewCallsB, 1);
  assert.ok(firstB.viewsCreated);
});
