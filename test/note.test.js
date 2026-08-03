import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, renderNote } from '../src/note.js';

test('displayWidth counts ASCII as 1 and CJK as 2', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('한글'), 4); // 2 chars × 2
  assert.equal(displayWidth('a한b'), 4); // 1 + 2 + 1
});

test('displayWidth ignores ANSI escape codes', () => {
  assert.equal(displayWidth('\x1b[90m경로\x1b[0m'), 4);
});

test('renderNote right border aligns across ASCII and CJK lines', () => {
  const box = renderNote(['open · local · 경로 정상', '/tmp/x', '신호: 업무'].join('\n'), 'databricks', { color: false });
  const lines = box.split('\n');
  // 테두리(│)가 있는 콘텐츠 줄들은 모두 같은 표시폭이어야 정렬이 맞다.
  const contentLines = lines.filter((l) => l.startsWith('│  ') && l.endsWith('│'));
  assert.ok(contentLines.length >= 3);
  const widths = new Set(contentLines.map((l) => displayWidth(l)));
  assert.equal(widths.size, 1, `콘텐츠 줄 표시폭이 제각각: ${[...widths].join(',')}`);
});

test('renderNote box is wide enough for the longest line including title', () => {
  const longUrl = 'git@github.com:Aiden-Jeon/llmwiki-vault-template.git';
  const box = renderNote(`open · git · ${longUrl} · 경로 정상`, 'testwiki', { color: false });
  const contentLines = box.split('\n').filter((l) => l.startsWith('│  ') && l.endsWith('│'));
  const inner = displayWidth(contentLines[0]) - 3; // '│  ' + trailing '│' 제외
  assert.ok(inner >= displayWidth(`open · git · ${longUrl} · 경로 정상`) + 2);
});

test('renderNote without color has no ANSI codes', () => {
  const box = renderNote('한 줄', '제목', { color: false });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b\[/.test(box));
});
