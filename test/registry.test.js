import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  normalizeAgentCommand, normalizeVault, parseRegistry, parseRegistryFile,
  readAgents, readRegistry, renderRegistry, writeRegistry,
} from '../src/registry.js';

test('registry markdown round-trip', () => {
  const input = [{
    name: 'personal',
    path: '/tmp/my-wiki',
    kind: 'open',
    backend: 'local',
    origin: '',
    signals: 'career, AI',
    notes: 'public notes',
  }];
  assert.deepEqual(parseRegistry(renderRegistry(input)), input);
});

test('registry round-trips a git backend vault with origin', () => {
  const input = [{
    name: 'gwiki',
    path: '/tmp/gwiki',
    kind: 'open',
    backend: 'git',
    origin: 'git@github.com:me/wiki.git',
    signals: '',
    notes: '',
  }];
  assert.deepEqual(parseRegistry(renderRegistry(input)), input);
});

test('registry validates backend/origin coupling', () => {
  assert.throws(() => normalizeVault({ name: 'g', path: '/tmp/g', backend: 'git' }), /origin\(원격 URL\)/);
  assert.throws(() => normalizeVault({ name: 'l', path: '/tmp/l', origin: 'git@x:y.git' }), /local backend.*origin/);
  assert.throws(() => normalizeVault({ name: 'b', path: '/tmp/b', backend: 'svn' }), /local 또는 git/);
  // 기본 backend는 local, origin은 빈 값.
  const v = normalizeVault({ name: 'd', path: '/tmp/d' });
  assert.equal(v.backend, 'local');
  assert.equal(v.origin, '');
});

test('registry promotes legacy 5-column rows to backend=local', () => {
  const content = [
    '| name | path | kind | signals | notes |',
    '|------|------|------|---------|-------|',
    '| old | /tmp/old | open | sig | note |',
  ].join('\n');
  const { vaults, issues } = parseRegistryFile(content);
  assert.equal(issues.length, 0);
  assert.equal(vaults[0].backend, 'local');
  assert.equal(vaults[0].origin, '');
  assert.equal(vaults[0].signals, 'sig');
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
  assert.match(issues[1].message, /7개.*또는.*5개/);
  assert.match(issues[2].message, /중복/);
});

test('registry reports rows with an unsupported column count', () => {
  const content = '| extra | /tmp/extra | open | signal | note | unexpected |';
  const { vaults, issues } = parseRegistryFile(content);
  assert.equal(vaults.length, 0);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /7개.*또는.*5개/);
});

test('readRegistry is strict for writers and lenient when asked', () => {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-')) + '/wikis.local.md';
  writeRegistry(file, [{ name: 'ok', path: '/tmp/ok', kind: 'open' }]);
  fs.appendFileSync(file, '| broken | /tmp/x | privte |  |  |\n');

  assert.throws(() => readRegistry(file), (error) => error.message.includes(file) && /2개|행/.test(error.message));
  assert.deepEqual(readRegistry(file, { strict: false }).map((vault) => vault.name), ['ok']);
});

test('registry round-trips agent overrides with add-dir flag', () => {
  const vaults = [{ name: 'personal', path: '/tmp/v', kind: 'open', backend: 'local', origin: '', signals: '', notes: '' }];
  const agents = [
    { name: 'claude', command: 'vibe agent', addDir: false },
    { name: 'codex', command: 'dbexec repo run isaac', addDir: true },
  ];
  const parsed = parseRegistryFile(renderRegistry(vaults, agents));
  assert.deepEqual(parsed.vaults, vaults);
  assert.deepEqual(parsed.agents, agents);
  assert.equal(parsed.issues.length, 0);
});

test('normalizeAgentCommand defaults add-dir on and rejects bad input', () => {
  assert.equal(normalizeAgentCommand({ name: 'claude', command: 'vibe' }).addDir, true);
  assert.equal(normalizeAgentCommand({ name: 'claude', command: 'vibe', addDir: false }).addDir, false);
  assert.throws(() => normalizeAgentCommand({ name: 'gpt', command: 'x' }), /claude 또는 codex/);
  assert.throws(() => normalizeAgentCommand({ name: 'claude', command: '' }), /command 값이 필요/);
  assert.throws(() => normalizeAgentCommand({ name: 'claude', command: 'a | b' }), /\|/);
});

test('parseRegistryFile accepts legacy 2-col agents and yes/no add-dir', () => {
  const content = [
    '| agent | command | add-dir |',
    '|-------|---------|---------|',
    '| claude | vibe agent | no |',
    '| codex | dbexec repo run isaac |', // 레거시 2열 → add-dir 기본 true
  ].join('\n');
  const { agents, issues } = parseRegistryFile(content);
  assert.equal(issues.length, 0);
  assert.deepEqual(agents, [
    { name: 'claude', command: 'vibe agent', addDir: false },
    { name: 'codex', command: 'dbexec repo run isaac', addDir: true },
  ]);
});

test('parseRegistryFile reports broken and duplicate agent rows with line numbers', () => {
  const content = [
    '| name | path | kind | signals | notes |',
    '|------|------|------|---------|-------|',
    '| ok | /tmp/ok | open |  |  |',
    '',
    '| agent | command | add-dir |',
    '|-------|---------|---------|',
    '| claude | vibe | no |',
    '| gpt | foo | no |',
    '| codex | isaac | yes | extra |',
    '| claude | again | no |',
  ].join('\n');

  const { vaults, agents, issues } = parseRegistryFile(content);
  assert.deepEqual(vaults.map((v) => v.name), ['ok']);
  assert.deepEqual(agents.map((a) => a.name), ['claude']);
  assert.deepEqual(issues.map((i) => i.line), [8, 9, 10]);
  assert.match(issues[0].message, /claude 또는 codex/);
  assert.match(issues[1].message, /2개.*또는.*3개|3개/);
  assert.match(issues[2].message, /중복/);
});

test('writeRegistry preserves existing agent overrides when saving vaults', () => {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-')) + '/wikis.local.md';
  const override = { name: 'codex', command: 'dbexec repo run isaac', addDir: false };
  writeRegistry(file, [{ name: 'a', path: '/tmp/a', kind: 'open' }], [override]);
  // 볼트만 다시 저장(agents 생략) — 매핑이 사라지면 안 된다.
  writeRegistry(file, [{ name: 'a', path: '/tmp/a', kind: 'open' }, { name: 'b', path: '/tmp/b', kind: 'open' }]);
  assert.deepEqual(readAgents(file), [override]);
  assert.deepEqual(readRegistry(file).map((v) => v.name), ['a', 'b']);
});
