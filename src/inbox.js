import fs from 'node:fs';
import path from 'node:path';
import { listBlockChildren, notionPageToRawNote, queryDatabase } from './notion.js';
import { formatTimestamp, rawNoteFilename, renderRawNote, writeRawNote } from './capture.js';

// Notion inbox 데이터베이스에서 새 항목을 볼트의 raw/notes/로 가져오는 결정론 스크래핑.
// 이미 가져온 항목은 <vault>/_meta/notion-inbox.json에 page id로 기록해 중복을 막는다.

export const NOTION_INBOX_FILE = path.join('_meta', 'notion-inbox.json');

export function loadInboxState(vaultPath) {
  const file = path.join(vaultPath, NOTION_INBOX_FILE);
  if (!fs.existsSync(file)) return { version: 1, pulled: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version || 1, pulled: parsed.pulled || {} };
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

export function saveInboxState(vaultPath, state) {
  const file = path.join(vaultPath, NOTION_INBOX_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// 아직 안 가져온 항목만 남긴다(page id 기준 dedup). 순수 함수.
export function selectNewItems(items, pulled) {
  return items.filter((item) => !pulled[item.id]);
}

/**
 * inbox를 pull한다. client는 DI로 주입한다.
 * - dryRun: 네트워크 조회는 하되 파일은 쓰지 않고 목록만 돌려준다.
 * - limit: 처리할 신규 항목 수 제한.
 * 반환: { pulled: [{id, file}], skipped: number, dryRun }
 */
export async function pullInbox(vaultPath, { client, databaseId, dryRun = false, limit } = {}) {
  const state = loadInboxState(vaultPath);
  const items = await queryDatabase(client, databaseId);
  let fresh = selectNewItems(items, state.pulled);
  const skipped = items.length - fresh.length;
  if (limit) fresh = fresh.slice(0, limit);

  const pulled = [];
  const now = new Date();
  for (const page of fresh) {
    const blocks = await listBlockChildren(client, page.id);
    const note = notionPageToRawNote(page, blocks);
    if (dryRun) { pulled.push({ id: page.id, title: note.title }); continue; }

    const contents = renderRawNote({
      title: note.title,
      body: note.markdown,
      source: 'inbox',
      createdAt: formatTimestamp(now),
      extra: { notion_id: page.id },
    });
    // 같은 분에 여러 항목을 가져올 수 있으므로 notion id 앞부분을 붙여 파일명 충돌을 막는다.
    const suffix = page.id.replace(/-/g, '').slice(0, 8);
    const filename = rawNoteFilename(now, note.title).replace(/\.md$/, `-${suffix}.md`);
    const notePath = writeRawNote(vaultPath, filename, contents);
    const relative = path.relative(vaultPath, notePath);
    state.pulled[page.id] = { pulledAt: now.toISOString().slice(0, 10), file: relative };
    pulled.push({ id: page.id, file: relative });
  }

  if (!dryRun && pulled.length) saveInboxState(vaultPath, state);
  return { pulled, skipped, dryRun };
}
