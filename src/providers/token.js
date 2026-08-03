// 원격 provider 토큰을 해소한다. 우선순위는 환경 변수 → 설정 디렉터리 secrets.json.
// 토큰은 파일(remote.json)·git·로그에 저장하지 않고, secrets store(0600)에만 둔다.
// provider마다 접두사가 다르므로(NOTION, CONFLUENCE …) 접두사를 인자로 받는다.

import { getSecret } from '../secrets.js';

/**
 * 볼트 이름을 토큰 키 조각으로 정규화한다(personal-wiki → PERSONAL_WIKI).
 * env 변수 이름과 secrets store 키가 갈라지지 않도록 이 함수가 단일 출처다.
 */
export function normalizeVaultKey(vaultName) {
  return String(vaultName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * 우선순위: config.tokenEnv(env) → LLMWIKI_<PREFIX>_TOKEN_<VAULT>(env)
 * → LLMWIKI_<PREFIX>_TOKEN(env) → secrets store(provider:<VAULT> → provider:*).
 * env가 store보다 우선이라 CI/스크립트가 오래된 저장 토큰을 덮어쓸 수 있다.
 * secretsPath 미지정 시 store 단계를 건너뛴다(오프라인·기존 호출 호환).
 */
export function resolveRemoteToken(env, { prefix, vaultName, config = null, secretsPath = null, provider = null } = {}) {
  const key = String(prefix || '').toUpperCase();
  const envCandidates = [];
  if (config && config.tokenEnv) envCandidates.push(config.tokenEnv);
  if (vaultName) envCandidates.push(`LLMWIKI_${key}_TOKEN_${normalizeVaultKey(vaultName)}`);
  envCandidates.push(`LLMWIKI_${key}_TOKEN`);
  for (const name of envCandidates) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }

  // env에 없으면 설정 디렉터리 secrets store로 폴백한다.
  const providerName = provider || key.toLowerCase();
  if (secretsPath) {
    const stored = getSecret(secretsPath, providerName, vaultName);
    if (stored && stored.trim()) return stored.trim();
  }

  const storeHint = secretsPath
    ? `, 또는 secrets store(${providerName}:${vaultName ? normalizeVaultKey(vaultName) : '*'}) — llmwiki vault add 위저드로 저장`
    : '';
  throw new Error(
    `${prefix} 토큰을 찾을 수 없습니다. 다음 환경 변수 중 하나를 설정하세요: ${envCandidates.join(', ')}${storeHint}`,
  );
}
