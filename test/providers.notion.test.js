import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkBlocks,
  createRemotePage,
  extractNotionTitle,
  fetchInboxNote,
  frontmatterToProperties,
  itemId,
  listInboxItems,
  markdownToBlocks,
  parseRichText,
  updateRemotePage,
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

test('frontmatterToProperties maps fields to typed Notion properties', () => {
  const props = frontmatterToProperties({
    title: 'RAG',
    type: 'concept',
    status: 'active',
    tags: ['llm', 'rag'],
    created: '2024-01-15',
    updated: '2026-08-03',
    source_url: 'http://x',
  });
  assert.equal(props.Name.title[0].text.content, 'RAG');
  assert.equal(props.Type.select.name, 'concept');
  assert.equal(props.Status.select.name, 'active');
  assert.deepEqual(props.Tags.multi_select.map((t) => t.name), ['llm', 'rag']);
  assert.equal(props.Created.date.start, '2024-01-15');
  assert.equal(props['Source URL'].url, 'http://x');
});

test('frontmatterToProperties respects a custom title property name and omits empty tags', () => {
  const props = frontmatterToProperties({ title: 'X', tags: [] }, { titleProp: 'Title' });
  assert.ok(props.Title.title);
  assert.equal(props.Tags, undefined);
});

test('chunkBlocks splits at the 100-block limit', () => {
  const blocks = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(chunkBlocks(blocks).map((c) => c.length), [100, 100, 50]);
});

test('createRemotePage builds properties + blocks and returns the new page id', async () => {
  const calls = { create: 0, append: 0 };
  const client = {
    pages: { create: async (arg) => { calls.create += 1; assert.equal(arg.parent.database_id, 'db'); return { id: 'p1' }; } },
    blocks: { children: { append: async () => { calls.append += 1; } } },
  };
  const id = await createRemotePage(client, { databaseId: 'db' }, { fields: { title: 'X' }, body: '# a' });
  assert.equal(id, 'p1');
  assert.equal(calls.create, 1);
});

test('updateRemotePage replaces children and updates properties', async () => {
  const calls = { update: 0, deleted: 0, append: 0 };
  const client = {
    pages: { update: async () => { calls.update += 1; } },
    blocks: {
      children: { list: async () => ({ results: [{ id: 'old' }] }), append: async () => { calls.append += 1; } },
      delete: async () => { calls.deleted += 1; },
    },
  };
  await updateRemotePage(client, { databaseId: 'db' }, 'p1', { fields: { title: 'X' }, body: 'body' });
  assert.equal(calls.update, 1);
  assert.equal(calls.deleted, 1);
  assert.equal(calls.append, 1);
});

test('listInboxItems paginates and itemId/extractNotionTitle read a page', async () => {
  const pages = [
    { id: 'a', properties: { Name: { type: 'title', title: [{ plain_text: 'First' }] } } },
    { id: 'b', properties: { Name: { type: 'title', title: [{ plain_text: 'Second' }] } } },
  ];
  let calls = 0;
  const client = {
    databases: {
      query: async ({ start_cursor }) => {
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
