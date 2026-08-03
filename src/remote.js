import fs from 'node:fs';
import path from 'node:path';

// 볼트별 원격 발행/수집 설정을 읽는다. provider-중립적인 진입점이다.
// 설정 파일 <vault>/_meta/remote.json 예:
//   {
//     "version": 1,
//     "provider": "notion",
//     "publish": { "databaseId": "…", "syncedSubdirs": ["wiki/entities", …] },
//     "inbox":   { "databaseId": "…" },
//     "allowPublish": false,
//     "tokenEnv": "LLMWIKI_NOTION_TOKEN_PERSONAL"
//   }
// provider 필드가 어떤 원격 대상인지 결정한다(없으면 기본 'notion' — 첫 구현체).

export const REMOTE_CONFIG_FILE = path.join('_meta', 'remote.json');
const DEFAULT_PROVIDER = 'notion';

/**
 * <vault>/_meta/remote.json을 읽는다. 없으면 null. 파싱 실패는 명확한 에러로 올린다.
 * 비밀(토큰)은 이 파일에 담지 않는다 — 대상 id, 동기화 서브디렉터리 등만.
 */
export function loadRemoteConfig(vaultPath) {
  const file = path.join(vaultPath, REMOTE_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed.provider) parsed.provider = DEFAULT_PROVIDER;
    return parsed;
  } catch (error) {
    throw new Error(`${file} 파싱 실패: ${error.message}`);
  }
}
