import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIngestPrompt,
  extractAddDirFlag,
  main,
  parseOptions,
  prepareWorkspace,
  serializeCommand,
  splitCommand,
} from '../src/cli.js';
import { spawnSync } from 'node:child_process';
import { getPaths } from '../src/paths.js';
import { writeRegistry, readRegistry } from '../src/registry.js';
import { createSkill } from '../src/skills.js';
import { isGitAvailable } from '../src/git.js';

const HAS_GIT = isGitAvailable();

function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'));
  return getPaths({
    LLM_WIKI_CONFIG_HOME: path.join(root, 'config'),
    LLM_WIKI_DATA_HOME: path.join(root, 'data'),
  });
}

test('parseOptions keeps "=" inside option values', () => {
  const { options } = parseOptions(['--notes=k=v, x', '--signals', 'a,b'], { allowed: ['notes', 'signals'] });
  assert.equal(options.notes, 'k=v, x');
  assert.equal(options.signals, 'a,b');
});

test('parseOptions rejects unknown options instead of ignoring them', () => {
  assert.throws(
    () => parseOptions(['--kine', 'secure'], { allowed: ['kind'] }),
    /\uc54c \uc218 \uc5c6\ub294 \uc635\uc158: --kine/,
  );
});

test('parseOptions treats declared booleans as flags', () => {
  assert.equal(parseOptions(['--json'], { allowed: ['json'], booleans: ['json'] }).options.json, true);
  assert.equal(parseOptions(['--json=false'], { allowed: ['json'], booleans: ['json'] }).options.json, false);
});

test('parseOptions requires a value and collects positionals', () => {
  assert.throws(() => parseOptions(['--name'], { allowed: ['name'] }), /--name \uc635\uc158 \uac12\uc774 \ud544\uc694/);
  assert.deepEqual(parseOptions(['personal', '/tmp/v']).rest, ['personal', '/tmp/v']);
});

test('extractAddDirFlag consumes add-dir flags but preserves tokens after --', () => {
  assert.deepEqual(extractAddDirFlag(['vibe', 'agent']), { command: ['vibe', 'agent'], addDir: undefined });
  assert.deepEqual(extractAddDirFlag(['--add-dir', 'vibe']), { command: ['vibe'], addDir: true });
  assert.deepEqual(extractAddDirFlag(['vibe', '--no-add-dir']), { command: ['vibe'], addDir: false });
  // -- 이후는 경계로 취급해 실행 명령 인자로 그대로 보존한다.
  assert.deepEqual(
    extractAddDirFlag(['mycli', '--', '--add-dir', '.']),
    { command: ['mycli', '--add-dir', '.'], addDir: undefined },
  );
  // -- 앞의 --no-add-dir는 여전히 설정 플래그로 소비된다.
  assert.deepEqual(
    extractAddDirFlag(['--no-add-dir', 'mycli', '--', '--add-dir']),
    { command: ['mycli', '--add-dir'], addDir: false },
  );
});

test('serializeCommand quotes whitespace tokens so splitCommand round-trips argv boundaries', () => {
  const tokens = ['codex', 'wrapper', 'profile name'];
  assert.equal(serializeCommand(tokens), 'codex wrapper "profile name"');
  assert.deepEqual(splitCommand(serializeCommand(tokens)), tokens);
  assert.throws(() => serializeCommand(['a"b']), /큰따옴표/);
});

test('buildIngestPrompt targets the slash command for claude and a task instruction for codex', () => {
  assert.equal(buildIngestPrompt('claude', 'https://example.com'), '/wiki-add https://example.com');
  assert.match(buildIngestPrompt('codex', '~/notes.md'), /^wiki-add 태스크를 실행한다\. 입력: ~\/notes\.md$/);
});

test('main rejects unknown commands and bad inbox subcommands', async () => {
  await assert.rejects(main(['bogus']), /알 수 없는 명령: bogus/);
  await assert.rejects(main(['inbox', 'push']), /llmwiki inbox pull/);
  await assert.rejects(main(['vault', 'bogus']), /add\|list\|show\|remove\|lint\|scaffold\|sync/);
});

test('vault sync skips a local backend vault instead of running git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-vsync-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath, kind: 'open' }]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    const result = await main(['vault', 'sync', 'personal']);
    assert.equal(result, false);
    assert.ok(logs.some((l) => /local 백엔드라 sync 대상이 아닙니다/.test(l)));
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('vault add rejects a supplied --origin that mismatches an existing repo remote', { skip: !HAS_GIT }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-origin-'));
  const realRemote = path.join(root, 'real.git');
  const existing = path.join(root, 'existing');
  spawnSync('git', ['init', '--bare', realRemote]);
  spawnSync('git', ['clone', realRemote, existing]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  try {
    // 잘못된 origin은 거부된다.
    await assert.rejects(
      () => main(['vault', 'add', '--name', 'gw', '--backend', 'git', '--path', existing, '--origin', path.join(root, 'wrong.git')]),
      /실제 origin.*과 다릅니다/,
    );
    // origin 생략 시 실제 remote를 자동 기록한다.
    await main(['vault', 'add', '--name', 'gw', '--backend', 'git', '--path', existing]);
    assert.equal(readRegistry(paths.registry).find((v) => v.name === 'gw').origin, realRemote);
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('sync accepts --dry-run so it errors on config, not on the flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-syncflag-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath, kind: 'open' }]);

  const prevConfig = process.env.LLM_WIKI_CONFIG_HOME;
  const prevData = process.env.LLM_WIKI_DATA_HOME;
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // --dry-run이 allowed에 없으면 "알 수 없는 옵션"으로 실패한다. 설정 부재 에러까지 도달해야 정상.
    await assert.rejects(() => main(['sync', 'personal', '--dry-run']), /원격 sync 설정이 없습니다/);
  } finally {
    if (prevConfig === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prevData;
  }
});

test('prepareWorkspace refreshes managed files and keeps local agent state', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal', kind: 'open' }]);

  fs.mkdirSync(path.join(paths.workspace, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(paths.workspace, '.claude/settings.local.json'), '{"permissions":{}}');
  fs.writeFileSync(path.join(paths.workspace, '.claude/stale.json'), 'x');
  fs.writeFileSync(path.join(paths.workspace, 'CLAUDE.md'), 'overwritten by user');

  prepareWorkspace(paths);
  prepareWorkspace(paths); // 반복 실행에도 사용자 상태가 남아야 한다.

  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/settings.local.json')));
  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/stale.json')));
  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/commands/wiki-add.md')));
  assert.ok(fs.existsSync(path.join(paths.workspace, 'WORKSPACE.md')));
  assert.notEqual(fs.readFileSync(path.join(paths.workspace, 'CLAUDE.md'), 'utf8'), 'overwritten by user');
  assert.match(fs.readFileSync(path.join(paths.workspace, 'wikis.local.md'), 'utf8'), /\| personal \|/);
});

test('prepareWorkspace publishes user skills as skills, commands and catalog', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal', kind: 'open' }]);
  createSkill(paths.skillsDir, { name: 'weekly-retro', description: '주간 회고를 생성한다.' });
  // 내장 명령은 스킬이 덮어쓰지 못해야 한다.
  fs.mkdirSync(path.join(paths.skillsDir, 'wiki-add'), { recursive: true });
  fs.writeFileSync(path.join(paths.skillsDir, 'wiki-add', 'SKILL.md'), '---\nname: wiki-add\ndescription: hijack\n---\n');

  prepareWorkspace(paths);

  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/skills/weekly-retro/SKILL.md')));
  assert.match(fs.readFileSync(path.join(paths.workspace, '.claude/commands/weekly-retro.md'), 'utf8'), /\$ARGUMENTS/);
  assert.match(fs.readFileSync(path.join(paths.workspace, 'SKILLS.md'), 'utf8'), /weekly-retro/);
  assert.ok(!fs.existsSync(path.join(paths.workspace, '.claude/skills/wiki-add')));
  assert.doesNotMatch(fs.readFileSync(path.join(paths.workspace, '.claude/commands/wiki-add.md'), 'utf8'), /hijack/);

  // 삭제한 스킬은 다음 실행에서 워킬스페이스에도 남지 않는다.
  fs.rmSync(path.join(paths.skillsDir, 'weekly-retro'), { recursive: true, force: true });
  prepareWorkspace(paths);
  assert.ok(!fs.existsSync(path.join(paths.workspace, '.claude/skills/weekly-retro')));
  assert.ok(!fs.existsSync(path.join(paths.workspace, '.claude/commands/weekly-retro.md')));
});

test('prepareWorkspace symlinks existing vaults into vaults/ and skips missing ones', () => {
  const paths = tmpPaths();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-vault-'));
  const realVault = path.join(root, 'personal');
  fs.mkdirSync(realVault, { recursive: true });
  fs.writeFileSync(path.join(realVault, 'index.md'), '# personal');
  writeRegistry(paths.registry, [
    { name: 'personal', path: realVault, kind: 'open' },
    { name: 'ghost', path: path.join(root, 'does-not-exist'), kind: 'open' },
  ]);

  prepareWorkspace(paths);

  const link = path.join(paths.workspace, 'vaults', 'personal');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(link, 'index.md'), 'utf8'), '# personal');
  assert.ok(!fs.existsSync(path.join(paths.workspace, 'vaults', 'ghost')));

  // 볼트를 제거하면 다음 실행에서 링크도 사라진다.
  writeRegistry(paths.registry, []);
  prepareWorkspace(paths);
  assert.ok(!fs.existsSync(path.join(paths.workspace, 'vaults', 'personal')));
});

test('prepareWorkspace fails with setup guidance when config is missing', () => {
  assert.throws(() => prepareWorkspace(tmpPaths()), /llmwiki setup/);
});
