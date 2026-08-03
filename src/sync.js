import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseWikiFrontmatter } from './lint.js';
import { frontmatterToProperties, markdownToBlocks } from './notion.js';

// local → Notion 단방향 동기화. diff를 떠 없는/바뀐 페이지만 push한다. 절대 notion→local 안 함.
// 상태는 <vault>/_meta/notion-map.json에 슬러그별로 기록한다(git 커밋 대상).

export const NOTION_MAP_FILE = path.join('_meta', 'notion-map.json');
const DEFAULT_SUBDIRS = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/analyses'];
const NOTION_BLOCK_LIMIT = 100; // children 추가 요청당 최대 블록 수.

// ── 로컬 페이지 스캔 ──────────────────────────────────────────────────────

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

/**
 * 동기화 대상 서브디렉터리의 wiki 페이지를 읽어 { slug, fields, body, file } 배열로 돌려준다.
 */
export function scanLocalPages(vaultPath, subdirs = DEFAULT_SUBDIRS) {
  const pages = [];
  for (const subdir of subdirs) {
    for (const file of listMarkdown(path.join(vaultPath, subdir))) {
      const { fields, body } = parseWikiFrontmatter(fs.readFileSync(file, 'utf8'));
      pages.push({ slug: path.basename(file, '.md'), fields, body, file });
    }
  }
  return pages;
}

// ── 콘텐츠 해시 & diff ────────────────────────────────────────────────────

/**
 * frontmatter + 본문의 안정적 sha256. 키를 정렬해 순서 변화에 영향받지 않게 한다.
 * push 시점의 내용을 대표하므로, 값이 바뀌면 diff가 update로 잡는다.
 */
export function contentHash(fields, body) {
  const normalized = JSON.stringify(fields, Object.keys(fields).sort());
  return `sha256:${crypto.createHash('sha256').update(`${normalized}\n${String(body ?? '').trim()}`).digest('hex')}`;
}

/**
 * 로컬 페이지와 매핑 스토어를 비교한다. 순수 함수.
 * - create: 매핑에 notionPageId가 없는 페이지
 * - update: notionPageId는 있으나 hash가 달라진 페이지
 * - unchanged: hash 일치
 * delete 브랜치는 없다(단방향, Notion 페이지를 지우지 않는다).
 */
export function computeSyncDiff(localPages, map) {
  const pages = (map && map.pages) || {};
  const result = { create: [], update: [], unchanged: [] };
  for (const page of localPages) {
    const hash = contentHash(page.fields, page.body);
    const entry = pages[page.slug];
    const record = { ...page, hash };
    if (!entry || !entry.notionPageId) result.create.push(record);
    else if (entry.hash !== hash) result.update.push({ ...record, notionPageId: entry.notionPageId });
    else result.unchanged.push(record);
  }
  return result;
}

// ── 매핑 스토어 I/O ───────────────────────────────────────────────────────

export function loadNotionMap(vaultPath) {
  const file = path.join(vaultPath, NOTION_MAP_FILE);
  if (!fs.existsSync(file)) return { version: 1, pages: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version || 1, pages: parsed.pages || {} };
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

export function saveNotionMap(vaultPath, map) {
  const file = path.join(vaultPath, NOTION_MAP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

// ── Notion 쓰기 (client 주입) ─────────────────────────────────────────────

// 블록 배열을 100개 단위로 나눈다(Notion children 제한).
export function chunkBlocks(blocks, size = NOTION_BLOCK_LIMIT) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size));
  return chunks;
}

export async function createPage(client, databaseId, props, blocks) {
  const [first, ...restChunks] = chunkBlocks(blocks);
  const page = await client.pages.create({
    parent: { database_id: databaseId },
    properties: props,
    children: first || [],
  });
  for (const chunk of restChunks) {
    await client.blocks.children.append({ block_id: page.id, children: chunk });
  }
  return page.id;
}

/**
 * 기존 페이지를 갱신한다. Notion API는 블록 diff를 못 하므로 자식 블록을 모두 archive한 뒤
 * 다시 append한다(가장 단순·정확). 속성도 함께 갱신한다.
 */
export async function replacePageBlocks(client, pageId, props, blocks) {
  await client.pages.update({ page_id: pageId, properties: props });
  const existing = await client.blocks.children.list({ block_id: pageId });
  for (const child of existing.results || []) {
    await client.blocks.delete({ block_id: child.id });
  }
  for (const chunk of chunkBlocks(blocks)) {
    await client.blocks.children.append({ block_id: pageId, children: chunk });
  }
}

// ── 오케스트레이터 ────────────────────────────────────────────────────────

/**
 * diff를 계산하고 create/update를 push한 뒤 매핑 스토어를 갱신한다.
 * - vaultPath, databaseId, client는 필수. dryRun이면 네트워크 호출 없이 diff 요약만.
 * - subdirs, titleProp는 config에서 온다.
 * client는 DI로 주입하므로 테스트가 SDK 없이 스텁을 넘길 수 있다.
 */
export async function pushSync(vaultPath, { client, databaseId, subdirs, titleProp = 'Name', dryRun = false, limit } = {}) {
  const map = loadNotionMap(vaultPath);
  const local = scanLocalPages(vaultPath, subdirs);
  const diff = computeSyncDiff(local, map);

  let targets = [...diff.create, ...diff.update];
  if (limit) targets = targets.slice(0, limit);

  const summary = {
    created: 0, updated: 0,
    unchanged: diff.unchanged.length,
    planned: { create: diff.create.length, update: diff.update.length },
    dryRun,
  };
  if (dryRun) return summary;

  const now = new Date().toISOString().slice(0, 10);
  for (const page of targets) {
    const props = frontmatterToProperties(page.fields, { titleProp });
    const blocks = markdownToBlocks(page.body);
    let notionPageId = page.notionPageId;
    if (notionPageId) {
      await replacePageBlocks(client, notionPageId, props, blocks);
      summary.updated += 1;
    } else {
      notionPageId = await createPage(client, databaseId, props, blocks);
      summary.created += 1;
    }
    map.pages[page.slug] = {
      notionPageId,
      hash: page.hash,
      syncedAt: now,
      title: page.fields.title || page.slug,
    };
  }
  saveNotionMap(vaultPath, map);
  return summary;
}
