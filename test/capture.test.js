import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatTimestamp,
  rawNoteFilename,
  renderRawNote,
  resolveCaptureVault,
  writeRawNote,
} from '../src/capture.js';

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-capture-'));
}

test('rawNoteFilename is timestamp-sortable and kebab-cases the title', () => {
  const date = new Date(2026, 7, 3, 14, 32); // 2026-08-03 14:32 local
  assert.equal(rawNoteFilename(date, 'My New Idea!'), '2026-08-03-1432-my-new-idea.md');
});

test('rawNoteFilename falls back to note when the slug is empty (e.g. non-ASCII title)', () => {
  const date = new Date(2026, 7, 3, 9, 5);
  assert.equal(rawNoteFilename(date, '한글 제목'), '2026-08-03-0905-note.md');
  assert.equal(rawNoteFilename(date), '2026-08-03-0905-note.md');
});

test('formatTimestamp pads to YYYY-MM-DD HH:MM', () => {
  assert.equal(formatTimestamp(new Date(2026, 0, 9, 3, 7)), '2026-01-09 03:07');
});

test('renderRawNote builds minimal frontmatter and trims the body', () => {
  const md = renderRawNote({ title: 'Idea', body: '  hello  ', createdAt: '2026-08-03 14:32' });
  assert.match(md, /^---\ntitle: Idea\nsource: capture\ncreated: 2026-08-03 14:32\ntags: \[\]\n---\n\nhello\n$/);
});

test('renderRawNote omits title when absent and emits tag list + extra fields', () => {
  const md = renderRawNote({
    body: 'x',
    source: 'inbox',
    createdAt: '2026-08-03 14:32',
    tags: ['llm', 'rag'],
    extra: { notion_id: 'abc-123' },
  });
  assert.doesNotMatch(md, /^title:/m);
  assert.match(md, /source: inbox/);
  assert.match(md, /notion_id: abc-123/);
  assert.match(md, /tags:\n {2}- llm\n {2}- rag/);
});

test('resolveCaptureVault prefers explicit name, defaults to a single vault, else ambiguous', () => {
  const vaults = [{ name: 'personal' }, { name: 'work' }];
  assert.deepEqual(resolveCaptureVault(vaults, 'work'), { vault: { name: 'work' } });
  assert.throws(() => resolveCaptureVault(vaults, 'ghost'), /등록되지 않은 볼트/);
  assert.deepEqual(resolveCaptureVault([{ name: 'solo' }]), { vault: { name: 'solo' } });
  assert.deepEqual(resolveCaptureVault(vaults), { ambiguous: true });
});

test('writeRawNote writes under raw/notes and refuses to overwrite', () => {
  const vault = tmpVault();
  const target = writeRawNote(vault, 'note.md', 'body');
  assert.equal(target, path.join(vault, 'raw', 'notes', 'note.md'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'body');
  assert.throws(() => writeRawNote(vault, 'note.md', 'again'), /EEXIST/);
});
