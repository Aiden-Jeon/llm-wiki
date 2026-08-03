import fs from 'node:fs';
import path from 'node:path';
import { legacyConnectionName } from './secrets.js';
import { normalizeVaultKey } from './providers/token.js';

// 볼트별 원격 발행/수집 설정을 읽고 쓴다. provider-중립적인 진입점이다.
// 설정은 볼트가 아니라 전역 config 디렉터리의 publish.json에 담는다(볼트와 분리).
// 볼트는 이름으로 자기 엔트리를 참조만 한다. store 형식(<configDir>/publish.json):
//   {
//     "version": 1,
//     "vaults": {
//       "personal": {
//         "provider": "notion",
//         "connection": "personal",
//         "publish": { "databaseId": "…", "titleProperty": "Name", "syncedSubdirs": ["wiki/entities", …] },
//         "inbox":   { "databaseId": "…" },
//         "allowPublish": false,
//         "tokenEnv": "LLMWIKI_NOTION_TOKEN_PERSONAL"
//       }
//     }
//   }
// 엔트리의 provider 필드가 어떤 원격 대상인지, connection 필드가 secrets store의 어떤
// named connection(토큰)을 쓰는지 결정한다(provider 없으면 기본 'notion' — 첫 구현체).
// 비밀(토큰)은 이 파일에 절대 담지 않는다 — secrets store 전용.

export const DEFAULT_PROVIDER = 'notion';
const PUBLISH_STORE_VERSION = 1;

/**
 * 전역 publish.json store 전체를 읽는다. 없으면 빈 store, 파싱 실패는 명확한 에러로 올린다.
 */
export function loadPublishStore(publishPath) {
  if (!fs.existsSync(publishPath)) return { version: PUBLISH_STORE_VERSION, vaults: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(publishPath, 'utf8'));
  } catch (error) {
    throw new Error(`${publishPath} 파싱 실패: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return { version: PUBLISH_STORE_VERSION, vaults: {} };
  if (!parsed.vaults || typeof parsed.vaults !== 'object') parsed.vaults = {};
  if (!parsed.version) parsed.version = PUBLISH_STORE_VERSION;
  return parsed;
}

/** store 전체를 원자적으로 저장한다(merge는 upsert가 담당). 반환: 기록한 파일 경로. */
function writePublishStore(publishPath, store) {
  fs.mkdirSync(path.dirname(publishPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(publishPath, `${JSON.stringify(store, null, 2)}\n`);
  return publishPath;
}

/**
 * 볼트 이름으로 발행 설정 엔트리를 읽는다. 없으면 null. provider가 비면 기본값을 채운다.
 */
export function loadRemoteConfig(publishPath, vaultName) {
  const store = loadPublishStore(publishPath);
  const config = store.vaults[vaultName];
  if (!config) return null;
  if (!config.provider) config.provider = DEFAULT_PROVIDER;
  // connection이 없는 레거시 엔트리는 볼트 이름에서 마이그레이션 규칙으로 유추한다
  // (secrets.js의 legacyConnectionName과 반드시 일치해야 store 폴백이 맞물린다).
  if (!config.connection) config.connection = legacyConnectionName(normalizeVaultKey(vaultName));
  return config;
}

/**
 * 볼트 엔트리에 patch를 병합해 저장한다(publish·inbox는 얕은 병합으로 필드 보존).
 * 없으면 { version, provider } 기본값에서 시작한다. 반환: { config }.
 */
export function upsertRemoteConfig(publishPath, vaultName, patch = {}) {
  const store = loadPublishStore(publishPath);
  const current = store.vaults[vaultName] || { version: PUBLISH_STORE_VERSION, provider: DEFAULT_PROVIDER };
  const merged = { ...current, ...patch };
  if (!merged.version) merged.version = PUBLISH_STORE_VERSION;
  if (patch.publish) merged.publish = { ...current.publish, ...patch.publish };
  if (patch.inbox) merged.inbox = { ...current.inbox, ...patch.inbox };
  store.vaults[vaultName] = merged;
  writePublishStore(publishPath, store);
  return { config: merged };
}

/** 볼트의 발행 설정 엔트리를 지운다. 실제로 지웠으면 true. */
export function removeRemoteConfig(publishPath, vaultName) {
  const store = loadPublishStore(publishPath);
  if (!(vaultName in store.vaults)) return false;
  delete store.vaults[vaultName];
  writePublishStore(publishPath, store);
  return true;
}

/** 등록된 모든 발행 설정을 { vaultName: config } 맵으로 돌려준다. */
export function listRemoteConfigs(publishPath) {
  return loadPublishStore(publishPath).vaults;
}
