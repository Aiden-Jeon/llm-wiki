import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSecret,
  ensureSecretsGitignore,
  getSecret,
  loadSecrets,
  secretKey,
  setSecret,
} from '../src/secrets.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-secrets-'));
}

function secretsPath() {
  return path.join(tmpDir(), 'secrets.json');
}

test('secretKey normalizes vault names and matches token.js scheme', () => {
  assert.equal(secretKey('notion', 'personal'), 'notion:PERSONAL');
  assert.equal(secretKey('notion', 'personal-wiki'), 'notion:PERSONAL_WIKI');
  assert.equal(secretKey('notion', null), 'notion:*');
});

test('set/get/delete round-trip per provider+vault', () => {
  const file = secretsPath();
  assert.equal(getSecret(file, 'notion', 'personal'), undefined);
  setSecret(file, 'notion', 'personal', 'secret_abc');
  assert.equal(getSecret(file, 'notion', 'personal'), 'secret_abc');
  assert.equal(deleteSecret(file, 'notion', 'personal'), true);
  assert.equal(deleteSecret(file, 'notion', 'personal'), false);
  assert.equal(getSecret(file, 'notion', 'personal'), undefined);
});

test('getSecret falls back from vault-specific to provider-wide (*)', () => {
  const file = secretsPath();
  setSecret(file, 'notion', null, 'shared');
  assert.equal(getSecret(file, 'notion', 'anyvault'), 'shared');
  setSecret(file, 'notion', 'anyvault', 'specific');
  assert.equal(getSecret(file, 'notion', 'anyvault'), 'specific');
  assert.equal(getSecret(file, 'notion', 'othervault'), 'shared');
});

test('loadSecrets returns an empty store when the file is absent', () => {
  const store = loadSecrets(path.join(tmpDir(), 'nope.json'));
  assert.deepEqual(store, { version: 1, tokens: {} });
});

test('writeSecrets writes 0600 and ensures a .gitignore entry', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'secrets.json');
  setSecret(file, 'notion', 'personal', 'x');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^secrets\.json$/m);
});

test('ensureSecretsGitignore is idempotent and preserves existing lines', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  ensureSecretsGitignore(dir);
  ensureSecretsGitignore(dir);
  const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(content, /node_modules/);
  assert.equal((content.match(/^secrets\.json$/gm) || []).length, 1);
});
