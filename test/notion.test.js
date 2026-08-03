import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractNotionTitle,
  frontmatterToProperties,
  loadNotionConfig,
  markdownToBlocks,
  notionPageToRawNote,
  parseRichText,
  resolveNotionToken,
} from '../src/notion.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-notion-'));
}

test('loadNotionConfig returns null when absent and parses when present', () => {
  const vault = tmpVault();
  assert.equal(loadNotionConfig(vault), null);
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'notion.json'), '{"version":1,"sync":{"databaseId":"db"}}');
  assert.deepEqual(loadNotionConfig(vault), { version: 1, sync: { databaseId: 'db' } });
});

test('loadNotionConfig raises a clear error on invalid JSON', () => {
  const vault = tmpVault();
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'notion.json'), '{not json');
  assert.throws(() => loadNotionConfig(vault), /파싱 실패/);
});

test('resolveNotionToken honors precedence: config.tokenEnv > per-vault > generic', () => {
  const env = {
    LLMWIKI_NOTION_TOKEN: 'generic',
    LLMWIKI_NOTION_TOKEN_PERSONAL: 'per-vault',
    CUSTOM_TOKEN: 'custom',
  };
  assert.equal(resolveNotionToken(env, 'personal', { tokenEnv: 'CUSTOM_TOKEN' }), 'custom');
  assert.equal(resolveNotionToken(env, 'personal'), 'per-vault');
  assert.equal(resolveNotionToken(env, 'other'), 'generic');
  assert.equal(resolveNotionToken({ LLMWIKI_NOTION_TOKEN_PERSONAL_WIKI: 't' }, 'personal-wiki'), 't');
});

test('resolveNotionToken throws listing the checked env vars when none set', () => {
  assert.throws(() => resolveNotionToken({}, 'work'), /LLMWIKI_NOTION_TOKEN_WORK/);
});

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

test('extractNotionTitle and notionPageToRawNote round-trip a page', () => {
  const page = {
    id: 'p1',
    created_time: '2026-08-03T10:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: 'Hello' }] } },
  };
  assert.equal(extractNotionTitle(page), 'Hello');
  const note = notionPageToRawNote(page, [
    { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } },
  ]);
  assert.equal(note.title, 'Hello');
  assert.equal(note.createdAt, '2026-08-03');
  assert.equal(note.markdown, '# Title\n\nbody');
});
