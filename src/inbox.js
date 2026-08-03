import fs from 'node:fs';
import path from 'node:path';
import { formatTimestamp, rawNoteFilename, renderRawNote, writeRawNote } from './capture.js';

// 원격 inbox에서 새 항목을 볼트의 raw/notes/로 가져오는 결정론 스크래핑. provider-agnostic.
// 항목 목록·본문 fetch는 provider가 담당하고, 이 모듈은 dedup·파일 기록만 한다.
// 이미 가져온 항목은 <vault>/_meta/remote-inbox.json에 항목 id로 기록해 중복을 막는다.

export const REMOTE_INBOX_FILE = path.join('_meta', 'remote-inbox.json');

export function loadInboxState(vaultPath) {
  const file = path.join(vaultPath, REMOTE_INBOX_FILE);
  if (!fs.existsSync(file)) return { version: 1, pulled: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version || 1, provider: parsed.provider, pulled: parsed.pulled || {} };
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

export function saveInboxState(vaultPath, state) {
  const file = path.join(vaultPath, REMOTE_INBOX_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// 아직 안 가져온 항목만 남긴다(id 기준 dedup). idOf는 provider.itemId. 순수 함수.
export function selectNewItems(items, pulled, idOf) {
  return items.filter((item) => !pulled[idOf(item)]);
}

/**
 * inbox를 pull한다. provider-agnostic. client는 DI로 주입한다.
 * - provider.listInboxItems / itemId / fetchInboxNote가 실제 원격 호출을 담당한다.
 * - dryRun: 목록·본문 조회는 하되 파일은 쓰지 않고 목록만 돌려준다.
 * - limit: 처리할 신규 항목 수 제한.
 * 반환: { pulled: [{id, file|title}], skipped, dryRun }
 */
export async function pullInbox(vaultPath, { provider, client, ctx = {}, dryRun = false, limit } = {}) {
  const state = loadInboxState(vaultPath);
  const items = await provider.listInboxItems(client, ctx);
  let fresh = selectNewItems(items, state.pulled, provider.itemId);
  const skipped = items.length - fresh.length;
  if (limit) fresh = fresh.slice(0, limit);

  const pulled = [];
  const now = new Date();
  for (const item of fresh) {
    const id = provider.itemId(item);
    const note = await provider.fetchInboxNote(client, item);
    if (dryRun) { pulled.push({ id, title: note.title }); continue; }

    const contents = renderRawNote({
      title: note.title,
      body: note.markdown,
      source: 'inbox',
      createdAt: formatTimestamp(now),
      extra: { remote_id: id },
    });
    // 같은 분에 여러 항목을 가져올 수 있으므로 id 앞부분을 붙여 파일명 충돌을 막는다.
    const suffix = String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const filename = rawNoteFilename(now, note.title).replace(/\.md$/, `-${suffix}.md`);
    const notePath = writeRawNote(vaultPath, filename, contents);
    const relative = path.relative(vaultPath, notePath);
    state.pulled[id] = { pulledAt: now.toISOString().slice(0, 10), file: relative };
    pulled.push({ id, file: relative });
  }

  if (!dryRun && pulled.length) {
    if (provider.name) state.provider = provider.name;
    saveInboxState(vaultPath, state);
  }
  return { pulled, skipped, dryRun };
}
