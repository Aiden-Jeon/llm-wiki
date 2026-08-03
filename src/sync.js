import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseWikiFrontmatter } from './lint.js';
import { isGitRepo, gitFileDates } from './git.js';

// 스키마 필수 필드지만 페이지에 없을 때 채울 기본값(내용에서 유추 못 하는 값은 지어내지 않는다).
const STATUS_DEFAULT = 'active';

// local → 원격 단방향 동기화. diff를 떠 없는/바뀐 페이지만 push한다. 절대 원격→local 안 함.
// 실제 원격 호출(페이지 생성·갱신)은 provider가 담당하고, 이 모듈은 스캔·diff·상태 기록만 한다.
// 상태는 <vault>/_meta/remote-map.json에 DB별·슬러그별로 기록한다(git 커밋 대상, provider-중립).

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
 * 스키마 필수 필드지만 frontmatter에 없는 값을 결정론적으로 채운다. 원본 fields는 건드리지 않고
 * 백필한 새 객체를 돌려준다. status는 기본값(active), created/updated는 git 이력 → 없으면 파일 mtime에서
 * 유도한다. tags·sources·summary·confidence·source_url처럼 내용에서 유추 못 하는 값은 채우지 않는다.
 * gitDates는 { created, updated }|null(테스트·비-git 볼트에서 주입 가능). fallbackDate는 mtime 대체.
 */
export function backfillFields(fields, { gitDates = null, fallbackDate } = {}) {
  const filled = { ...fields };
  if (filled.status === undefined) filled.status = STATUS_DEFAULT;
  if (filled.created === undefined) filled.created = (gitDates && gitDates.created) || fallbackDate;
  if (filled.updated === undefined) filled.updated = (gitDates && gitDates.updated) || fallbackDate;
  return filled;
}

/**
 * 동기화 대상 서브디렉터리의 wiki 페이지를 읽어 { slug, fields, body, file } 배열로 돌려준다.
 * 스키마 필수 필드가 비어 있으면 backfillFields로 결정론적 기본값을 채운다(발행 시 속성이 비지 않게).
 */
export function scanLocalPages(vaultPath, subdirs) {
  const pages = [];
  const gitRepo = isGitRepo(vaultPath);
  for (const subdir of subdirs) {
    for (const file of listMarkdown(path.join(vaultPath, subdir))) {
      const { fields, body } = parseWikiFrontmatter(fs.readFileSync(file, 'utf8'));
      const gitDates = gitRepo ? gitFileDates(vaultPath, path.relative(vaultPath, file)) : null;
      const fallbackDate = fs.statSync(file).mtime.toISOString().slice(0, 10);
      const filled = backfillFields(fields, { gitDates, fallbackDate });
      pages.push({ slug: path.basename(file, '.md'), fields: filled, body, file });
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
  if (!fs.existsSync(file)) return { version: 2, provider: undefined, databases: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

    // v1(레거시) 호환: 기존 flat 구조 { version, provider, viewsCreated?, databaseId?, pages? }를
    // v2 구조 { version, provider, databases: { [dbId]: { viewsCreated?, pages } } }로 마이그레이션한다.
    if (!parsed.databases) {
      // v1 맵이다. databaseId가 있으면 그것으로 키하고, 없으면 pages를 버린다(귀속 불가능).
      const migrated = {
        version: 2,
        provider: parsed.provider,
        databases: {},
      };
      if (parsed.pages && parsed.databaseId) {
        migrated.databases[parsed.databaseId] = {
          viewsCreated: parsed.viewsCreated,
          pages: parsed.pages,
        };
      }
      // databaseId 없이 pages만 있는 경우는 버린다: 어느 DB인지 알 수 없고 재사용하면 버그다.
      return migrated;
    }

    // v2 맵이다.
    return {
      version: parsed.version || 2,
      provider: parsed.provider,
      databases: parsed.databases || {},
    };
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}

export function saveRemoteMap(vaultPath, map) {
  const file = path.join(vaultPath, REMOTE_MAP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // v2 구조로 저장하고 버전 명시
  const toSave = { ...map, version: 2 };
  fs.writeFileSync(file, `${JSON.stringify(toSave, null, 2)}\n`);
}

// 원격 발행 설정을 제거할 때 해당 DB의 매핑도 제거한다.
// vault path와 database id가 있으면 그 DB의 항목을 remote-map에서 지운다.
export function deleteRemoteDatabaseMapping(vaultPath, databaseId) {
  const map = loadRemoteMap(vaultPath);
  if (map.databases[databaseId]) {
    delete map.databases[databaseId];
    saveRemoteMap(vaultPath, map);
  }
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

  // 각 DB의 매핑은 독립적으로 관리한다. 대상 DB의 서브-엔트리를 생성하거나 가져온다.
  if (!ctx.databaseId) throw new Error('ctx.databaseId는 필수입니다.');
  if (!map.databases[ctx.databaseId]) {
    map.databases[ctx.databaseId] = { viewsCreated: undefined, pages: {} };
  }
  const dbEntry = map.databases[ctx.databaseId];

  const local = scanLocalPages(vaultPath, subdirs);
  // computeSyncDiff는 { pages } 객체를 기대한다.
  const diff = computeSyncDiff(local, dbEntry);

  let targets = [...diff.create, ...diff.update];
  if (limit) targets = targets.slice(0, limit);

  const summary = {
    created: 0, updated: 0,
    unchanged: diff.unchanged.length,
    planned: { create: diff.create.length, update: diff.update.length },
    dryRun,
    viewsCreated: null, // 이번 실행에서 만든 뷰 이름 배열(생성 안 했으면 null)
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
    dbEntry.pages[page.slug] = {
      remoteId,
      hash: page.hash,
      syncedAt: now,
      title: page.fields.title || page.slug,
    };
    // 다음 원격 호출이 실패해도 방금 완료한 작업을 잊지 않도록 항목별로 체크포인트한다.
    // 특히 create의 remoteId를 잃으면 재실행 시 같은 페이지를 중복 생성하게 된다.
    saveRemoteMap(vaultPath, map);
  }

  // 첫 발행 시 대상 DB에 뷰 탭을 자동 생성한다(초기 1회, DB별 플래그로 idempotent).
  // 뷰 생성 실패는 발행 자체를 깨뜨리지 않는다(발행은 이미 끝났다) — 경고만 담는다.
  if (!dbEntry.viewsCreated && ctx.databaseId && typeof provider.createViews === 'function') {
    try {
      summary.viewsCreated = await provider.createViews(client, { databaseId: ctx.databaseId });
      dbEntry.viewsCreated = now;
    } catch (error) {
      summary.viewsError = error.message;
    }
  }

  saveRemoteMap(vaultPath, map);
  return summary;
}
