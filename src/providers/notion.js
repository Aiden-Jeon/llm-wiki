// Notion 원격 provider 구현체. src/providers/index.js의 인터페이스를 채운다.
// 순수 변환 함수(markdown↔blocks, frontmatter→properties)는 직접 단위 테스트하도록 export하고,
// 네트워크 함수는 client를 인자로 받아(DI) 테스트가 SDK를 import하지 않게 한다.

export const name = 'notion';
export const tokenPrefix = 'NOTION';
export const defaultSyncSubdirs = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/analyses'];

// 토큰 발급 안내. CLI가 토큰 입력 프롬프트 앞에 보여준다(provider별 발급처가 다름).
export const tokenHelp = {
  url: 'https://www.notion.so/my-integrations',
  lines: [
    '1. 위 링크에서 New integration으로 internal integration을 만듭니다.',
    '2. Internal Integration Secret(secret_… 또는 ntn_…)을 복사해 아래에 붙여넣습니다.',
    '3. integration의 Content access 탭 → Add pages & databases에서 대상 페이지·DB를 연결해야 접근됩니다',
    '   (또는 대상 페이지에서 ⋯ → Connections로 연결).',
  ],
};

// 접근 가능한 페이지·DB가 없을 때 보여줄 연결 안내(provider별로 다름). CLI가 목록이 비면 표시.
export const connectHelp = 'integration의 Content access 탭 → Add pages & databases에서 대상을 연결하세요'
  + ' (또는 대상 페이지에서 ⋯ → Connections). 연결 후 다시 시도하세요.';

const NOTION_BLOCK_LIMIT = 100; // children 추가 요청당 최대 블록 수(Notion 제한).

// publish 대상 DB가 갖춰야 하는 속성 → Notion 타입. frontmatterToProperties와 짝이며,
// title 속성은 이름이 가변('Name' 기본)이라 여기서 name은 기본값일 뿐 매칭은 type=title로 한다.
export const PUBLISH_SCHEMA = [
  { name: 'Name', type: 'title' },
  { name: 'Type', type: 'select' },
  { name: 'Status', type: 'select' },
  { name: 'Tags', type: 'multi_select' },
  { name: 'Summary', type: 'rich_text' },
  { name: 'Confidence', type: 'select' },
  { name: 'Created', type: 'date' },
  { name: 'Updated', type: 'date' },
  { name: 'Source URL', type: 'url' },
];

// Notion databases.create/update가 받는 속성 정의(빈 옵션이면 열림).
function propertyDefinition(type) {
  return { [type]: {} };
}

/**
 * @notionhq/client를 지연 로딩해 클라이언트를 만든다. 코어 CLI가 이 선택 의존성에
 * 하드 링크되지 않도록 동적 import를 쓴다. 미설치 시 친절한 안내를 던진다.
 */
export async function createClient(token) {
  let mod;
  try {
    mod = await import('@notionhq/client');
  } catch {
    throw new Error('Notion 기능을 쓰려면 @notionhq/client를 설치하세요: npm i @notionhq/client');
  }
  return new mod.Client({ auth: token });
}

// ── 검증(validate/verify) : provider 인터페이스(선택) ─────────────────────

// Notion APIResponseError는 code(unauthorized, object_not_found …)·status를 담는다.
function notionErrorMessage(error) {
  const code = error && (error.code || error.status);
  const base = error && error.message ? error.message : String(error);
  return code ? `${code}: ${base}` : base;
}

// 데이터베이스 제목(rich_text 배열)을 평문으로 뽑는다.
export function extractDatabaseTitle(db) {
  return richTextToPlain(db && db.title);
}

/**
 * 토큰 유효성을 실호출로 확인한다. 성공 시 { ok, account }, 실패 시 친절한 에러를 던진다.
 */
export async function validateToken(client) {
  try {
    const me = await client.users.me({});
    return { ok: true, account: me && (me.name || me.id) };
  } catch (error) {
    throw new Error(`Notion 토큰 검증 실패 — ${notionErrorMessage(error)}`);
  }
}

/**
 * 대상 데이터베이스가 존재·도달 가능한지 확인한다. 성공 시 { ok, title }, 실패 시 에러.
 */
export async function verifyDatabase(client, { databaseId } = {}) {
  if (!databaseId) throw new Error('데이터베이스 id가 필요합니다.');
  try {
    const db = await client.databases.retrieve({ database_id: databaseId });
    return { ok: true, title: extractDatabaseTitle(db) };
  } catch (error) {
    throw new Error(`Notion 데이터베이스(${databaseId}) 확인 실패 — ${notionErrorMessage(error)}`);
  }
}

// ── 대상 DB 선택/생성/스키마 (provider 인터페이스, 선택) ────────────────────

// DB의 properties 맵에서 title 타입 속성의 이름을 찾는다. publish는 이 이름을 titleProperty로 쓴다.
export function findTitleProperty(db) {
  const props = (db && db.properties) || {};
  for (const [propName, value] of Object.entries(props)) {
    if (value && value.type === 'title') return propName;
  }
  return 'Name';
}

/**
 * 대상 DB 스키마를 기대 스키마(PUBLISH_SCHEMA)와 비교한다. 순수 함수.
 * 반환: { titleProperty, missing[], conflicts[{name, expected, actual}], ok }.
 * - missing: DB에 없는 속성(추가 가능).
 * - conflicts: 같은 이름인데 타입이 다른 속성(파괴 위험이라 자동 변경 안 함).
 * title 속성은 이름이 달라도 type=title 하나가 있으면 충족으로 본다.
 */
export function diffPublishSchema(db) {
  const props = (db && db.properties) || {};
  const byName = new Map(Object.entries(props).map(([name, value]) => [name, value && value.type]));
  const titleProperty = findTitleProperty(db);
  const missing = [];
  const conflicts = [];
  for (const expected of PUBLISH_SCHEMA) {
    if (expected.type === 'title') continue; // title은 findTitleProperty가 이미 처리.
    const actualType = byName.get(expected.name);
    if (actualType === undefined) missing.push(expected.name);
    else if (actualType !== expected.type) conflicts.push({ name: expected.name, expected: expected.type, actual: actualType });
  }
  return { titleProperty, missing, conflicts, ok: missing.length === 0 && conflicts.length === 0 };
}

/**
 * 워크스페이스에서 integration이 접근 가능한 데이터베이스를 검색한다(search API).
 * 반환: [{ id, title }]. query로 제목 필터(선택).
 */
export async function listDatabases(client, { query, pageSize = 100 } = {}) {
  const results = [];
  let cursor;
  do {
    const response = await client.search({
      query: query || undefined,
      filter: { property: 'object', value: 'database' },
      start_cursor: cursor,
      page_size: pageSize,
    });
    for (const db of response.results || []) results.push({ id: db.id, title: extractDatabaseTitle(db) || '(제목 없음)' });
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

/**
 * 새 DB를 만들 부모로 쓸, integration이 접근 가능한 페이지를 검색한다(search API).
 * 반환: [{ id, title }].
 */
export async function listPages(client, { query, pageSize = 100 } = {}) {
  const results = [];
  let cursor;
  do {
    const response = await client.search({
      query: query || undefined,
      filter: { property: 'object', value: 'page' },
      start_cursor: cursor,
      page_size: pageSize,
    });
    for (const page of response.results || []) results.push({ id: page.id, title: extractNotionTitle(page) });
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

/**
 * 부모 페이지 아래에 publish 스키마를 갖춘 새 데이터베이스를 만든다.
 * 반환: { databaseId, titleProperty }.
 */
export async function createDatabase(client, { parentPageId, title } = {}) {
  if (!parentPageId) throw new Error('새 데이터베이스를 만들 부모 페이지 id가 필요합니다.');
  const properties = {};
  for (const { name, type } of PUBLISH_SCHEMA) properties[name] = propertyDefinition(type);
  try {
    const db = await client.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: String(title || 'llm-wiki') } }],
      properties,
    });
    return { databaseId: db.id, titleProperty: findTitleProperty(db) };
  } catch (error) {
    throw new Error(`Notion 데이터베이스 생성 실패 — ${notionErrorMessage(error)}`);
  }
}

/**
 * 대상 DB를 조회해 원본과 스키마 diff를 함께 돌려준다. 성공 시
 * { title, titleProperty, missing[], conflicts[], ok }, 실패 시 에러.
 */
export async function inspectDatabase(client, { databaseId } = {}) {
  if (!databaseId) throw new Error('데이터베이스 id가 필요합니다.');
  let db;
  try {
    db = await client.databases.retrieve({ database_id: databaseId });
  } catch (error) {
    throw new Error(`Notion 데이터베이스(${databaseId}) 확인 실패 — ${notionErrorMessage(error)}`);
  }
  return { title: extractDatabaseTitle(db), ...diffPublishSchema(db) };
}

/**
 * 누락 속성만 대상 DB에 추가한다(databases.update). 타입 충돌은 파괴 위험이라 건드리지 않는다.
 * missing은 diffPublishSchema가 준 이름 배열. 반환: 추가한 속성 이름 배열.
 */
export async function applySchema(client, { databaseId, missing = [] } = {}) {
  if (!databaseId) throw new Error('데이터베이스 id가 필요합니다.');
  if (!missing.length) return [];
  const typeByName = new Map(PUBLISH_SCHEMA.map(({ name, type }) => [name, type]));
  const properties = {};
  for (const propName of missing) {
    const type = typeByName.get(propName);
    if (type && type !== 'title') properties[propName] = propertyDefinition(type);
  }
  try {
    await client.databases.update({ database_id: databaseId, properties });
    return Object.keys(properties);
  } catch (error) {
    throw new Error(`Notion 데이터베이스 스키마 갱신 실패 — ${notionErrorMessage(error)}`);
  }
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
  return { multi_select: (values || []).map((value) => ({ name: String(value) })) };
}

/**
 * 위키 페이지 frontmatter를 Notion 데이터베이스 속성으로 매핑한다. 순수 함수.
 * title→title, tags→multi_select, status/type/confidence→select, created/updated→date,
 * summary→rich_text, source_url→url. titleProp는 대상 DB의 title 속성 이름(기본 'Name').
 * summary/confidence는 스키마상 선택 필드라 없으면 생략된다(대상 DB에 해당 컬럼이 있어야 채워짐).
 */
export function frontmatterToProperties(fields, { titleProp = 'Name' } = {}) {
  const props = {};
  const title = fields.title || '';
  props[titleProp] = { title: [{ type: 'text', text: { content: String(title) } }] };
  if (fields.type) props.Type = { select: { name: String(fields.type) } };
  if (fields.status) props.Status = { select: { name: String(fields.status) } };
  if (Array.isArray(fields.tags) && fields.tags.length) props.Tags = multiSelect(fields.tags);
  if (fields.summary) props.Summary = { rich_text: [{ type: 'text', text: { content: String(fields.summary) } }] };
  if (fields.confidence) props.Confidence = { select: { name: String(fields.confidence) } };
  if (fields.created) props.Created = { date: { start: String(fields.created) } };
  if (fields.updated) props.Updated = { date: { start: String(fields.updated) } };
  if (fields.source_url) props['Source URL'] = { url: String(fields.source_url) };
  return props;
}

// 블록 배열을 100개 단위로 나눈다(Notion children 제한).
export function chunkBlocks(blocks, size = NOTION_BLOCK_LIMIT) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size));
  return chunks;
}

// ── 출력(sync) : provider 인터페이스 ──────────────────────────────────────

/**
 * 신규 Notion 페이지를 만든다. ctx = { databaseId, titleProp }. page = { fields, body }.
 * 반환: 생성된 페이지 id(remoteId).
 */
export async function createRemotePage(client, ctx, page) {
  const props = frontmatterToProperties(page.fields, { titleProp: ctx.titleProp });
  const [first, ...restChunks] = chunkBlocks(markdownToBlocks(page.body));
  const created = await client.pages.create({
    parent: { database_id: ctx.databaseId },
    properties: props,
    children: first || [],
  });
  for (const chunk of restChunks) {
    await client.blocks.children.append({ block_id: created.id, children: chunk });
  }
  return created.id;
}

/**
 * 기존 페이지를 갱신한다. Notion API는 블록 diff를 못 하므로 자식 블록을 모두 삭제한 뒤
 * 다시 append한다(가장 단순·정확). 속성도 함께 갱신한다.
 */
export async function updateRemotePage(client, ctx, remoteId, page) {
  const props = frontmatterToProperties(page.fields, { titleProp: ctx.titleProp });
  await client.pages.update({ page_id: remoteId, properties: props });
  const existing = await client.blocks.children.list({ block_id: remoteId });
  for (const child of existing.results || []) {
    await client.blocks.delete({ block_id: child.id });
  }
  for (const chunk of chunkBlocks(markdownToBlocks(page.body))) {
    await client.blocks.children.append({ block_id: remoteId, children: chunk });
  }
}

// ── 입력(inbox) : provider 인터페이스 ─────────────────────────────────────

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

// inbox 항목의 안정 id(dedup 키).
export function itemId(item) {
  return item.id;
}

// 인박스 데이터베이스를 페이지네이션하며 모든 항목을 모은다. ctx = { databaseId }.
export async function listInboxItems(client, ctx, { pageSize = 100 } = {}) {
  const results = [];
  let cursor;
  do {
    const response = await client.databases.query({
      database_id: ctx.databaseId,
      start_cursor: cursor,
      page_size: pageSize,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

// 한 블록(페이지)의 자식 블록을 페이지네이션하며 모두 모은다.
async function listBlockChildren(client, blockId, { pageSize = 100 } = {}) {
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

/**
 * 한 inbox 항목(Notion 페이지)을 raw 노트 재료로 바꾼다.
 * 반환: { title, markdown, createdAt }.
 */
export async function fetchInboxNote(client, item) {
  const blocks = await listBlockChildren(client, item.id);
  return {
    title: extractNotionTitle(item),
    createdAt: (item.created_time || '').slice(0, 10),
    markdown: blocks.map(blockToMarkdown).join('\n\n'),
  };
}
