import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySchema,
  buildViewRequests,
  chunkBlocks,
  createDatabase,
  createRemotePage,
  createViews,
  diffPublishSchema,
  extractDatabaseTitle,
  extractNotionTitle,
  fetchInboxNote,
  findTitleProperty,
  frontmatterToProperties,
  iconForType,
  inspectDatabase,
  itemId,
  listDatabases,
  listInboxItems,
  listPages,
  markdownToBlocks,
  parseRichText,
  updateRemotePage,
  validateToken,
  verifyDatabase,
} from '../src/providers/notion.js';

test('markdownToBlocks maps headings (clamped to 3), lists, to-do, quote, divider', () => {
  const blocks = markdownToBlocks('# H1\n#### H4\n- a\n1. b\n- [x] done\n- [ ] todo\n> quote\n---');
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, [
    'heading_1', 'heading_3', 'bulleted_list_item', 'numbered_list_item',
    'to_do', 'to_do', 'quote', 'divider',
  ]);
  assert.equal(blocks[4].to_do.checked, true);
  assert.equal(blocks[5].to_do.checked, false);
});

test('markdownToBlocks captures code fences with language fallback', () => {
  const [withLang] = markdownToBlocks('```js\nconst x = 1;\n```');
  assert.equal(withLang.type, 'code');
  assert.equal(withLang.code.language, 'js');
  assert.equal(withLang.code.rich_text[0].text.content, 'const x = 1;');
  const [noLang] = markdownToBlocks('```\nplain\n```');
  assert.equal(noLang.code.language, 'plain text');
});

test('parseRichText splits bold, italic, code, and links', () => {
  const runs = parseRichText('a **b** c `d` [e](http://x)');
  assert.equal(runs[1].text.content, 'b');
  assert.equal(runs[1].annotations.bold, true);
  assert.equal(runs[3].annotations.code, true);
  const link = runs.find((r) => r.text.link);
  assert.equal(link.text.link.url, 'http://x');
});

test('parseRichText drops non-absolute link URLs but keeps the text', () => {
  for (const url of ['./foo.md', '../a/b.md', '#anchor', 'notes/x.md']) {
    const runs = parseRichText(`see [here](${url})`);
    const linked = runs.find((r) => r.text.link);
    assert.equal(linked, undefined, `expected no link for ${JSON.stringify(url)}`);
    assert.ok(runs.some((r) => r.text.content === 'here'), 'link text should survive');
  }
  // 절대 URL·mailto는 그대로 링크가 된다.
  assert.equal(parseRichText('[a](https://x.io)').find((r) => r.text.link).text.link.url, 'https://x.io');
  assert.equal(parseRichText('[m](mailto:a@b.co)').find((r) => r.text.link).text.link.url, 'mailto:a@b.co');
});

test('frontmatterToProperties maps fields to typed Notion properties', () => {
  const props = frontmatterToProperties({
    title: 'RAG',
    type: 'concept',
    status: 'active',
    tags: ['llm', 'rag'],
    summary: 'Retrieval-augmented generation',
    confidence: 'high',
    created: '2024-01-15',
    updated: '2026-08-03',
    source_url: 'http://x',
  });
  assert.equal(props.Name.title[0].text.content, 'RAG');
  assert.equal(props.Type.select.name, 'concept');
  assert.equal(props.Status.select.name, 'active');
  assert.deepEqual(props.Tags.multi_select.map((t) => t.name), ['llm', 'rag']);
  assert.equal(props.Summary.rich_text[0].text.content, 'Retrieval-augmented generation');
  assert.equal(props.Confidence.select.name, 'high');
  assert.equal(props.Created.date.start, '2024-01-15');
  assert.equal(props['Source URL'].url, 'http://x');
});

test('frontmatterToProperties respects a custom title property name and omits empty tags', () => {
  const props = frontmatterToProperties({ title: 'X', tags: [] }, { titleProp: 'Title' });
  assert.ok(props.Title.title);
  assert.equal(props.Tags, undefined);
});

test('frontmatterToProperties omits optional summary/confidence when absent', () => {
  const props = frontmatterToProperties({ title: 'X' });
  assert.equal(props.Summary, undefined);
  assert.equal(props.Confidence, undefined);
});

test('chunkBlocks splits at the 100-block limit', () => {
  const blocks = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(chunkBlocks(blocks).map((c) => c.length), [100, 100, 50]);
});

test('iconForType maps each wiki type to an emoji and falls back for unknown', () => {
  assert.equal(iconForType('entity').emoji, '🏢');
  assert.equal(iconForType('concept').emoji, '🧩');
  assert.equal(iconForType('source').emoji, '📄');
  assert.equal(iconForType('analysis').emoji, '🔍');
  assert.equal(iconForType(undefined).emoji, '📝');
  assert.equal(iconForType('mystery').emoji, '📝');
});

test('createRemotePage builds properties + blocks + type icon and returns the new page id', async () => {
  const calls = { create: 0, append: 0 };
  let seenIcon;
  const client = {
    pages: { create: async (arg) => { calls.create += 1; assert.equal(arg.parent.database_id, 'db'); seenIcon = arg.icon; return { id: 'p1' }; } },
    blocks: { children: { append: async () => { calls.append += 1; } } },
  };
  const id = await createRemotePage(client, { databaseId: 'db' }, { fields: { title: 'X', type: 'concept' }, body: '# a' });
  assert.equal(id, 'p1');
  assert.equal(calls.create, 1);
  assert.equal(seenIcon.emoji, '🧩');
});

test('updateRemotePage replaces children and updates properties + icon', async () => {
  const calls = { update: 0, deleted: 0, append: 0 };
  let seenIcon;
  const client = {
    pages: { update: async (arg) => { calls.update += 1; seenIcon = arg.icon; } },
    blocks: {
      children: { list: async () => ({ results: [{ id: 'old' }] }), append: async () => { calls.append += 1; } },
      delete: async () => { calls.deleted += 1; },
    },
  };
  await updateRemotePage(client, { databaseId: 'db' }, 'p1', { fields: { title: 'X', type: 'entity' }, body: 'body' });
  assert.equal(calls.update, 1);
  assert.equal(calls.deleted, 1);
  assert.equal(calls.append, 1);
  assert.equal(seenIcon.emoji, '🏢');
});

test('updateRemotePage paginates all existing children before deleting them', async () => {
  const deleted = [];
  let listCalls = 0;
  const client = {
    pages: { update: async () => {} },
    blocks: {
      children: {
        list: async ({ start_cursor: cursor }) => {
          listCalls += 1;
          return cursor
            ? { results: [{ id: 'old-2' }], has_more: false }
            : { results: [{ id: 'old-1' }], has_more: true, next_cursor: 'next' };
        },
        append: async () => {},
      },
      delete: async ({ block_id: id }) => { deleted.push(id); },
    },
  };

  await updateRemotePage(client, {}, 'p1', { fields: { title: 'X' }, body: 'new' });
  assert.equal(listCalls, 2);
  assert.deepEqual(deleted, ['old-1', 'old-2']);
});

test('buildViewRequests creates 4 views; board uses property_id, sorts use property name', () => {
  const requests = buildViewRequests({ dataSourceId: 'ds1', databaseId: 'db', propertyIds: { Type: 'tid' }, propertyNames: ['Type', 'Updated'] });
  assert.deepEqual(requests.map((r) => r.name), ['All', 'By Type', 'Gallery', 'Recent']);
  const board = requests.find((r) => r.name === 'By Type');
  assert.equal(board.type, 'board');
  assert.equal(board.configuration.group_by.property_id, 'tid');
  const all = requests.find((r) => r.name === 'All');
  assert.equal(all.sorts[0].property, 'Updated'); // Views API sorts는 이름을 쓴다
  assert.equal(all.sorts[0].direction, 'descending');
  // Views API는 data_source_id + database_id를 함께 요구한다.
  for (const r of requests) { assert.equal(r.data_source_id, 'ds1'); assert.equal(r.database_id, 'db'); }
});

test('buildViewRequests skips the board view when Type property is missing, and requires ids', () => {
  const requests = buildViewRequests({ dataSourceId: 'ds1', databaseId: 'db', propertyIds: {}, propertyNames: [] });
  assert.deepEqual(requests.map((r) => r.name), ['All', 'Gallery', 'Recent']);
  const all = requests.find((r) => r.name === 'All');
  assert.equal(all.sorts, undefined); // Updated 없으면 정렬도 생략
  assert.throws(() => buildViewRequests({}), /data_source_id/);
  assert.throws(() => buildViewRequests({ dataSourceId: 'ds1' }), /database_id/);
});

// createViews 테스트용 fake client 팩토리. 초기 뷰 목록(existingViews)을 받는다.
function viewsClient(existingViews = []) {
  const calls = { create: [], update: [] };
  const store = existingViews.map((v) => ({ ...v }));
  const client = {
    databases: { retrieve: async () => ({ id: 'db', data_sources: [{ id: 'ds1' }] }) },
    dataSources: { retrieve: async () => ({ properties: { Type: { id: 'tid' }, Updated: { id: 'uid' } } }) },
    views: {
      create: async (req) => { calls.create.push(req); },
      list: async () => ({ results: store.map((v) => ({ id: v.id })), has_more: false }),
      retrieve: async ({ view_id }) => store.find((v) => v.id === view_id),
      update: async (req) => { calls.update.push(req); },
    },
  };
  return { client, calls };
}

test('createViews absorbs the default table view into All and creates the other three', async () => {
  // 새 DB엔 Notion이 기본 Table 뷰('Default view')를 하나 준다.
  const { client, calls } = viewsClient([{ id: 'def', name: 'Default view', type: 'table' }]);
  const touched = await createViews(client, { databaseId: 'db' });
  assert.deepEqual(touched, ['All', 'By Type', 'Gallery', 'Recent']);
  // All은 기본 뷰를 update로 흡수(중복 방지), 나머지 3개는 create.
  assert.deepEqual(calls.update.map((r) => r.view_id), ['def']);
  assert.deepEqual(calls.create.map((r) => r.name), ['By Type', 'Gallery', 'Recent']);
  // update 바디엔 type·부모 id가 없고 name·sorts만 있다.
  assert.equal(calls.update[0].name, 'All');
  assert.equal(calls.update[0].type, undefined);
  assert.equal(calls.update[0].sorts[0].property, 'Updated');
  assert.equal(calls.create[0].configuration.group_by.property_id, 'tid');
});

test('createViews is idempotent: re-running updates all four and creates none', async () => {
  const { client, calls } = viewsClient([
    { id: 'v1', name: 'All', type: 'table' },
    { id: 'v2', name: 'By Type', type: 'board' },
    { id: 'v3', name: 'Gallery', type: 'gallery' },
    { id: 'v4', name: 'Recent', type: 'list' },
  ]);
  const touched = await createViews(client, { databaseId: 'db' });
  assert.deepEqual(touched, ['All', 'By Type', 'Gallery', 'Recent']);
  assert.equal(calls.create.length, 0); // 재실행해도 탭이 늘지 않는다
  assert.deepEqual(calls.update.map((r) => r.view_id).sort(), ['v1', 'v2', 'v3', 'v4']);
});

test('createViews errors when the SDK has no views endpoint (old @notionhq/client)', async () => {
  const client = { databases: { retrieve: async () => ({ id: 'db', data_sources: [{ id: 'ds1' }] }) } };
  await assert.rejects(() => createViews(client, { databaseId: 'db' }), /5\.x/);
});

test('listInboxItems paginates and itemId/extractNotionTitle read a page', async () => {
  const pages = [
    { id: 'a', properties: { Name: { type: 'title', title: [{ plain_text: 'First' }] } } },
    { id: 'b', properties: { Name: { type: 'title', title: [{ plain_text: 'Second' }] } } },
  ];
  let calls = 0;
  const client = {
    databases: { retrieve: async () => ({ id: 'db', data_sources: [{ id: 'ds1' }] }) },
    dataSources: {
      query: async ({ data_source_id, start_cursor }) => {
        assert.equal(data_source_id, 'ds1');
        calls += 1;
        if (!start_cursor) return { results: [pages[0]], has_more: true, next_cursor: 'c2' };
        return { results: [pages[1]], has_more: false };
      },
    },
  };
  const items = await listInboxItems(client, { databaseId: 'db' });
  assert.equal(items.length, 2);
  assert.equal(calls, 2);
  assert.equal(itemId(items[0]), 'a');
  assert.equal(extractNotionTitle(items[0]), 'First');
});

test('fetchInboxNote turns page blocks into markdown', async () => {
  const client = {
    blocks: {
      children: {
        list: async () => ({
          results: [
            { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
            { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } },
          ],
          has_more: false,
        }),
      },
    },
  };
  const note = await fetchInboxNote(client, { id: 'p1', created_time: '2026-08-03T10:00:00Z', properties: { Name: { type: 'title', title: [{ plain_text: 'Hello' }] } } });
  assert.equal(note.title, 'Hello');
  assert.equal(note.createdAt, '2026-08-03');
  assert.equal(note.markdown, '# Title\n\nbody');
});

test('extractDatabaseTitle reads a database title rich_text array', () => {
  assert.equal(extractDatabaseTitle({ title: [{ plain_text: 'Wiki' }, { plain_text: ' DB' }] }), 'Wiki DB');
  assert.equal(extractDatabaseTitle({}), '');
});

test('validateToken resolves on users.me and surfaces a friendly error otherwise', async () => {
  const ok = await validateToken({ users: { me: async () => ({ id: 'u1', name: 'Bot' }) } });
  assert.equal(ok.ok, true);
  assert.equal(ok.account, 'Bot');
  await assert.rejects(
    () => validateToken({ users: { me: async () => { throw { code: 'unauthorized', message: 'API token is invalid.' }; } } }),
    /토큰 검증 실패.*unauthorized/,
  );
});

test('verifyDatabase resolves the title, rejects missing id, and reports not-found', async () => {
  const found = await verifyDatabase({ databases: { retrieve: async () => ({ title: [{ plain_text: 'Notes' }] }) } }, { databaseId: 'db' });
  assert.equal(found.title, 'Notes');
  await assert.rejects(() => verifyDatabase({ databases: {} }, {}), /데이터베이스 id가 필요/);
  await assert.rejects(
    () => verifyDatabase({ databases: { retrieve: async () => { throw { code: 'object_not_found', message: 'Could not find database.' }; } } }, { databaseId: 'bad' }),
    /데이터베이스\(bad\) 확인 실패.*object_not_found/,
  );
});

test('findTitleProperty finds the title property by type, defaulting to Name', () => {
  assert.equal(findTitleProperty({ properties: { 제목: { type: 'title' }, Tags: { type: 'multi_select' } } }), '제목');
  assert.equal(findTitleProperty({ properties: { Tags: { type: 'multi_select' } } }), 'Name');
});

test('diffPublishSchema reports a full match as ok with no missing/conflicts', () => {
  const db = { properties: {
    Name: { type: 'title' }, Type: { type: 'select' }, Status: { type: 'select' },
    Tags: { type: 'multi_select' }, Summary: { type: 'rich_text' }, Confidence: { type: 'select' },
    Created: { type: 'date' }, Updated: { type: 'date' }, 'Source URL': { type: 'url' },
  } };
  const diff = diffPublishSchema(db);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.conflicts, []);
  assert.equal(diff.titleProperty, 'Name');
});

test('diffPublishSchema separates missing columns from type conflicts (title name is flexible)', () => {
  const db = { properties: {
    제목: { type: 'title' },        // 이름 달라도 title이면 충족
    Status: { type: 'rich_text' },  // 타입 충돌
    Tags: { type: 'multi_select' },
  } };
  const diff = diffPublishSchema(db);
  assert.equal(diff.ok, false);
  assert.equal(diff.titleProperty, '제목');
  assert.deepEqual(diff.conflicts, [{ name: 'Status', expected: 'select', actual: 'rich_text' }]);
  // Type/Summary/Confidence/Created/Updated/Source URL 누락 (Status는 충돌로 분류돼 missing 아님)
  assert.deepEqual(diff.missing, ['Type', 'Summary', 'Confidence', 'Created', 'Updated', 'Source URL']);
});

test('listDatabases finds data sources and resolves their parent database id', async () => {
  const client = {
    search: async ({ filter, start_cursor }) => {
      assert.equal(filter.value, 'data_source'); // API 2025-09-03: database가 아니라 data_source를 검색
      if (!start_cursor) {
        return {
          results: [
            { id: 'ds1', title: [{ plain_text: 'Wiki' }], database_parent: { type: 'database_id', database_id: 'd1' } },
            { id: 'dsX', title: [{ plain_text: 'Wiki' }], database_parent: { type: 'database_id', database_id: 'd1' } }, // 같은 DB의 두 번째 data_source → 중복 제거
          ],
          has_more: true,
          next_cursor: 'c2',
        };
      }
      return { results: [{ id: 'ds2', title: [], database_parent: { type: 'database_id', database_id: 'd2' } }], has_more: false };
    },
  };
  assert.deepEqual(await listDatabases(client, {}), [{ id: 'd1', title: 'Wiki' }, { id: 'd2', title: '(제목 없음)' }]);
});

test('listPages paginates the search API by page object type', async () => {
  const client = {
    search: async ({ filter }) => {
      assert.equal(filter.value, 'page');
      return { results: [{ id: 'pg1', properties: { Name: { type: 'title', title: [{ plain_text: 'Home' }] } } }], has_more: false };
    },
  };
  assert.deepEqual(await listPages(client, {}), [{ id: 'pg1', title: 'Home', depth: 1 }]);
});

test('listPages with maxDepth filters and sorts by depth (top-level first, then children)', async () => {
  // 계층: root(workspace) → child(root) → grandchild(child). orphan은 부모가 결과 밖 → 최상위 취급.
  // search가 자식을 최상위보다 먼저 줘도 결과는 depth 오름차순으로 정렬돼야 한다.
  const title = (t) => ({ Name: { type: 'title', title: [{ plain_text: t }] } });
  const client = {
    search: async () => ({
      has_more: false,
      results: [
        { id: 'child', properties: title('Child'), parent: { type: 'page_id', page_id: 'root' } },
        { id: 'root', properties: title('Root'), parent: { type: 'workspace' } },
        { id: 'grandchild', properties: title('Grandchild'), parent: { type: 'page_id', page_id: 'child' } },
        { id: 'orphan', properties: title('Orphan'), parent: { type: 'page_id', page_id: 'not-in-results' } },
      ],
    }),
  };
  // depth≤2: depth 1(root, orphan) 먼저, 그 다음 depth 2(child). grandchild(3)는 빠진다.
  assert.deepEqual(await listPages(client, { maxDepth: 2 }), [
    { id: 'root', title: 'Root', depth: 1 },
    { id: 'orphan', title: 'Orphan', depth: 1 },
    { id: 'child', title: 'Child', depth: 2 },
  ]);
  // depth≤1: 최상위(및 조상이 결과 밖인 것)만.
  assert.deepEqual(await listPages(client, { maxDepth: 1 }), [
    { id: 'root', title: 'Root', depth: 1 },
    { id: 'orphan', title: 'Orphan', depth: 1 },
  ]);
  // maxDepth 미지정: 전부. 깊은 체인의 depth까지 정확히 매겨진다(root 1 → child 2 → grandchild 3).
  assert.deepEqual(await listPages(client, {}), [
    { id: 'root', title: 'Root', depth: 1 },
    { id: 'orphan', title: 'Orphan', depth: 1 },
    { id: 'child', title: 'Child', depth: 2 },
    { id: 'grandchild', title: 'Grandchild', depth: 3 },
  ]);
});

test('listPages excludeDatabaseChildren drops pages parented by a database (or data source)', async () => {
  const title = (t) => ({ Name: { type: 'title', title: [{ plain_text: t }] } });
  const client = {
    search: async () => ({
      has_more: false,
      results: [
        { id: 'home', properties: title('Home'), parent: { type: 'workspace' } },
        { id: 'row1', properties: title('DB Row 1'), parent: { type: 'database_id', database_id: 'dbx' } },
        { id: 'row2', properties: title('DB Row 2'), parent: { type: 'data_source_id', data_source_id: 'dsx' } },
        { id: 'child', properties: title('Child'), parent: { type: 'page_id', page_id: 'home' } },
      ],
    }),
  };
  // DB/데이터소스 행은 빠지고 page/workspace parent만 남는다.
  assert.deepEqual(await listPages(client, { excludeDatabaseChildren: true }), [
    { id: 'home', title: 'Home', depth: 1 },
    { id: 'child', title: 'Child', depth: 2 },
  ]);
  // 옵션 없으면 전부(기본 동작 유지).
  assert.equal((await listPages(client, {})).length, 4);
});

test('createDatabase puts the full schema in initial_data_source and returns the title property', async () => {
  let created;
  const client = {
    databases: { create: async (arg) => { created = arg; return { id: 'newdb', data_sources: [{ id: 'ds1' }] }; } },
    dataSources: { retrieve: async ({ data_source_id }) => { assert.equal(data_source_id, 'ds1'); return { properties: { Name: { type: 'title' } } }; } },
  };
  const result = await createDatabase(client, { parentPageId: 'pg1', title: 'personal' });
  assert.equal(result.databaseId, 'newdb');
  assert.equal(result.titleProperty, 'Name');
  assert.equal(created.parent.page_id, 'pg1');
  assert.deepEqual(Object.keys(created.initial_data_source.properties).sort(), ['Confidence', 'Created', 'Name', 'Source URL', 'Status', 'Summary', 'Tags', 'Type', 'Updated']);
  await assert.rejects(() => createDatabase(client, {}), /부모 페이지 id가 필요/);
});

test('inspectDatabase reads the data source schema and merges the title with the diff', async () => {
  const client = {
    databases: { retrieve: async () => ({ id: 'db', data_sources: [{ id: 'ds1' }] }) },
    dataSources: { retrieve: async ({ data_source_id }) => { assert.equal(data_source_id, 'ds1'); return { title: [{ plain_text: 'Notes' }], properties: { Name: { type: 'title' } } }; } },
  };
  const info = await inspectDatabase(client, { databaseId: 'db' });
  assert.equal(info.title, 'Notes');
  assert.equal(info.ok, false);
  assert.ok(info.missing.includes('Type'));
});

test('applySchema adds only the missing non-title properties to the data source', async () => {
  let updated;
  const client = {
    databases: { retrieve: async () => ({ id: 'db', data_sources: [{ id: 'ds1' }] }) },
    dataSources: { update: async (arg) => { updated = arg; } },
  };
  const added = await applySchema(client, { databaseId: 'db', missing: ['Type', 'Summary'] });
  assert.deepEqual(added.sort(), ['Summary', 'Type']);
  assert.equal(updated.data_source_id, 'ds1');
  assert.deepEqual(Object.keys(updated.properties).sort(), ['Summary', 'Type']);
  assert.deepEqual(await applySchema(client, { databaseId: 'db', missing: [] }), []);
});
