import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  normalizeVault, parseRegistry, parseRegistryFile, readRegistry, renderRegistry, writeRegistry,
} from '../src/registry.js';

test('registry markdown round-trip', () => {
  const input = [{
    name: 'personal',
    path: '/tmp/my-wiki',
    kind: 'open',
    signals: 'career, AI',
    notes: 'public notes',
  }];
  assert.deepEqual(parseRegistry(renderRegistry(input)), input);
});

test('registry expands POSIX and Windows-style home-relative vault paths', () => {
  const posixVault = normalizeVault({ name: 'posix', path: '~/wiki', kind: 'open' });
  const windowsVault = normalizeVault({ name: 'windows', path: '~\\wiki', kind: 'open' });
  assert.equal(posixVault.path, path.join(os.homedir(), 'wiki'));
  assert.equal(windowsVault.path, path.join(os.homedir(), 'wiki'));
});

test('registry rejects invalid secure kind and markdown delimiters', () => {
  assert.throws(() => renderRegistry([{ name: 'bad|name', path: '/tmp/x', kind: 'open' }]), /\|/);
  assert.throws(() => renderRegistry([{ name: 'work', path: '/tmp/x', kind: 'private' }]), /open 또는 secure/);
});

test('registry reports broken rows with line numbers instead of throwing', () => {
  const content = [
    '| name | path | kind | signals | notes |',
    '|------|------|------|---------|-------|',
    '| ok | /tmp/ok | open |  |  |',
    '| broken | /tmp/x | privte |  |  |',
    '| short | /tmp/x |',
    '| ok | /tmp/dupe | open |  |  |',
  ].join('\n');

  const { vaults, issues } = parseRegistryFile(content);
  assert.deepEqual(vaults.map((vault) => vault.name), ['ok']);
  assert.deepEqual(issues.map((issue) => issue.line), [4, 5, 6]);
  assert.match(issues[0].message, /open 또는 secure/);
  assert.match(issues[1].message, /5개/);
  assert.match(issues[2].message, /중복/);
});

test('registry reports rows with extra columns', () => {
  const content = '| extra | /tmp/extra | open | signal | note | unexpected |';
  const { vaults, issues } = parseRegistryFile(content);
  assert.equal(vaults.length, 0);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /정확히 5개/);
});

test('readRegistry is strict for writers and lenient when asked', () => {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-')) + '/wikis.local.md';
  writeRegistry(file, [{ name: 'ok', path: '/tmp/ok', kind: 'open' }]);
  fs.appendFileSync(file, '| broken | /tmp/x | privte |  |  |\n');

  assert.throws(() => readRegistry(file), (error) => error.message.includes(file) && /2개|행/.test(error.message));
  assert.deepEqual(readRegistry(file, { strict: false }).map((vault) => vault.name), ['ok']);
});
