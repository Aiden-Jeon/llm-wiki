import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addConnection,
  connectionKey,
  ensureSecretsGitignore,
  pruneSecretsGitignore,
  getConnection,
  getConnectionToken,
  hasConnection,
  legacyConnectionName,
  listConnections,
  loadSecrets,
  removeConnection,
} from '../src/secrets.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-secrets-'));
}

function secretsPath() {
  return path.join(tmpDir(), 'secrets.json');
}

test('connectionKey builds <provider>:<name> and rejects names with a colon', () => {
  assert.equal(connectionKey('notion', 'personal'), 'notion:personal');
  assert.equal(connectionKey('notion', '  work-team '), 'notion:work-team');
  assert.throws(() => connectionKey('notion', 'bad:name'), /':'/);
  assert.throws(() => connectionKey('notion', ''), /비었/);
});

test('legacyConnectionName maps v1 vault keys to v2 connection names', () => {
  assert.equal(legacyConnectionName('*'), 'default');
  assert.equal(legacyConnectionName(''), 'default');
  assert.equal(legacyConnectionName('PERSONAL_WIKI'), 'personal_wiki');
});

test('add/get/remove round-trip per provider+connection', () => {
  const file = secretsPath();
  assert.equal(getConnectionToken(file, 'notion', 'personal'), undefined);
  addConnection(file, 'notion', 'personal', { token: 'secret_abc', account: "Jane's WS" });
  assert.equal(getConnectionToken(file, 'notion', 'personal'), 'secret_abc');
  assert.equal(getConnection(file, 'notion', 'personal').account, "Jane's WS");
  assert.equal(hasConnection(file, 'notion', 'personal'), true);
  assert.equal(removeConnection(file, 'notion', 'personal'), true);
  assert.equal(removeConnection(file, 'notion', 'personal'), false);
  assert.equal(getConnectionToken(file, 'notion', 'personal'), undefined);
});

test('addConnection rejects an empty token', () => {
  assert.throws(() => addConnection(secretsPath(), 'notion', 'personal', {}), /토큰이 없/);
});

test('listConnections filters by provider', () => {
  const file = secretsPath();
  addConnection(file, 'notion', 'personal', { token: 'a' });
  addConnection(file, 'notion', 'work', { token: 'b' });
  addConnection(file, 'confluence', 'team', { token: 'c' });
  assert.deepEqual(listConnections(file, 'notion').map((c) => c.name).sort(), ['personal', 'work']);
  assert.equal(listConnections(file).length, 3);
});

test('loadSecrets returns an empty v2 store when the file is absent', () => {
  const store = loadSecrets(path.join(tmpDir(), 'nope.json'));
  assert.deepEqual(store, { version: 2, connections: {} });
});

test('loadSecrets migrates a v1 token store to v2 connections', () => {
  const file = secretsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    tokens: { 'notion:*': { token: 'shared' }, 'notion:PERSONAL': { token: 'specific' } },
  }));
  const store = loadSecrets(file);
  assert.equal(store.version, 2);
  assert.equal(store.connections['notion:default'].token, 'shared');
  assert.equal(store.connections['notion:personal'].token, 'specific');
});

test('writeSecrets writes 0600 and ensures a .gitignore entry', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'secrets.json');
  addConnection(file, 'notion', 'personal', { token: 'x' });
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

test('pruneSecretsGitignore removes only the secrets.json rule and keeps others', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\nsecrets.json\ncache/\n');
  assert.equal(pruneSecretsGitignore(dir), true);
  const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(content, 'node_modules\ncache/\n');
});

test('pruneSecretsGitignore deletes a .gitignore that held only the secrets.json rule', () => {
  const dir = tmpDir();
  ensureSecretsGitignore(dir); // secrets.json만 담긴 파일 생성
  assert.equal(pruneSecretsGitignore(dir), true);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
});

test('pruneSecretsGitignore is a no-op when the file or rule is absent', () => {
  const dir = tmpDir();
  assert.equal(pruneSecretsGitignore(dir), false); // 파일 없음
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  assert.equal(pruneSecretsGitignore(dir), false); // 규칙 없음
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n');
});
