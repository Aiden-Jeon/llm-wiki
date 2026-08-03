import fs from 'node:fs';
import path from 'node:path';

// _meta/schema.md의 계약을 그대로 반영한다. 규칙을 바꾸면 두 곳을 함께 고친다.
const REQUIRED_FIELDS = ['title', 'type', 'status', 'created', 'updated', 'tags', 'sources'];
const PAGE_TYPES = ['entity', 'concept', 'source', 'analysis'];
const STATUSES = ['active', 'draft', 'archived'];
const LOG_ACTIONS = ['init', 'ingest', 'query', 'lint', 'reflect', 'update', 'schema', 'publish'];
// wiki/ 하위 디렉터리 → 그 안 페이지가 가져야 할 type.
const DIR_TYPE = { entities: 'entity', concepts: 'concept', sources: 'source', analyses: 'analysis' };
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * wiki frontmatter를 읽는다. skills.js의 parseSkillFrontmatter와 같은 fence 접근이되,
 * 위키가 쓰는 블록 리스트(`tags:\n  - a`)와 인라인 배열(`tags: [a, b]`)을 배열로 해석한다.
 * 풀 YAML 파서는 넣지 않는다(프로젝트 관례). 스칼라 값은 문자열, 리스트 값은 배열로 돌려준다.
 */
export function parseWikiFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (!match) return { fields: {}, body: content.trim(), hasFrontmatter: false };

  const fields = {};
  const lines = match[1].split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = [];
      fields[currentKey].push(unquote(listItem[1].trim()));
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const value = line.slice(separator + 1).trim();
    currentKey = key;

    if (value === '') {
      // 다음 줄부터 블록 리스트가 올 수 있다. 아무것도 안 오면 빈 배열로 남긴다.
      fields[key] = [];
    } else if (/^\[.*\]$/.test(value)) {
      fields[key] = value.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean);
    } else {
      fields[key] = unquote(value);
    }
  }
  return { fields, body: content.slice(match[0].length).trim(), hasFrontmatter: true };
}

function unquote(value) {
  if (/^".*"$/.test(value)) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

/**
 * taxonomy.md에서 등록된 태그를 관대하게 추출한다. 두 표기를 모두 지원한다:
 * 불릿 하나에 태그 하나(`- llm`), 불릿 하나에 쉼표로 여러 개(`- llm, nlp, ml`).
 * 각 불릿 텍스트를 쉼표로 나눈 뒤 백틱을 제거하고, kebab-case slug만 태그로 본다.
 * 슬러그가 아닌 설명 토큰(공백 포함 문구 등)은 자연히 제외된다.
 */
export function parseTaxonomyTags(content) {
  const tags = new Set();
  for (const line of content.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    for (const piece of bullet[1].split(',')) {
      // 쉼표로 나눈 뒤 각 조각의 첫 토큰만 본다: `- nlp, ml`도, `- `slug` 설명`도 처리.
      const token = piece.replace(/`/g, '').trim().split(/\s+/)[0];
      if (token && SLUG_PATTERN.test(token)) tags.add(token);
    }
  }
  return tags;
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === '') return [];
  return [value];
}

/**
 * 볼트 하나를 스키마 계약(_meta/schema.md)에 대해 검사한다. doctor()와 같은
 * {level, label, detail} 결과 배열을 돌려준다. 표시는 호출자(cli.js)가 담당한다.
 * level: error(명확한 위반) · warn(휴리스틱) · success · info.
 */
export function lintVault(vaultPath) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  if (!fs.existsSync(vaultPath)) {
    add('error', '경로', `볼트 경로가 없습니다: ${vaultPath}`);
    return results;
  }

  // 1. 구조 (error)
  const requiredDirs = ['raw', 'wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/analyses'];
  const missingDirs = requiredDirs.filter((rel) => !fs.existsSync(path.join(vaultPath, rel)));
  const requiredFiles = ['_meta/taxonomy.md', 'index.md', 'log.md', 'CLAUDE.md'];
  const missingFiles = requiredFiles.filter((rel) => !fs.existsSync(path.join(vaultPath, rel)));
  for (const rel of missingDirs) add('error', '구조', `디렉터리 없음: ${rel}/`);
  for (const rel of missingFiles) add('error', '구조', `파일 없음: ${rel}`);
  if (missingDirs.length || missingFiles.length) {
    add('info', '구조', '`llmwiki vault scaffold`로 누락 항목을 생성할 수 있습니다(기존 파일은 보존).');
  }

  // 태그 어휘 로드 (없으면 빈 집합 — 위 구조 검사가 이미 error 보고).
  const taxonomyPath = path.join(vaultPath, '_meta', 'taxonomy.md');
  const knownTags = fs.existsSync(taxonomyPath)
    ? parseTaxonomyTags(fs.readFileSync(taxonomyPath, 'utf8'))
    : new Set();

  // 페이지 수집.
  const pages = listMarkdown(path.join(vaultPath, 'wiki')).map((file) => {
    const rel = path.relative(vaultPath, file);
    const slug = path.basename(file, '.md');
    const dir = path.basename(path.dirname(file));
    const raw = fs.readFileSync(file, 'utf8');
    return { file, rel, slug, dir, ...parseWikiFrontmatter(raw), raw };
  });
  // Obsidian은 wikilink를 대소문자 구분 없이 해소하므로 슬러그 집합도 소문자로 정규화한다.
  const slugSet = new Set(pages.map((page) => page.slug.toLowerCase()));
  // raw/ 파일명(확장자 제외)도 링크 대상이 될 수 있다.
  for (const file of listMarkdownAndAssets(path.join(vaultPath, 'raw'))) {
    slugSet.add(path.basename(file, path.extname(file)).toLowerCase());
  }

  // 2. 페이지별 frontmatter · 파일명 (error)
  for (const page of pages) {
    if (!SLUG_PATTERN.test(page.slug)) {
      add('error', page.rel, `파일명이 kebab-case slug가 아닙니다: ${page.slug}`);
    }
    if (!page.hasFrontmatter) {
      add('error', page.rel, 'frontmatter가 없습니다.');
      continue;
    }
    const missing = REQUIRED_FIELDS.filter((field) => {
      const value = page.fields[field];
      if (value === undefined) return true;
      return Array.isArray(value) ? value.length === 0 : String(value).trim() === '';
    });
    if (missing.length) add('error', page.rel, `필수 frontmatter 누락: ${missing.join(', ')}`);

    const type = page.fields.type;
    if (type !== undefined && !PAGE_TYPES.includes(type)) {
      add('error', page.rel, `type가 올바르지 않습니다: ${type} (허용: ${PAGE_TYPES.join(', ')})`);
    }
    const expectedType = DIR_TYPE[page.dir];
    if (expectedType && type !== undefined && type !== expectedType) {
      add('error', page.rel, `type(${type})가 디렉터리(${page.dir}/)와 맞지 않습니다. 기대: ${expectedType}`);
    }
    if (page.fields.status !== undefined && !STATUSES.includes(page.fields.status)) {
      add('error', page.rel, `status가 올바르지 않습니다: ${page.fields.status} (허용: ${STATUSES.join(', ')})`);
    }
    for (const field of ['created', 'updated']) {
      const value = page.fields[field];
      if (value !== undefined && String(value).trim() && !DATE_PATTERN.test(String(value).trim())) {
        add('error', page.rel, `${field}가 YYYY-MM-DD 형식이 아닙니다: ${value}`);
      }
    }

    // 3. 태그 통제 (warn)
    for (const tag of toArray(page.fields.tags)) {
      if (!knownTags.has(tag)) add('warn', page.rel, `taxonomy.md에 없는 태그: ${tag}`);
    }

    // 4. 깨진 wikilink (warn) — 경로형 링크는 제외.
    for (const target of extractWikilinks(page.body)) {
      if (target.includes('/') || target.includes('\\') || target.includes('.')) continue;
      if (!slugSet.has(target.toLowerCase())) add('warn', page.rel, `깨진 wikilink: [[${target}]]`);
    }
  }

  // 5. index.md 커버리지 (warn)
  const indexPath = path.join(vaultPath, 'index.md');
  if (fs.existsSync(indexPath)) {
    const indexed = new Set(extractWikilinks(fs.readFileSync(indexPath, 'utf8')).map((target) => target.toLowerCase()));
    for (const page of pages) {
      if (!indexed.has(page.slug.toLowerCase())) add('warn', 'index.md', `등재되지 않은 페이지: ${page.rel}`);
    }
  }

  // 6. log.md 형식 (warn)
  const logPath = path.join(vaultPath, 'log.md');
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!/^##\s+/.test(line)) continue;
      const entry = /^##\s+\[(\d{4}-\d{2}-\d{2}|YYYY-MM-DD)\]\s+(\S+)\s+\|/.exec(line);
      if (!entry) {
        add('warn', 'log.md', `형식이 맞지 않는 엔트리: ${line.trim()}`);
      } else if (entry[2] !== 'action' && !LOG_ACTIONS.includes(entry[2])) {
        add('warn', 'log.md', `허용되지 않는 action: ${entry[2]} (허용: ${LOG_ACTIONS.join(', ')})`);
      }
    }
  }

  const errors = results.filter((result) => result.level === 'error').length;
  const warns = results.filter((result) => result.level === 'warn').length;
  if (!errors && !warns) add('success', '검사 완료', `${pages.length}개 페이지 · 위반 없음`);
  return results;
}

// [[target]] / [[target|표시]] 에서 target만 뽑는다.
function extractWikilinks(text) {
  const targets = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) targets.push(match[1].trim());
  return targets;
}

function listMarkdownAndAssets(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownAndAssets(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
