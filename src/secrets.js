// 원격 provider 토큰 저장소. config 디렉터리의 secrets.json(0600)에만 담고
// git·export 번들·워크스페이스에는 절대 내보내지 않는다.
//
// 토큰은 "이름 붙인 연결(named connection)"에 묶는다. 같은 provider라도 워크스페이스(계정)가
// 여러 개일 수 있으므로, 각 연결은 사용자 지정 이름과 검증 시 확인한 account를 함께 저장한다.
// 볼트는 자기 발행 설정(publish.json)에서 연결 이름으로 이 토큰을 참조한다.
//
// 형식(v2):
//   { "version": 2,
//     "connections": {
//       "notion:personal":  { "token": "secret_…", "account": "Jane's WS", "updatedAt": "…Z" },
//       "notion:work-team": { "token": "secret_…", "account": "ACME",      "updatedAt": "…Z" } } }
//
// v1(볼트별 토큰: "notion:<VAULT>" / 공용 "notion:*")은 로드 시 v2로 자동 마이그레이션한다:
//   "notion:*" → 연결 "default", "notion:<VAULT>" → 연결 "<vault>"(정규화 키를 소문자로).

import fs from 'node:fs';
import path from 'node:path';

const SECRETS_VERSION = 2;

/** 연결 이름 유효성: 비지 않고 ':'(키 구분자)를 포함하지 않아야 한다. 정규화는 앞뒤 공백 제거뿐. */
export function normalizeConnectionName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('연결 이름이 비었습니다.');
  if (trimmed.includes(':')) throw new Error(`연결 이름에 ':'는 쓸 수 없습니다: ${trimmed}`);
  return trimmed;
}

/** <provider>:<connection> 저장 키를 만든다. */
export function connectionKey(provider, name) {
  return `${provider}:${normalizeConnectionName(name)}`;
}

/**
 * v1 볼트 토큰 키(notion:<VAULT> / notion:*)를 v2 연결 이름으로 옮긴다.
 * "*" → "default", 그 외 정규화 키(PERSONAL_WIKI)는 소문자로(personal_wiki).
 * 이 매핑은 remote.js/token.js의 레거시 폴백과 반드시 일치해야 한다.
 */
export function legacyConnectionName(vaultKey) {
  const key = String(vaultKey || '').trim();
  return !key || key === '*' ? 'default' : key.toLowerCase();
}

function migrateV1(parsed) {
  const connections = {};
  for (const [key, value] of Object.entries(parsed.tokens || {})) {
    if (!value || !value.token) continue;
    const sep = key.indexOf(':');
    if (sep === -1) continue;
    const provider = key.slice(0, sep);
    const name = legacyConnectionName(key.slice(sep + 1));
    connections[`${provider}:${name}`] = { token: value.token, updatedAt: value.updatedAt };
  }
  return { version: SECRETS_VERSION, connections };
}

/** secrets.json을 읽는다(v1은 v2로 마이그레이션). 없으면 빈 store, 파싱 실패는 명확한 에러로 올린다. */
export function loadSecrets(secretsPath) {
  if (!fs.existsSync(secretsPath)) return { version: SECRETS_VERSION, connections: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch (error) {
    throw new Error(`${secretsPath} 파싱 실패: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return { version: SECRETS_VERSION, connections: {} };
  // v1: tokens 맵을 가지면 연결 모델로 옮긴다.
  if (parsed.tokens && typeof parsed.tokens === 'object' && !parsed.connections) return migrateV1(parsed);
  if (!parsed.connections || typeof parsed.connections !== 'object') parsed.connections = {};
  parsed.version = SECRETS_VERSION;
  delete parsed.tokens;
  return parsed;
}

/**
 * config 디렉터리에 .gitignore로 secrets.json을 무시하게 만든다(디렉터리가 git repo일 수 있으므로).
 * 멱등하며, 실패해도 토큰 저장 자체는 막지 않는다.
 */
export function ensureSecretsGitignore(configDir) {
  try {
    const file = path.join(configDir, '.gitignore');
    const line = 'secrets.json';
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `${line}\n`);
      return;
    }
    const content = fs.readFileSync(file, 'utf8');
    const has = content.split(/\r?\n/).some((row) => row.trim() === line);
    if (!has) fs.appendFileSync(file, `${content.endsWith('\n') ? '' : '\n'}${line}\n`);
  } catch { /* .gitignore 갱신 실패가 토큰 저장을 막지 않게 한다. */ }
}

/**
 * .gitignore에서 secrets.json 무시 규칙만 제거한다(ensureSecretsGitignore의 역연산).
 * 사용자가 직접 추가한 다른 규칙은 보존하고, 남는 줄이 없으면 파일 자체를 지운다.
 * 반환: 무언가 바꿨으면 true. 파일이 없거나 해당 규칙이 없으면 false(멱등).
 */
export function pruneSecretsGitignore(configDir) {
  const file = path.join(configDir, '.gitignore');
  if (!fs.existsSync(file)) return false;
  const line = 'secrets.json';
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = lines.filter((row) => row.trim() !== line);
  if (kept.length === lines.length) return false; // 해당 규칙 없음
  // 실질 내용(빈 줄 제외)이 남지 않으면 우리가 만든 파일로 보고 지운다.
  if (kept.every((row) => !row.trim())) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, `${kept.join('\n').replace(/\n+$/, '')}\n`);
  }
  return true;
}

/** store를 0600으로 저장하고(디렉터리 0700) .gitignore를 보강한다. */
export function writeSecrets(secretsPath, data) {
  const dir = path.dirname(secretsPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretsPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(secretsPath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  ensureSecretsGitignore(dir);
}

/** provider의 연결 목록을 [{ provider, name, account, updatedAt }]로 돌려준다(provider 생략 시 전체). */
export function listConnections(secretsPath, provider = null) {
  const store = loadSecrets(secretsPath);
  const out = [];
  for (const [key, value] of Object.entries(store.connections)) {
    const sep = key.indexOf(':');
    const p = key.slice(0, sep);
    if (provider && p !== provider) continue;
    out.push({ provider: p, name: key.slice(sep + 1), account: value.account, updatedAt: value.updatedAt });
  }
  return out;
}

/** 연결이 존재하면 true. */
export function hasConnection(secretsPath, provider, name) {
  const store = loadSecrets(secretsPath);
  return connectionKey(provider, name) in store.connections;
}

/** 연결 엔트리({ token, account, updatedAt })를 돌려준다. 없으면 undefined. */
export function getConnection(secretsPath, provider, name) {
  const store = loadSecrets(secretsPath);
  const entry = store.connections[connectionKey(provider, name)];
  return entry && entry.token ? entry : undefined;
}

/** 연결의 토큰만 돌려준다. 없으면 undefined. */
export function getConnectionToken(secretsPath, provider, name) {
  const entry = getConnection(secretsPath, provider, name);
  return entry ? entry.token : undefined;
}

/** 연결을 저장/갱신한다(account는 있으면 함께 기록). */
export function addConnection(secretsPath, provider, name, { token, account } = {}) {
  if (!token) throw new Error('연결에 저장할 토큰이 없습니다.');
  const store = loadSecrets(secretsPath);
  const entry = { token, updatedAt: new Date().toISOString() };
  if (account) entry.account = account;
  store.connections[connectionKey(provider, name)] = entry;
  writeSecrets(secretsPath, store);
}

/** 연결을 지운다. 실제로 지웠으면 true. */
export function removeConnection(secretsPath, provider, name) {
  const store = loadSecrets(secretsPath);
  const key = connectionKey(provider, name);
  if (!(key in store.connections)) return false;
  delete store.connections[key];
  writeSecrets(secretsPath, store);
  return true;
}
