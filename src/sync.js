import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseWikiFrontmatter } from './lint.js';

// local → 원격 단방향 동기화. diff를 떠 없는/바뀐 페이지만 push한다. 절대 원격→local 안 함.
// 실제 원격 호출(페이지 생성·갱신)은 provider가 담당하고, 이 모듈은 스캔·diff·상태 기록만 한다.
// 상태는 <vault>/_meta/remote-map.json에 슬러그별로 기록한다(git 커밋 대상, provider-중립).

export const REMOTE_MAP_FILE = path.join('_meta', 'remote-map.json');

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
export function scanLocalPages(vaultPath, subdirs) {
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
 * 로컬 페이지와 매핑 스토어를 비교한다. 순수 함수. provider-중립.
 * - create: 매핑에 remoteId가 없는 페이지
 * - update: remoteId는 있으나 hash가 달라진 페이지
 * - unchanged: hash 일치
 * delete 브랜치는 없다(단방향, 원격 페이지를 지우지 않는다).
 */
export function computeSyncDiff(localPages, map) {
  const pages = (map && map.pages) || {};
  const result = { create: [], update: [], unchanged: [] };
  for (const page of localPages) {
    const hash = contentHash(page.fields, page.body);
    const entry = pages[page.slug];
    const record = { ...page, hash };
    if (!entry || !entry.remoteId) result.create.push(record);
    else if (entry.hash !== hash) result.update.push({ ...record, remoteId: entry.remoteId });
    else result.unchanged.push(record);
  }
  return result;
}

// ── 매핑 스토어 I/O ───────────────────────────────────────────────────────

export function loadRemoteMap(vaultPath) {
  const file = path.join(vaultPath, REMOTE_MAP_FILE);
  if (!fs.existsSync(file)) return { version: 1, pages: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version || 1, provider: parsed.provider, pages: parsed.pages || {} };
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

export function saveRemoteMap(vaultPath, map) {
  const file = path.join(vaultPath, REMOTE_MAP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

// ── 오케스트레이터 ────────────────────────────────────────────────────────

/**
 * diff를 계산하고 create/update를 provider로 push한 뒤 매핑 스토어를 갱신한다. provider-agnostic.
 * - vaultPath, provider, ctx, subdirs는 필수(dryRun이면 provider/ctx 없이 diff 요약만).
 * - provider.createRemotePage / updateRemotePage가 실제 원격 호출을 담당한다.
 * - client는 DI로 주입하므로 테스트가 SDK 없이 스텁을 넘길 수 있다.
 */
export async function pushSync(vaultPath, { provider, client, ctx = {}, subdirs, dryRun = false, limit } = {}) {
  const map = loadRemoteMap(vaultPath);
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
  if (provider.name) map.provider = provider.name;
  for (const page of targets) {
    const payload = { fields: page.fields, body: page.body };
    let remoteId = page.remoteId;
    if (remoteId) {
      await provider.updateRemotePage(client, ctx, remoteId, payload);
      summary.updated += 1;
    } else {
      remoteId = await provider.createRemotePage(client, ctx, payload);
      summary.created += 1;
    }
    map.pages[page.slug] = {
      remoteId,
      hash: page.hash,
      syncedAt: now,
      title: page.fields.title || page.slug,
    };
  }
  saveRemoteMap(vaultPath, map);
  return summary;
}
