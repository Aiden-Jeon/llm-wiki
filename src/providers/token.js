// 원격 provider 토큰을 환경 변수에서만 해소한다(파일·git·로그 저장 금지).
// provider마다 접두사가 다르므로(NOTION, CONFLUENCE …) 접두사를 인자로 받는다.

/**
 * 우선순위: config.tokenEnv → LLMWIKI_<PREFIX>_TOKEN_<VAULT> → LLMWIKI_<PREFIX>_TOKEN.
 * 볼트 이름은 대문자화하고 영숫자 외는 _로 바꾼다(personal-wiki → PERSONAL_WIKI).
 */
export function resolveRemoteToken(env, { prefix, vaultName, config = null } = {}) {
  const key = String(prefix || '').toUpperCase();
  const candidates = [];
  if (config && config.tokenEnv) candidates.push(config.tokenEnv);
  if (vaultName) {
    const upper = vaultName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    candidates.push(`LLMWIKI_${key}_TOKEN_${upper}`);
  }
  candidates.push(`LLMWIKI_${key}_TOKEN`);
  for (const name of candidates) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  throw new Error(
    `${prefix} 토큰을 찾을 수 없습니다. 다음 환경 변수 중 하나를 설정하세요: ${candidates.join(', ')}`,
  );
}
