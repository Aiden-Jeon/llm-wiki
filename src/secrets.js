// 원격 provider 토큰 저장소. config 디렉터리의 secrets.json(0600)에만 담고
// git·export 번들·워크스페이스에는 절대 내보내지 않는다. 키는 <provider>:<VAULT> 형식이며
// 볼트별 토큰이 없으면 <provider>:* 공용 토큰으로 폴백한다.
//
// 형식:
//   { "version": 1,
//     "tokens": {
//       "notion:PERSONAL": { "token": "secret_…", "updatedAt": "…Z" },
//       "notion:*":        { "token": "secret_…", "updatedAt": "…Z" } } }

import fs from 'node:fs';
import path from 'node:path';
import { normalizeVaultKey } from './providers/token.js';

const SECRETS_VERSION = 1;

/** <provider>:<VAULT> 또는 볼트 미지정 시 <provider>:* 를 만든다. */
export function secretKey(provider, vaultName) {
  const key = vaultName ? normalizeVaultKey(vaultName) : '';
  return `${provider}:${key || '*'}`;
}

/** secrets.json을 읽는다. 없으면 빈 store, 파싱 실패는 명확한 에러로 올린다. */
export function loadSecrets(secretsPath) {
  if (!fs.existsSync(secretsPath)) return { version: SECRETS_VERSION, tokens: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch (error) {
    throw new Error(`${secretsPath} 파싱 실패: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return { version: SECRETS_VERSION, tokens: {} };
  if (!parsed.tokens || typeof parsed.tokens !== 'object') parsed.tokens = {};
  if (!parsed.version) parsed.version = SECRETS_VERSION;
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

/** store를 0600으로 저장하고(디렉터리 0700) .gitignore를 보강한다. */
export function writeSecrets(secretsPath, data) {
  const dir = path.dirname(secretsPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretsPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(secretsPath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  ensureSecretsGitignore(dir);
}

/** 정확 키(provider:<VAULT>) → 공용 키(provider:*) 순으로 토큰을 찾는다. */
export function getSecret(secretsPath, provider, vaultName) {
  const store = loadSecrets(secretsPath);
  const exact = store.tokens[secretKey(provider, vaultName)];
  if (exact && exact.token) return exact.token;
  const shared = store.tokens[secretKey(provider, null)];
  return shared && shared.token ? shared.token : undefined;
}

/** 토큰을 저장한다(provider:<VAULT> 또는 볼트 미지정 시 provider:*). */
export function setSecret(secretsPath, provider, vaultName, token) {
  const store = loadSecrets(secretsPath);
  store.tokens[secretKey(provider, vaultName)] = { token, updatedAt: new Date().toISOString() };
  writeSecrets(secretsPath, store);
}

/** 저장된 토큰을 지운다. 실제로 지웠으면 true. */
export function deleteSecret(secretsPath, provider, vaultName) {
  const store = loadSecrets(secretsPath);
  const key = secretKey(provider, vaultName);
  if (!(key in store.tokens)) return false;
  delete store.tokens[key];
  writeSecrets(secretsPath, store);
  return true;
}
