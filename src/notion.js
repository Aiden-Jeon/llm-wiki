import fs from 'node:fs';
import path from 'node:path';

// Notion 연동의 공유 계층: per-vault 설정(_meta/notion.json), 토큰 해소(env only),
// 지연 로딩 클라이언트, 그리고 순수 변환 함수(markdown↔blocks, frontmatter→properties).
// 네트워크 함수는 client를 인자로 받아(DI) 테스트가 SDK를 import하지 않게 한다.

export const NOTION_CONFIG_FILE = path.join('_meta', 'notion.json');

/**
 * <vault>/_meta/notion.json을 읽는다. 없으면 null. 파싱 실패는 명확한 에러로 올린다.
 * 비밀(토큰)은 이 파일에 담지 않는다 — inbox/sync 대상 id, 동기화 서브디렉터리 등만.
 */
export function loadNotionConfig(vaultPath) {
  const file = path.join(vaultPath, NOTION_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

/**
 * Notion 토큰을 환경 변수에서만 해소한다(파일·git·로그에 저장 금지).
 * 우선순위: config.tokenEnv → LLMWIKI_NOTION_TOKEN_<VAULT> → LLMWIKI_NOTION_TOKEN.
 * 볼트 이름은 대문자화하고 영숫자 외는 _로 바꾼다(personal-wiki → PERSONAL_WIKI).
 */
export function resolveNotionToken(env, vaultName, config = null) {
  const candidates = [];
  if (config && config.tokenEnv) candidates.push(config.tokenEnv);
  if (vaultName) {
    const upper = vaultName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    candidates.push(`LLMWIKI_NOTION_TOKEN_${upper}`);
  }
  candidates.push('LLMWIKI_NOTION_TOKEN');
  for (const key of candidates) {
    const value = env[key];
    if (value && value.trim()) return value.trim();
  }
  throw new Error(
    `Notion 토큰을 찾을 수 없습니다. 다음 환경 변수 중 하나를 설정하세요: ${candidates.join(', ')}`,
  );
}

/**
 * @notionhq/client를 지연 로딩해 클라이언트를 만든다. 코어 CLI가 이 선택 의존성에
 * 하드 링크되지 않도록 동적 import를 쓴다. 미설치 시 친절한 안내를 던진다.
 */
export async function getNotionClient(token) {
  let mod;
  try {
    mod = await import('@notionhq/client');
  } catch {
    throw new Error('Notion 기능을 쓰려면 @notionhq/client를 설치하세요: npm i @notionhq/client');
  }
  return new mod.Client({ auth: token });
}

// ── 마크다운 → Notion 블록 ────────────────────────────────────────────────

const HEADING_LEVEL = { 1: 'heading_1', 2: 'heading_2', 3: 'heading_3' };

// 인라인 마크(**bold**, *italic*, `code`, [text](url))를 Notion rich_text 배열로 파싱한다.
// 겹침·중첩은 단순화하여 순차 스캔으로 처리한다.
export function parseRichText(text) {
  const runs = [];
  const push = (content, annotations = {}, link = null) => {
    if (!content) return;
    const rich = { type: 'text', text: { content } };
    if (link) rich.text.link = { url: link };
    if (Object.keys(annotations).length) rich.annotations = annotations;
    runs.push(rich);
  };
  // 링크 → 코드 → 굵게 → 기울임 순으로 토큰을 찾는다.
  const pattern = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/;
  let rest = text;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) { push(rest); break; }
    if (match.index > 0) push(rest.slice(0, match.index));
    if (match[1]) push(match[2], {}, match[3]);
    else if (match[4]) push(match[5], { code: true });
    else if (match[6]) push(match[7], { bold: true });
    else if (match[8]) push(match[9], { italic: true });
    else if (match[10]) push(match[11], { italic: true });
    rest = rest.slice(match.index + match[0].length);
  }
  return runs;
}

function block(type, richText, extra = {}) {
  return { object: 'block', type, [type]: { rich_text: richText, ...extra } };
}

/**
 * 마크다운 본문을 Notion 블록 배열로 변환한다. 순수 함수(네트워크 없음).
 * 지원: heading(1~3), 문단, 불릿/번호 리스트, to-do, 코드펜스, 인용, 구분선, 인라인 마크·링크.
 * 미지원(v1): 이미지/에셋, 테이블 — 해당 줄은 문단으로 떨어진다.
 */
export function markdownToBlocks(body) {
  const blocks = [];
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 코드 펜스
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || 'plain text';
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1; // 닫는 펜스 소비
      blocks.push({
        object: 'block',
        type: 'code',
        code: { rich_text: [{ type: 'text', text: { content: code.join('\n') } }], language: lang },
      });
      continue;
    }

    if (!line.trim()) { i += 1; continue; }

    // 구분선
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ object: 'block', type: 'divider', divider: {} }); i += 1; continue; }

    // 헤딩
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(block(HEADING_LEVEL[level], parseRichText(heading[2].trim())));
      i += 1;
      continue;
    }

    // 인용
    if (/^>\s?/.test(line)) { blocks.push(block('quote', parseRichText(line.replace(/^>\s?/, '')))); i += 1; continue; }

    // to-do
    const todo = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (todo) {
      blocks.push(block('to_do', parseRichText(todo[2]), { checked: todo[1].toLowerCase() === 'x' }));
      i += 1;
      continue;
    }

    // 불릿 리스트
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push(block('bulleted_list_item', parseRichText(bullet[1]))); i += 1; continue; }

    // 번호 리스트
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) { blocks.push(block('numbered_list_item', parseRichText(numbered[1]))); i += 1; continue; }

    // 문단
    blocks.push(block('paragraph', parseRichText(line.trim())));
    i += 1;
  }
  return blocks;
}

// ── frontmatter → Notion database properties ──────────────────────────────

function multiSelect(values) {
  return { multi_select: (values || []).map((name) => ({ name: String(name) })) };
}

/**
 * 위키 페이지 frontmatter를 Notion 데이터베이스 속성으로 매핑한다. 순수 함수.
 * title→title, tags→multi_select, status/type→select, created/updated→date, source_url→url.
 * titleProp는 대상 DB의 title 속성 이름(기본 'Name').
 */
export function frontmatterToProperties(fields, { titleProp = 'Name' } = {}) {
  const props = {};
  const title = fields.title || '';
  props[titleProp] = { title: [{ type: 'text', text: { content: String(title) } }] };
  if (fields.type) props.Type = { select: { name: String(fields.type) } };
  if (fields.status) props.Status = { select: { name: String(fields.status) } };
  if (Array.isArray(fields.tags) && fields.tags.length) props.Tags = multiSelect(fields.tags);
  if (fields.created) props.Created = { date: { start: String(fields.created) } };
  if (fields.updated) props.Updated = { date: { start: String(fields.updated) } };
  if (fields.source_url) props['Source URL'] = { url: String(fields.source_url) };
  return props;
}

// ── Notion 페이지 → raw 노트(마크다운) : inbox pull에서 사용 ─────────────────

function richTextToPlain(richText = []) {
  return richText.map((run) => run.plain_text ?? run.text?.content ?? '').join('');
}

// Notion 블록 하나를 마크다운 한 줄로 되돌린다(inbox 스크래핑용, 대략적 역변환).
function blockToMarkdown(blk) {
  const type = blk.type;
  const data = blk[type] || {};
  const text = richTextToPlain(data.rich_text);
  switch (type) {
    case 'heading_1': return `# ${text}`;
    case 'heading_2': return `## ${text}`;
    case 'heading_3': return `### ${text}`;
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `1. ${text}`;
    case 'to_do': return `- [${data.checked ? 'x' : ' '}] ${text}`;
    case 'quote': return `> ${text}`;
    case 'code': return `\`\`\`${data.language || ''}\n${text}\n\`\`\``;
    case 'divider': return '---';
    default: return text;
  }
}

// 페이지 title 속성 값을 추출한다(속성 이름을 모르므로 type이 title인 것을 찾는다).
export function extractNotionTitle(page) {
  const props = page.properties || {};
  for (const value of Object.values(props)) {
    if (value && value.type === 'title') return richTextToPlain(value.title);
  }
  return page.id;
}

/**
 * Notion 페이지 + (선택) 블록 목록을 raw 노트 재료로 바꾼다. 순수 함수.
 * blocks가 없으면 본문은 빈 문자열(제목만).
 */
export function notionPageToRawNote(page, blocks = []) {
  const created = (page.created_time || '').slice(0, 10);
  return {
    id: page.id,
    title: extractNotionTitle(page),
    createdAt: created,
    markdown: blocks.map(blockToMarkdown).join('\n\n'),
  };
}

// ── 네트워크 (client 주입) ────────────────────────────────────────────────

// 데이터베이스를 페이지네이션하며 모든 결과를 모은다.
export async function queryDatabase(client, databaseId, { pageSize = 100 } = {}) {
  const results = [];
  let cursor;
  do {
    const response = await client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: pageSize,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

// 한 블록(페이지)의 자식 블록을 페이지네이션하며 모두 모은다.
export async function listBlockChildren(client, blockId, { pageSize = 100 } = {}) {
  const results = [];
  let cursor;
  do {
    const response = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: pageSize,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}
