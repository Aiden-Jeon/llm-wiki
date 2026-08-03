// 원격 연동 명령군: 발행 설정(publish add/list/remove), 연결 관리(connection add/list/remove),
// 그리고 런타임 발행/수집(publish, publish view, inbox pull). 대상 볼트는 호출당 하나로 해소하고,
// 토큰은 named connection(secrets.json) 또는 env에서만 읽는다. 자세한 규칙은 WIKI-CLI.md § 원격 연동 경계.
import fs from 'node:fs';
import { stdin } from 'node:process';
import * as p from '@clack/prompts';
import {
  parseOptions,
  cancelPrompt,
  ensureRegistry,
  chooseVault,
} from '../prompts.js';
import { readRegistry } from '../registry.js';
import { resolveCaptureVault } from '../capture.js';
import { renderNote } from '../note.js';
import { getProvider, listProviders } from '../providers/index.js';
import { resolveRemoteToken, normalizeVaultKey } from '../providers/token.js';
import {
  addConnection,
  listConnections,
  getConnection,
  getConnectionToken,
  removeConnection,
  hasConnection,
  normalizeConnectionName,
  legacyConnectionName,
} from '../secrets.js';
import {
  loadRemoteConfig,
  upsertRemoteConfig,
  removeRemoteConfig,
  listRemoteConfigs,
  DEFAULT_PROVIDER,
} from '../remote.js';
import { pushSync, deleteRemoteDatabaseMapping, REMOTE_MAP_FILE } from '../sync.js';
import { pullInbox } from '../inbox.js';
import { gitCommitFile, fileHasChanges, isGitRepo } from '../git.js';
import {
  PUBLISH_USAGE,
  PUBLISH_ADD_USAGE,
  PUBLISH_REMOVE_USAGE,
  PUBLISH_LIST_USAGE,
  PUBLISH_VIEW_USAGE,
  CONNECTION_ADD_USAGE,
  CONNECTION_LIST_USAGE,
  CONNECTION_REMOVE_USAGE,
  INBOX_USAGE,
} from '../help.js';

async function promptNewToken(provider) {
  if (provider.tokenHelp) {
    const help = provider.tokenHelp;
    // p.note는 CJK·긴 URL에서 테두리가 틀어지므로 displayWidth 기반 renderNote로 그린다.
    const body = [help.url && `토큰 발급: ${help.url}`, ...(help.lines || [])].filter(Boolean).join('\n');
    if (body) console.log(renderNote(body, `${provider.name} 토큰 발급 안내`));
  }
  const entered = await p.password({ message: `${provider.name} 토큰`, mask: '•' });
  if (cancelPrompt(entered)) return null;
  return entered;
}

// TTY에서 연결 이름을 입력받는다. 기존 이름이면 덮어쓸지 확인한다. 취소 시 null.
async function promptConnectionName(paths, provider, { suggested } = {}) {
  while (true) {
    const entered = await p.text({
      message: `연결 이름 (이 ${provider.name} 워크스페이스를 부를 이름)`,
      defaultValue: suggested || '',
      placeholder: suggested || 'personal',
    });
    if (cancelPrompt(entered)) return null;
    let name;
    try { name = normalizeConnectionName(entered); }
    catch (error) { p.log.warn(error.message); continue; }
    if (hasConnection(paths.secrets, provider.name, name)) {
      const overwrite = await p.confirm({ message: `연결 '${name}'이(가) 이미 있습니다. 토큰을 덮어쓸까요?`, initialValue: false });
      if (cancelPrompt(overwrite)) return null;
      if (!overwrite) continue;
    }
    return name;
  }
}

/**
 * configureRemote가 쓸 연결(named connection)을 정한다. 반환 { name, token, isNew } | null(취소).
 * 우선순위:
 *  - `--connection <name>`: 그 이름 사용. `--remote-token` 있으면 새 토큰(isNew), 없으면 저장된
 *    연결 재사용(없고 TTY면 토큰 입력받고, 없고 비-TTY면 에러).
 *  - `--remote-token`만: 이름이 필요 → 비-TTY는 `--connection` 필수(에러), TTY는 이름 입력.
 *  - 둘 다 없음 → TTY는 저장된 연결 목록에서 고르거나 새로 추가, 비-TTY는 볼트 이름 기반
 *    레거시 연결이 있으면 재사용(마이그레이션 호환), 없으면 에러.
 */
async function resolveConfigureConnection(paths, provider, vault, opts, tty) {
  const explicitName = opts.connection ? normalizeConnectionName(opts.connection) : null;
  const explicitToken = opts['remote-token'];

  if (explicitName) {
    if (explicitToken) return { name: explicitName, token: explicitToken, isNew: true };
    const stored = getConnectionToken(paths.secrets, provider.name, explicitName);
    if (stored) return { name: explicitName, token: stored, isNew: false };
    if (!tty) throw new Error(`연결 '${explicitName}'을(를) 찾을 수 없습니다. --remote-token으로 새로 저장하세요.\n사용법: ${PUBLISH_ADD_USAGE}`);
    const token = await promptNewToken(provider);
    if (token === null) return null;
    return { name: explicitName, token, isNew: true };
  }

  if (explicitToken) {
    // 비-TTY에서 이름이 없으면 볼트 이름을 연결 이름으로 기본 지정한다(스크립트 호환).
    if (!tty) return { name: normalizeConnectionName(vault.name), token: explicitToken, isNew: true };
    const name = await promptConnectionName(paths, provider, { suggested: vault.name });
    if (name === null) return null;
    return { name, token: explicitToken, isNew: true };
  }

  if (!tty) {
    // 볼트 이름 기반 레거시 연결(v1 마이그레이션 결과)이 있으면 그대로 쓴다.
    const legacy = legacyConnectionName(normalizeVaultKey(vault.name));
    const token = getConnectionToken(paths.secrets, provider.name, legacy);
    if (token) return { name: legacy, token, isNew: false };
    throw new Error(`--remote 사용 시 저장된 연결이 없으면 --remote-token(과 --connection)이 필요합니다.\n사용법: ${PUBLISH_ADD_USAGE}`);
  }

  // TTY: 저장된 연결에서 고르거나 새로 추가한다.
  const existing = listConnections(paths.secrets, provider.name);
  if (existing.length) {
    const picked = await p.select({
      message: `${provider.name} 연결 선택`,
      options: [
        ...existing.map((c) => ({ value: c.name, label: c.name, hint: c.account })),
        { value: '__new__', label: '+ 새 연결 추가' },
      ],
    });
    if (cancelPrompt(picked)) return null;
    if (picked !== '__new__') {
      return { name: picked, token: getConnectionToken(paths.secrets, provider.name, picked), isNew: false };
    }
  }
  const name = await promptConnectionName(paths, provider, { suggested: vault.name });
  if (name === null) return null;
  const token = await promptNewToken(provider);
  if (token === null) return null;
  return { name, token, isNew: true };
}

/**
 * 볼트에 원격 provider를 연결한다. named connection(토큰)과 DB id를 받아 실호출로 검증한 뒤,
 * 성공해야만 (새 연결이면) 토큰을 secrets store에 저장하고 전역 publish.json에 대상 설정과
 * 연결 이름을 기록한다. 같은 연결을 여러 볼트가 공유할 수 있다.
 * getProvider는 테스트 주입 seam이다. 비-TTY에서는 --remote가 있어야만 동작한다.
 */
export async function configureRemote(paths, vault, opts = {}, { getProvider: resolveProvider = getProvider } = {}) {
  const tty = Boolean(stdin.isTTY);

  // 연결 여부: 비-TTY는 --remote가 있을 때만, TTY는 확인 프롬프트로 결정한다.
  let providerName = opts.remote;
  if (!providerName) {
    if (!tty) return false;
    const wants = await p.confirm({ message: '이 볼트에 원격 provider를 연결할까요?', initialValue: false });
    if (cancelPrompt(wants) || !wants) return false;
    const picked = await p.select({
      message: '원격 provider',
      options: listProviders().map((n) => ({ value: n, label: n })),
    });
    if (cancelPrompt(picked)) return false;
    providerName = picked;
  }

  const provider = resolveProvider(providerName);

  if (!vault || !fs.existsSync(vault.path)) {
    const note = `${vault.name} 볼트 경로가 아직 없습니다. 원격 설정은 경로 생성 후 다시 시도하세요.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 사용할 named connection(토큰)을 정한다: 저장된 연결 재사용 또는 새 토큰 입력.
  const conn = await resolveConfigureConnection(paths, provider, vault, opts, tty);
  if (!conn) return false;
  const { name: connectionName, token } = conn;

  // 클라이언트 생성 + 토큰 검증을 먼저 한다(대화형 대상 선택이 client를 쓴다).
  // 실패하면 아무것도 저장하지 않는다.
  let client;
  let account;
  const spinTok = tty ? p.spinner() : null;
  if (spinTok) spinTok.start('토큰 검증 중');
  try {
    client = await provider.createClient(token);
    if (typeof provider.validateToken === 'function') {
      const result = await provider.validateToken(client);
      account = result && result.account;
    }
  } catch (error) {
    if (spinTok) spinTok.stop('검증 실패');
    throw error;
  }
  if (spinTok) spinTok.stop(account ? `토큰 확인 완료 · ${account}` : '토큰 확인 완료');

  // 대상 해소: TTY이고 provider가 목록/생성을 지원하면 대화형(새로 생성/기존 선택/건너뛰기),
  // 아니면 플래그(--publish-db/--inbox-db)로 받고 verifyDatabase로 존재만 확인한다.
  let publishDb;
  let inboxDb;
  let publishTitleProp;
  const interactive = tty && typeof provider.listDatabases === 'function';
  if (interactive) {
    // 새 DB 생성 시 기본 이름은 볼트명 + 목적(publish/inbox)이 드러나게 제안한다.
    const pub = await selectRemoteDatabase(provider, client, { label: 'publish', checkSchema: true, defaultName: `${vault.name} Wiki` });
    if (pub && pub.cancelled) return false;
    if (pub) { publishDb = pub.databaseId; publishTitleProp = pub.titleProperty; }
    const ibx = await selectRemoteDatabase(provider, client, { label: 'inbox', checkSchema: false, defaultName: `${vault.name} Inbox` });
    if (ibx && ibx.cancelled) return false;
    if (ibx) inboxDb = ibx.databaseId;
  } else {
    publishDb = opts['publish-db'];
    inboxDb = opts['inbox-db'];
    // 목록 미지원 provider를 TTY에서 쓸 때의 폴백: id를 직접 입력받는다.
    if (tty && !publishDb && !inboxDb) {
      const s = await p.text({ message: 'publish 대상 데이터베이스 id (없으면 비움)', defaultValue: '' });
      if (cancelPrompt(s)) return false;
      publishDb = (s || '').trim();
      const i = await p.text({ message: 'inbox 데이터베이스 id (없으면 비움)', defaultValue: '' });
      if (cancelPrompt(i)) return false;
      inboxDb = (i || '').trim();
    }
  }

  if (!publishDb && !inboxDb) {
    const note = interactive
      ? '대상을 하나도 선택하지 않았습니다. 원격 설정을 건너뜁니다.'
      : 'publish-db 또는 inbox-db 중 최소 하나가 필요합니다. 원격 설정을 건너뜁니다.';
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 비-대화형 경로는 대상 DB의 존재를 여기서 확인한다(대화형은 목록/생성 과정에서 이미 확인됨).
  if (!interactive && typeof provider.verifyDatabase === 'function') {
    if (publishDb) await provider.verifyDatabase(client, { databaseId: publishDb });
    if (inboxDb) await provider.verifyDatabase(client, { databaseId: inboxDb });
  }

  // 통과 → 토큰은 named connection으로 store에만(새 토큰일 때만), 대상 설정은 전역
  // publish.json에(토큰 없이) 기록하고 어떤 연결을 쓰는지 연결 이름을 남긴다.
  if (conn.isNew) addConnection(paths.secrets, provider.name, connectionName, { token, account });
  const patch = { provider: provider.name, connection: connectionName };
  if (publishDb) {
    patch.publish = { databaseId: publishDb };
    const titleProp = opts['title-prop'] || publishTitleProp;
    if (titleProp) patch.publish.titleProperty = titleProp;
  }
  if (inboxDb) patch.inbox = { databaseId: inboxDb };
  upsertRemoteConfig(paths.publish, vault.name, patch);

  const tokenNote = conn.isNew ? `연결 '${connectionName}' 저장됨(secrets.json)` : `연결 '${connectionName}' 사용`;
  const summary = `발행 설정 · ${vault.name} → ${provider.name}${publishDb ? ' · publish' : ''}${inboxDb ? ' · inbox' : ''} · ${tokenNote}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return true;
}

const PAGE_PARENT_MESSAGE = '새 데이터베이스를 만들 부모 페이지';
// select 스크롤 창 크기 — 페이지가 많아도 화면을 뒤덮지 않고 맨 위 검색 옵션이 늘 보이게 한다.
const PAGE_PICKER_MAX_ITEMS = 10;
// 페이지 id가 아닌 특수 동작을 나타내는 센티넬 값. Notion page id는 UUID라 이 문자열과 겹치지 않는다.
const PICK_SEARCH = '__search__';
const PICK_EXPAND = '__expand__';
const pageParentLabel = (pg) => `${pg.depth > 1 ? '  └ ' : ''}${pg.title || '(제목 없음)'}`;

/**
 * 부모 페이지 후보 중 하나를 고른다(TTY 전용). pages는 listPages가 준 depth 오름차순
 * [{ id, title, depth }]. 반환: 선택된 page id | PICK_SEARCH(검색 요청) | PICK_EXPAND(펼치기) | null(취소).
 * expandable=false면 펼치기 옵션을 숨긴다(이미 전체/검색 결과를 보여줄 때).
 */
async function pickPageFrom(pages, { expandable } = {}) {
  const topLevel = pages.filter((pg) => pg.depth <= 1);
  // 최상위가 하나도 없으면(전부 조상이 결과 밖) 펼칠 것도 없이 전체를 보여준다.
  const shown = expandable && topLevel.length ? topLevel : pages;
  const canExpand = expandable && topLevel.length && pages.length > topLevel.length;

  // 검색은 맨 위에 둔다 — 목록이 길면(특히 DB 행이 많으면) 맨 아래 옵션은 스크롤에 가려 안 보인다.
  const options = [{ value: PICK_SEARCH, label: '🔍 제목으로 검색' }];
  if (canExpand) options.push({ value: PICK_EXPAND, label: '↓ 하위 페이지도 보기' });
  for (const pg of shown) options.push({ value: pg.id, label: pageParentLabel(pg) });

  const picked = await p.select({ message: PAGE_PARENT_MESSAGE, options, maxItems: PAGE_PICKER_MAX_ITEMS });
  if (cancelPrompt(picked)) return null;
  return picked;
}

/**
 * 부모 페이지를 고른다(TTY 전용). 기본은 최상위(depth 1)만 보여 목록을 짧게 유지하고,
 * 자식(depth 2 이상)이 있으면 "하위 페이지도 보기"로 펼친다. depth로 못 찾는(더 깊은) 페이지는
 * "제목으로 검색"으로 Notion search에 query를 넘겨 찾는다. 반환: 선택된 page id | null(취소).
 */
async function choosePageParent(provider, client, pages, withSpinner) {
  let picked = await pickPageFrom(pages, { expandable: true });
  if (picked === null) return null;
  if (picked === PICK_EXPAND) {
    // 펼치기: 전체(depth 순)를 다시 보여준다(검색은 계속 가능).
    picked = await pickPageFrom(pages, { expandable: false });
    if (picked === null) return null;
  }

  // 검색: 결과가 나올 때까지(또는 취소까지) 질의를 반복한다.
  while (picked === PICK_SEARCH) {
    const query = await p.text({ message: '검색어(페이지 제목)', placeholder: '예: Projects' });
    if (cancelPrompt(query)) return null;
    const term = (query || '').trim();
    if (!term) { p.log.warn('검색어를 입력하세요.'); continue; }

    // search는 조상 체인을 안 주므로 결과의 depth는 신뢰할 수 없다 → depth 필터 없이 보여주되,
    // DB 행 페이지는 부모가 될 수 없으므로 제외한다.
    const found = await withSpinner('검색 중', () => provider.listPages(client, { query: term, excludeDatabaseChildren: true }));
    if (!found.length) { p.log.warn(`'${term}'에 해당하는 페이지가 없습니다.`); continue; }

    const options = [{ value: PICK_SEARCH, label: '🔍 다시 검색' }];
    for (const pg of found) options.push({ value: pg.id, label: pg.title || '(제목 없음)' });
    picked = await p.select({ message: PAGE_PARENT_MESSAGE, options, maxItems: PAGE_PICKER_MAX_ITEMS });
    if (cancelPrompt(picked)) return null;
  }
  return picked;
}

/**
 * 대화형으로 원격 대상 데이터베이스를 정한다(TTY 전용). 새로 생성 / 기존 선택 / 건너뛰기.
 * checkSchema면 기존 DB 선택 시 publish 스키마와 비교해 누락/충돌을 보여주고 진행 여부를 묻는다.
 * 반환: { databaseId, titleProperty? }(정함) | null(건너뜀·후보 없음) | { cancelled: true }(중단).
 */
async function selectRemoteDatabase(provider, client, { label, checkSchema, defaultName = 'llm-wiki' }) {
  const withSpinner = async (message, fn) => {
    const spin = p.spinner();
    spin.start(message);
    try { const result = await fn(); spin.stop(`${message} 완료`); return result; }
    catch (error) { spin.stop(`${message} 실패`); throw error; }
  };

  const action = await p.select({
    message: `${label} 대상 데이터베이스`,
    options: [
      { value: 'existing', label: '기존 데이터베이스 사용' },
      { value: 'new', label: '새 데이터베이스 생성' },
      { value: 'skip', label: '설정 안 함' },
    ],
    initialValue: 'skip',
  });
  if (cancelPrompt(action)) return { cancelled: true };
  if (action === 'skip') return null;

  if (action === 'new') {
    if (typeof provider.listPages !== 'function' || typeof provider.createDatabase !== 'function') {
      p.log.warn('이 provider는 데이터베이스 생성을 지원하지 않습니다. 기존 데이터베이스를 사용하세요.');
      return { cancelled: true };
    }
    // 부모 후보는 최상위+직속 자식(depth≤2)까지만 — 깊은 하위 페이지까지 다 나오면 목록이 너무 길다.
    // DB의 행 페이지는 새 DB의 부모가 될 수 없어 제외한다.
    const pages = await withSpinner('페이지 목록 불러오는 중', () => provider.listPages(client, { maxDepth: 2, excludeDatabaseChildren: true }));
    if (!pages.length) {
      p.log.warn(`접근 가능한 페이지가 없습니다. ${provider.connectHelp || '대상을 provider에 연결한 뒤 다시 시도하세요.'}`);
      return { cancelled: true };
    }
    // 기본은 최상위(depth 1)만 보여 목록을 짧게 유지하고, 자식(depth 2)이 있으면 펼치기 옵션을 준다.
    // 제목 검색으로 목록에 없는(더 깊은) 페이지도 찾을 수 있다.
    const parent = await choosePageParent(provider, client, pages, withSpinner);
    if (parent === null) return { cancelled: true };
    const title = await p.text({ message: '새 데이터베이스 이름', defaultValue: defaultName, placeholder: defaultName });
    if (cancelPrompt(title)) return { cancelled: true };
    return withSpinner('데이터베이스 생성 중', () => provider.createDatabase(client, { parentPageId: parent, title: (title || defaultName).trim() }));
  }

  // 기존 선택
  const dbs = await withSpinner('데이터베이스 목록 불러오는 중', () => provider.listDatabases(client, {}));
  if (!dbs.length) {
    p.log.warn(`접근 가능한 데이터베이스가 없습니다. ${provider.connectHelp || '대상을 provider에 연결한 뒤 다시 시도하세요.'}`);
    return { cancelled: true };
  }
  const dbId = await p.select({
    message: `${label} 데이터베이스 선택`,
    options: dbs.map((db) => ({ value: db.id, label: db.title })),
  });
  if (cancelPrompt(dbId)) return { cancelled: true };

  if (!checkSchema || typeof provider.inspectDatabase !== 'function') return { databaseId: dbId };

  const info = await withSpinner('스키마 확인 중', () => provider.inspectDatabase(client, { databaseId: dbId }));
  if (info.ok) return { databaseId: dbId, titleProperty: info.titleProperty };

  // 스키마 불일치 → 내역을 보여주고 진행 여부를 묻는다(싫다고 하면 중단).
  const lines = [];
  if (info.missing.length) lines.push(`누락된 속성(추가 가능): ${info.missing.join(', ')}`);
  if (info.conflicts.length) {
    lines.push(`타입이 다른 속성(자동 수정 안 함, 손으로 고쳐야 함):`);
    for (const c of info.conflicts) lines.push(`  · ${c.name}: 현재 ${c.actual} → 기대 ${c.expected}`);
  }
  console.log(renderNote(lines.join('\n'), `${label} 스키마 불일치`));

  const message = info.missing.length
    ? '누락 속성을 추가하고 계속할까요? (타입 충돌은 그대로 둡니다)'
    : '이 상태로 계속할까요?';
  const proceed = await p.confirm({ message, initialValue: false });
  if (cancelPrompt(proceed) || !proceed) return { cancelled: true };

  if (info.missing.length && typeof provider.applySchema === 'function') {
    await withSpinner('스키마 갱신 중', () => provider.applySchema(client, { databaseId: dbId, missing: info.missing }));
  }
  return { databaseId: dbId, titleProperty: info.titleProperty };
}

/**
 * `llmwiki publish add [vault]`: 볼트에 원격 provider를 연결하는 독립 명령.
 * 대상 볼트를 해소한 뒤 configureRemote로 검증·저장을 위임한다.
 */
export async function publishAdd(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['remote', 'connection', 'remote-token', 'publish-db', 'inbox-db', 'title-prop'],
    usage: PUBLISH_ADD_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_ADD_USAGE}`);
  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_ADD_USAGE);
  if (!vault) return false;
  return configureRemote(paths, vault, options);
}

/**
 * `llmwiki publish list [--json]`: 전역 publish.json에 등록된 발행 설정을 나열한다.
 */
export function publishList(paths, args) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: PUBLISH_LIST_USAGE });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${PUBLISH_LIST_USAGE}`);
  const configs = listRemoteConfigs(paths.publish);
  if (options.json === true) {
    console.log(JSON.stringify(configs, null, 2));
    return true;
  }
  const names = Object.keys(configs);
  if (!names.length) {
    console.log('등록된 발행 설정이 없습니다. `llmwiki publish add <vault>`로 연결하세요.');
    return true;
  }
  for (const name of names) {
    const c = configs[name];
    const parts = [];
    if (c.connection) parts.push(`연결=${c.connection}`);
    if (c.publish && c.publish.databaseId) parts.push(`publish=${c.publish.databaseId}`);
    if (c.inbox && c.inbox.databaseId) parts.push(`inbox=${c.inbox.databaseId}`);
    console.log(`${name} · ${c.provider || DEFAULT_PROVIDER}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
  }
  return true;
}

/**
 * `llmwiki publish remove [vault]`: 발행 설정 엔트리를 지운다.
 * 토큰은 이 볼트가 아니라 named connection에 묶여 여러 볼트가 공유할 수 있으므로 자동으로는
 * 건드리지 않는다(설정만 unlink). 다만 이 볼트를 지운 뒤 그 연결을 쓰는 볼트가 하나도 남지
 * 않으면(고아 연결), TTY에서 토큰도 지울지 물어본다(`--purge-token`으로 질문 없이 강제,
 * `--keep-token`으로 유지). 다른 볼트가 아직 쓰는 공유 연결은 절대 지우지 않는다.
 */
export async function publishRemove(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['purge-token', 'keep-token'],
    booleans: ['purge-token', 'keep-token'],
    usage: PUBLISH_REMOVE_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_REMOVE_USAGE}`);
  if (options['purge-token'] && options['keep-token']) {
    throw new Error('--purge-token과 --keep-token은 함께 쓸 수 없습니다.');
  }
  const tty = Boolean(stdin.isTTY);
  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_REMOVE_USAGE);
  if (!vault) return false;
  const config = loadRemoteConfig(paths.publish, vault.name);
  if (!config) {
    const note = `${vault.name} 볼트에 발행 설정이 없습니다.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 삭제 전에 이 볼트가 쓰던 provider·연결을 기억해 둔다(고아 판정에 쓴다).
  const provider = config.provider || DEFAULT_PROVIDER;
  const connection = config.connection;
  // 발행 설정을 제거하기 전에 DB id를 추출해 remote-map에서 해당 DB 항목도 지운다.
  const publishDbId = config.publish && config.publish.databaseId;

  const removed = removeRemoteConfig(paths.publish, vault.name);

  // remote-map에서 해당 DB의 매핑을 제거한다(파일이 없으면 무시).
  if (publishDbId && fs.existsSync(vault.path)) {
    deleteRemoteDatabaseMapping(vault.path, publishDbId);
  }

  const summary = `발행 설정 삭제 · ${vault.name}`;
  if (tty) p.log.success(summary); else console.log(summary);

  // 이 볼트를 지운 뒤 그 연결을 쓰는 볼트가 하나도 없고, 토큰이 실제로 저장돼 있으면
  // 고아 연결이다 — 정리할지 처리한다(공유 연결은 여기 걸리지 않아 안전).
  if (connection && hasConnection(paths.secrets, provider, connection)) {
    const stillUsed = (connectionUsage(paths).get(`${provider}:${connection}`) || []).length > 0;
    if (!stillUsed) {
      let purge;
      if (options['purge-token']) purge = true;
      else if (options['keep-token']) purge = false;
      else if (tty) {
        const ok = await p.confirm({
          message: `연결 '${provider}:${connection}'을(를) 이제 아무 볼트도 쓰지 않습니다. 저장된 토큰도 지울까요?`,
          initialValue: false,
        });
        if (cancelPrompt(ok)) return removed;
        purge = ok === true;
      } else {
        // 비대화형은 물어볼 수 없으므로 토큰을 유지하고 안내만 한다.
        console.log(`연결 '${provider}:${connection}'이(가) 더 이상 쓰이지 않습니다. 지우려면 llmwiki connection remove ${connection} --remote ${provider}`);
        purge = false;
      }
      if (purge && removeConnection(paths.secrets, provider, connection)) {
        const note = `연결 삭제됨 · ${provider}:${connection}`;
        if (tty) p.log.success(note); else console.log(note);
      }
    }
  }
  return removed;
}

// connection add/list/remove가 공유하는 provider 해소: --remote 우선, 없으면 TTY 선택, 비-TTY는 기본값.
async function resolveConnectionProvider(opts, tty, resolveProvider = getProvider) {
  if (opts.remote) return resolveProvider(opts.remote);
  const names = listProviders();
  if (!tty || names.length === 1) return resolveProvider(names[0] || DEFAULT_PROVIDER);
  const picked = await p.select({ message: '원격 provider', options: names.map((n) => ({ value: n, label: n })) });
  if (cancelPrompt(picked)) return null;
  return resolveProvider(picked);
}

/**
 * `llmwiki connection add`: 원격 provider 토큰을 이름 붙여 저장한다(워크스페이스별 연결).
 * 토큰을 실호출로 검증한 뒤에만 저장하고, 검증에서 얻은 account를 함께 기록한다.
 */
export async function connectionAdd(paths, args, { getProvider: resolveProvider = getProvider } = {}) {
  const { options } = parseOptions(args, {
    allowed: ['remote', 'name', 'remote-token'],
    usage: CONNECTION_ADD_USAGE,
  });
  const tty = Boolean(stdin.isTTY);
  const provider = await resolveConnectionProvider(options, tty, resolveProvider);
  if (!provider) return false;

  // 이름: 플래그 우선. 없으면 TTY에서 입력(중복 시 덮어쓸지 확인), 비-TTY는 필수.
  let name = options.name ? normalizeConnectionName(options.name) : null;
  if (!name) {
    if (!tty) throw new Error(`--name이 필요합니다.\n사용법: ${CONNECTION_ADD_USAGE}`);
    name = await promptConnectionName(paths, provider, {});
    if (name === null) return false;
  } else if (tty && hasConnection(paths.secrets, provider.name, name)) {
    const overwrite = await p.confirm({ message: `연결 '${name}'이(가) 이미 있습니다. 토큰을 덮어쓸까요?`, initialValue: false });
    if (cancelPrompt(overwrite) || !overwrite) return false;
  }

  // 토큰: 플래그 우선. 없으면 TTY에서 입력, 비-TTY는 필수.
  let token = options['remote-token'];
  if (!token) {
    if (!tty) throw new Error(`--remote-token이 필요합니다.\n사용법: ${CONNECTION_ADD_USAGE}`);
    token = await promptNewToken(provider);
    if (token === null) return false;
  }

  // 검증 후에만 저장한다.
  let account;
  const spin = tty ? p.spinner() : null;
  if (spin) spin.start('토큰 검증 중');
  try {
    const client = await provider.createClient(token);
    if (typeof provider.validateToken === 'function') {
      const result = await provider.validateToken(client);
      account = result && result.account;
    }
  } catch (error) {
    if (spin) spin.stop('검증 실패');
    throw error;
  }
  if (spin) spin.stop(account ? `토큰 확인 완료 · ${account}` : '토큰 확인 완료');

  addConnection(paths.secrets, provider.name, name, { token, account });
  const summary = `연결 저장됨 · ${provider.name}:${name}${account ? ` · ${account}` : ''}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return true;
}

/** `llmwiki connection list [--json]`: 저장된 연결을 나열한다(토큰은 절대 출력하지 않는다). */
export function connectionList(paths, args) {
  const { options } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: CONNECTION_LIST_USAGE });
  const connections = listConnections(paths.secrets);
  if (options.json === true) {
    // 토큰은 빼고 메타데이터만 노출한다.
    console.log(JSON.stringify(connections.map(({ provider, name, account, updatedAt }) => ({ provider, name, account, updatedAt })), null, 2));
    return true;
  }
  if (!connections.length) {
    console.log('저장된 연결이 없습니다. `llmwiki connection add`로 추가하세요.');
    return true;
  }
  // 어떤 볼트가 각 연결을 쓰는지도 함께 보여준다.
  const usage = connectionUsage(paths);
  for (const c of connections) {
    const users = usage.get(`${c.provider}:${c.name}`) || [];
    const parts = [c.account, users.length ? `볼트: ${users.join(', ')}` : null].filter(Boolean);
    console.log(`${c.provider}:${c.name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
  }
  return true;
}

/** provider:connection → 그 연결을 참조하는 볼트 이름 목록. */
function connectionUsage(paths) {
  const map = new Map();
  const configs = listRemoteConfigs(paths.publish);
  for (const [vaultName, c] of Object.entries(configs)) {
    const provider = c.provider || DEFAULT_PROVIDER;
    const connection = c.connection || legacyConnectionName(normalizeVaultKey(vaultName));
    const key = `${provider}:${connection}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(vaultName);
  }
  return map;
}

/**
 * `llmwiki connection remove <name>`: 저장된 연결(토큰)을 삭제한다.
 * 이 연결을 참조하는 볼트가 있으면 경고하고, TTY에서는 정말 지울지 확인한다
 * (비-TTY는 --force 없이는 거부한다). 토큰은 재발급이 번거로우므로 물어본 뒤 지운다.
 */
export async function connectionRemove(paths, args, { getProvider: resolveProvider = getProvider } = {}) {
  const { options, rest } = parseOptions(args, {
    allowed: ['remote', 'force'],
    booleans: ['force'],
    usage: CONNECTION_REMOVE_USAGE,
  });
  if (!rest.length) throw new Error(`삭제할 연결 이름이 필요합니다.\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  const tty = Boolean(stdin.isTTY);
  const provider = await resolveConnectionProvider(options, tty, resolveProvider);
  if (!provider) return false;
  const name = normalizeConnectionName(rest[0]);

  const entry = getConnection(paths.secrets, provider.name, name);
  if (!entry) {
    const note = `연결 '${provider.name}:${name}'을(를) 찾을 수 없습니다.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 이 연결을 쓰는 볼트가 있으면 알린다(설정은 남지만 토큰이 사라져 발행이 막힌다).
  const users = connectionUsage(paths).get(`${provider.name}:${name}`) || [];
  if (users.length) {
    const warn = `이 연결을 쓰는 볼트: ${users.join(', ')} — 삭제하면 해당 볼트의 발행/수집이 토큰을 잃습니다.`;
    if (tty) p.log.warn(warn); else console.error(warn);
  }

  if (tty) {
    const ok = await p.confirm({ message: `연결 '${provider.name}:${name}'의 토큰을 삭제할까요?`, initialValue: false });
    if (cancelPrompt(ok) || !ok) return false;
  } else if (!options.force) {
    throw new Error(`비대화형 환경에서 연결을 삭제하려면 --force가 필요합니다.\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  }

  const removed = removeConnection(paths.secrets, provider.name, name);
  const summary = `연결 삭제됨 · ${provider.name}:${name}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return removed;
}

/**
 * 원격 명령의 대상 볼트를 하나로 해소한다. 이름이 있으면 그 볼트, 없고 단일 볼트면 자동,
 * 여러 개면 TTY 선택 / 비-TTY 에러 (원격 쓰기는 정확히 한 볼트로 해소한다).
 */
async function resolveRemoteVault(paths, requestedName, usage) {
  ensureRegistry(paths);
  const vaults = readRegistry(paths.registry);
  if (!vaults.length) throw new Error('등록된 볼트가 없습니다. 먼저 `llmwiki vault add`로 볼트를 등록하세요.');
  let { vault, ambiguous } = resolveCaptureVault(vaults, requestedName);
  if (ambiguous) {
    if (!stdin.isTTY) throw new Error(`대상 볼트를 지정하세요.\n사용법: ${usage}`);
    vault = await chooseVault(vaults, '대상 볼트를 선택하세요.');
    if (!vault) return null;
  }
  if (!fs.existsSync(vault.path)) throw new Error(`볼트 경로를 찾을 수 없습니다: ${vault.path}`);
  return vault;
}

/**
 * 원격 설정을 읽고 provider를 해소한다. 설정은 전역 publish.json에서 볼트 이름으로 읽고,
 * provider는 그 엔트리의 provider 값에서 추론한다.
 * kind는 'publish' | 'inbox' — 없으면 해당 기능이 설정되지 않은 것.
 */
function resolveRemote(paths, vault, kind) {
  const config = loadRemoteConfig(paths.publish, vault.name);
  if (!config || !config[kind] || !config[kind].databaseId) {
    throw new Error(`${vault.name} 볼트에 원격 ${kind} 설정이 없습니다. \`llmwiki publish add ${vault.name}\`으로 연결하세요.`);
  }
  return { config, provider: getProvider(config.provider) };
}

export function parseLimit(options) {
  if (options.limit && !/^[1-9]\d*$/.test(String(options.limit))) throw new Error('--limit은 양의 정수여야 합니다.');
  const limit = options.limit ? Number(options.limit) : undefined;
  if (options.limit && !Number.isSafeInteger(limit)) throw new Error('--limit은 양의 안전 정수여야 합니다.');
  return limit;
}

// `llmwiki publish [vault]`: 로컬 위키를 원격(provider)으로 단방향 push해 view를 발행한다.
export async function publish(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['limit', 'dry-run'],
    booleans: ['dry-run'],
    usage: PUBLISH_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'publish');

  const dryRun = options['dry-run'] === true;
  const limit = parseLimit(options);

  // 토큰·클라이언트는 dry-run이 아닐 때만 필요하다(오프라인에서 diff 미리보기 가능).
  const client = dryRun
    ? null
    : await provider.createClient(resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }));
  const summary = await pushSync(vault.path, {
    provider,
    client,
    ctx: { databaseId: config.publish.databaseId, titleProp: config.publish.titleProperty },
    subdirs: config.publish.syncedSubdirs || provider.defaultSyncSubdirs,
    dryRun,
    limit,
  });

  const message = dryRun
    ? `[dry-run] ${vault.name} → ${provider.name} · 생성 예정 ${summary.planned.create} · 갱신 예정 ${summary.planned.update} · 변경 없음 ${summary.unchanged}`
    : `publish 완료 · ${vault.name} → ${provider.name} · 생성 ${summary.created} · 갱신 ${summary.updated} · 변경 없음 ${summary.unchanged}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);

  // 첫 발행에서 뷰 탭을 만들었으면 알리고, 실패했으면 발행은 유지한 채 경고만 낸다.
  if (!dryRun && summary.viewsCreated && summary.viewsCreated.length) {
    const note = `뷰 생성 · ${summary.viewsCreated.join(', ')}`;
    if (stdin.isTTY) p.log.success(note); else console.log(note);
  } else if (!dryRun && summary.viewsError) {
    const note = `뷰 생성은 건너뜀 — ${summary.viewsError} (\`llmwiki publish view ${vault.name}\`로 재시도)`;
    if (stdin.isTTY) p.log.warn(note); else console.error(note);
  }

  // 발행 dedup 상태(_meta/remote-map.json)는 git으로 볼트를 따라 이동해 머신·클론 간에
  // 공유돼야 중복 발행을 막는다. 커밋되지 않으면 클론·경로 이동 때 유실돼 전체가 재발행된다.
  // git 백엔드에서 이 파일에 미커밋 변경이 있으면 커밋할지 묻는다(push는 `vault sync`가 담당).
  if (!dryRun && vault.backend === 'git' && isGitRepo(vault.path) && fileHasChanges(vault.path, REMOTE_MAP_FILE)) {
    let commit = stdin.isTTY;
    if (stdin.isTTY) {
      const answer = await p.confirm({
        message: `발행 상태(${REMOTE_MAP_FILE})가 바뀌었습니다. 커밋할까요? (커밋하지 않으면 다음 발행에서 중복될 수 있습니다)`,
        initialValue: true,
      });
      commit = !cancelPrompt(answer) && answer;
    }
    if (commit) {
      const result = gitCommitFile(vault.path, REMOTE_MAP_FILE, `chore: llmwiki publish 상태 갱신 (${vault.name})`);
      const note = result.committed
        ? `발행 상태 커밋 완료 · ${REMOTE_MAP_FILE} (push는 \`llmwiki vault sync ${vault.name}\`)`
        : `발행 상태 변경 없음 (커밋 생략)`;
      if (stdin.isTTY) p.log.success(note); else console.log(note);
    } else {
      const note = `발행 상태(${REMOTE_MAP_FILE})가 커밋되지 않았습니다. 유실되면 중복 발행되니 \`llmwiki vault sync ${vault.name}\`로 커밋·push하세요.`;
      if (stdin.isTTY) p.log.warn(note); else console.error(note);
    }
  }
  return true;
}

// `llmwiki publish view [vault]`: 발행 대상 DB에 뷰 탭(Table/Board/Gallery/List)을 자동 생성한다.
// 발행(publish)과 별개인 초기 1회성 작업이다. @notionhq/client 5.x가 필요하다.
export async function publishView(paths, args) {
  const { rest } = parseOptions(args, { allowed: [], usage: PUBLISH_VIEW_USAGE });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_VIEW_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_VIEW_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'publish');
  if (typeof provider.createViews !== 'function') {
    throw new Error(`${provider.name} provider는 뷰 자동 생성을 지원하지 않습니다.`);
  }

  const client = await provider.createClient(
    resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }),
  );
  const created = await provider.createViews(client, { databaseId: config.publish.databaseId });

  const message = created.length
    ? `뷰 생성 완료 · ${vault.name} → ${provider.name} · ${created.join(', ')}`
    : `생성된 뷰가 없습니다 · ${vault.name}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
  return true;
}

// `llmwiki inbox pull [vault]`: 원격 inbox의 새 항목을 raw/notes/로 가져온다.
export async function inboxPull(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['limit', 'dry-run'],
    booleans: ['dry-run'],
    usage: INBOX_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${INBOX_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], INBOX_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'inbox');

  const dryRun = options['dry-run'] === true;
  const limit = parseLimit(options);

  const client = await provider.createClient(
    resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }),
  );
  const result = await pullInbox(vault.path, {
    provider,
    client,
    ctx: { databaseId: config.inbox.databaseId },
    dryRun,
    limit,
  });

  const message = dryRun
    ? `[dry-run] ${vault.name} ← ${provider.name} · 가져올 항목 ${result.pulled.length} · 이미 있음 ${result.skipped}`
    : `inbox pull 완료 · ${vault.name} ← ${provider.name} · 가져옴 ${result.pulled.length} · 이미 있음 ${result.skipped}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
  return true;
}
