import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWikiFrontmatter, parseTaxonomyTags, lintVault } from '../src/lint.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-lint-'));
}

// error 레벨이 없는 최소 well-formed 볼트를 만든다. 각 테스트는 이걸 변형해 위반을 유도한다.
function makeVault() {
  const root = tmpDir();
  for (const dir of ['raw/articles', 'wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/analyses', '_meta']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# schema\n');
  fs.writeFileSync(path.join(root, '_meta', 'taxonomy.md'), '## 주제\n- llm\n- ml\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n\n## Entities\n- [[andrej-karpathy]] — 요약\n');
  fs.writeFileSync(path.join(root, 'log.md'), '# Change Log\n\n## [2026-04-13] ingest | 첫 소스\n');
  writePage(root, 'wiki/entities/andrej-karpathy.md', {
    title: 'Andrej Karpathy', type: 'entity', status: 'active',
    created: '2026-04-13', updated: '2026-04-13', tags: ['llm', 'ml'],
    sources: ['raw/articles/karpathy.md'],
  }, '# Andrej Karpathy\n\n본문.\n');
  return root;
}

function writePage(root, rel, fields, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '', body);
  fs.writeFileSync(path.join(root, rel), lines.join('\n'));
}

function levels(results, level) {
  return results.filter((result) => result.level === level);
}

test('parseWikiFrontmatter reads block lists and inline arrays', () => {
  const block = parseWikiFrontmatter('---\ntitle: T\ntags:\n  - a\n  - b\n---\n\nbody\n');
  assert.equal(block.hasFrontmatter, true);
  assert.deepEqual(block.fields.tags, ['a', 'b']);
  assert.equal(block.body, 'body');

  const inline = parseWikiFrontmatter('---\ntags: [a, b, c]\n---\n');
  assert.deepEqual(inline.fields.tags, ['a', 'b', 'c']);

  const none = parseWikiFrontmatter('# no frontmatter\n');
  assert.equal(none.hasFrontmatter, false);
});

test('parseTaxonomyTags extracts single and comma-separated bullet tokens', () => {
  const tags = parseTaxonomyTags('## 주제\n- llm\n- nlp, ml, deep-learning\n- `knowledge-management` 설명\n- Not A Tag\n');
  assert.ok(tags.has('llm'));
  assert.ok(tags.has('nlp'));
  assert.ok(tags.has('ml'));
  assert.ok(tags.has('deep-learning'));
  assert.ok(tags.has('knowledge-management'));
  assert.equal(tags.has('Not'), false);
});

test('lintVault passes a well-formed vault with no errors or warnings', () => {
  const results = lintVault(makeVault());
  assert.equal(levels(results, 'error').length, 0);
  assert.equal(levels(results, 'warn').length, 0);
  assert.ok(levels(results, 'success').length >= 1);
});

test('lintVault flags missing structure as errors', () => {
  const root = makeVault();
  fs.rmSync(path.join(root, 'wiki/sources'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'index.md'));
  const errors = levels(lintVault(root), 'error');
  assert.ok(errors.some((result) => /wiki\/sources/.test(result.detail)));
  assert.ok(errors.some((result) => /index\.md/.test(result.detail)));
});

test('lintVault flags missing required frontmatter and bad enums', () => {
  const root = makeVault();
  writePage(root, 'wiki/concepts/rag.md', {
    title: 'RAG', type: 'widget', status: 'live', created: '2026-04-13', updated: '2026-04-13', tags: ['llm'],
    // sources 누락
  }, '# RAG\n');
  const errors = levels(lintVault(root), 'error');
  assert.ok(errors.some((result) => /필수 frontmatter 누락.*sources/.test(result.detail)));
  assert.ok(errors.some((result) => /type가 올바르지 않습니다/.test(result.detail)));
  assert.ok(errors.some((result) => /status가 올바르지 않습니다/.test(result.detail)));
});

test('lintVault flags type mismatched with directory', () => {
  const root = makeVault();
  writePage(root, 'wiki/concepts/misplaced.md', {
    title: 'Misplaced', type: 'entity', status: 'active', created: '2026-04-13', updated: '2026-04-13',
    tags: ['llm'], sources: ['raw/articles/karpathy.md'],
  }, '# Misplaced\n');
  const errors = levels(lintVault(root), 'error');
  assert.ok(errors.some((result) => /디렉터리\(concepts\/\)와 맞지 않습니다/.test(result.detail)));
});

test('lintVault flags non-kebab filenames', () => {
  const root = makeVault();
  writePage(root, 'wiki/concepts/Bad_Name.md', {
    title: 'Bad', type: 'concept', status: 'active', created: '2026-04-13', updated: '2026-04-13',
    tags: ['llm'], sources: ['raw/articles/karpathy.md'],
  }, '# Bad\n');
  const errors = levels(lintVault(root), 'error');
  assert.ok(errors.some((result) => /kebab-case slug가 아닙니다/.test(result.detail)));
});

test('lintVault warns on tag drift, index gaps, log format, and broken links', () => {
  const root = makeVault();
  // 태그 drift + index 미등재 + 깨진 링크가 있는 페이지 추가.
  writePage(root, 'wiki/concepts/rag.md', {
    title: 'RAG', type: 'concept', status: 'active', created: '2026-04-13', updated: '2026-04-13',
    tags: ['undocumented-tag'], sources: ['raw/articles/karpathy.md'],
  }, '# RAG\n\n[[nonexistent-page]] 참고. [[andrej-karpathy]]는 존재.\n');
  fs.appendFileSync(path.join(root, 'log.md'), '\n## 잘못된 형식 엔트리\n## [2026-04-14] frobnicate | 이상한 액션\n');

  const warns = levels(lintVault(root), 'warn');
  assert.ok(warns.some((result) => /taxonomy.md에 없는 태그: undocumented-tag/.test(result.detail)));
  assert.ok(warns.some((result) => /등재되지 않은 페이지.*rag\.md/.test(result.detail)));
  assert.ok(warns.some((result) => /깨진 wikilink: \[\[nonexistent-page\]\]/.test(result.detail)));
  assert.ok(warns.some((result) => /형식이 맞지 않는 엔트리/.test(result.detail)));
  assert.ok(warns.some((result) => /허용되지 않는 action: frobnicate/.test(result.detail)));
});

test('lintVault does not flag path-style wikilinks as broken', () => {
  const root = makeVault();
  writePage(root, 'wiki/sources/karpathy.md', {
    title: 'K', type: 'source', status: 'active', created: '2026-04-13', updated: '2026-04-13',
    tags: ['llm'], sources: ['raw/articles/karpathy.md'],
  }, '# K\n\n[[../../raw/articles/karpathy.md]] 원본. [[andrej-karpathy]] entity.\n');
  fs.appendFileSync(path.join(root, 'index.md'), '- [[karpathy]] — 요약\n');
  const warns = levels(lintVault(root), 'warn');
  assert.equal(warns.some((result) => /깨진 wikilink/.test(result.detail)), false);
});

test('lintVault resolves wikilinks case-insensitively (Obsidian behavior)', () => {
  const root = makeVault();
  // [[Andrej-Karpathy]]는 andrej-karpathy.md로 해소되어야 한다(대소문자 무시).
  writePage(root, 'wiki/concepts/rag.md', {
    title: 'RAG', type: 'concept', status: 'active', created: '2026-04-13', updated: '2026-04-13',
    tags: ['llm'], sources: ['raw/articles/karpathy.md'],
  }, '# RAG\n\n[[Andrej-Karpathy]] 참고.\n');
  fs.appendFileSync(path.join(root, 'index.md'), '- [[RAG]] — 요약\n');
  const warns = levels(lintVault(root), 'warn');
  assert.equal(warns.some((result) => /깨진 wikilink/.test(result.detail)), false);
  // 대문자 [[RAG]] 등재도 rag.md 커버리지로 인정.
  assert.equal(warns.some((result) => /등재되지 않은 페이지.*rag/.test(result.detail)), false);
});

test('lintVault reports missing vault path', () => {
  const results = lintVault(path.join(tmpDir(), 'does-not-exist'));
  assert.ok(levels(results, 'error').some((result) => /볼트 경로가 없습니다/.test(result.detail)));
});
