import fs from 'node:fs';
import path from 'node:path';

// raw/ 노트는 lint 검사 대상이 아니라 자유 형식이지만, 캡처·인박스가 일관된 최소 frontmatter를
// 쓰도록 한곳에 모은다. 이 모듈의 함수는 순수(파일 I/O는 writeRawNote만)하게 유지한다.

const SLUG_MAX = 40;

// 제목을 kebab-case slug로 정규화한다. 한글 등 ASCII 밖 문자는 제거되므로 비면 'note'로 대체한다.
function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'note';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// YYYY-MM-DD HH:MM (로컬 시각). frontmatter created 값에 쓴다.
export function formatTimestamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 2026-08-03-1432-<slug>.md — 시각 접두사로 정렬 가능하고 slug로 사람이 읽을 수 있게 한다.
export function rawNoteFilename(date, title) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}-${slugify(title)}.md`;
}

// YAML 리스트/문자열 값을 안전하게 직렬화한다(YAML 파서를 넣지 않고 최소 규격만).
function yamlString(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  if (/[:#\[\]{}"'\n]|^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}

/**
 * raw 노트 마크다운(frontmatter + 본문)을 만든다. 순수 함수.
 * extra는 notion_id 같은 추가 frontmatter 필드(문자열)를 넣을 때 쓴다.
 */
export function renderRawNote({ title, body, source = 'capture', createdAt, tags = [], extra = {} }) {
  const lines = ['---'];
  if (title) lines.push(`title: ${yamlString(title)}`);
  lines.push(`source: ${source}`);
  lines.push(`created: ${createdAt}`);
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${yamlString(value)}`);
  if (tags.length) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`  - ${tag}`);
  } else {
    lines.push('tags: []');
  }
  lines.push('---', '');
  lines.push(String(body ?? '').trim());
  lines.push('');
  return lines.join('\n');
}

/**
 * 대상 볼트를 비대화형으로 해소한다.
 * - requestedName이 있으면 그 볼트(없으면 에러).
 * - 볼트가 하나면 그것.
 * - 그 외에는 { ambiguous: true } (호출자가 프롬프트하거나 에러).
 */
export function resolveCaptureVault(vaults, requestedName) {
  if (requestedName) {
    const vault = vaults.find((item) => item.name === requestedName);
    if (!vault) throw new Error(`등록되지 않은 볼트입니다: ${requestedName}`);
    return { vault };
  }
  if (vaults.length === 1) return { vault: vaults[0] };
  return { ambiguous: true };
}

/**
 * raw/notes/ 아래에 노트를 기록하고 절대 경로를 반환한다. 기존 파일은 덮어쓰지 않는다.
 */
export function writeRawNote(vaultPath, filename, contents) {
  const dir = path.join(vaultPath, 'raw', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  // wx: 이미 있으면 실패 → 같은 분(minute) 내 재실행 시 덮어쓰기 방지.
  fs.writeFileSync(target, contents, { flag: 'wx' });
  return target;
}
