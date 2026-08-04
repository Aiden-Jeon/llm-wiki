import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIngestPrompt,
  buildSkillAuthorPrompt,
  configureRemote,
  connectionAdd,
  connectionRemove,
  extractAddDirFlag,
  main,
  parseLimit,
  parseOptions,
  prepareWorkspace,
  publishRemove,
  resetConfig,
  serializeCommand,
  splitCommand,
} from '../src/cli.js';
import { spawnSync } from 'node:child_process';
import { getPaths } from '../src/paths.js';
import { writeRegistry, readRegistry, readAgents } from '../src/registry.js';
import { setSelectForTest, setTextForTest } from '../src/prompts.js';
import { createSkill } from '../src/skills.js';
import { isGitAvailable } from '../src/git.js';
import { getConnectionToken, addConnection, listConnections } from '../src/secrets.js';
import { loadRemoteConfig, upsertRemoteConfig } from '../src/remote.js';
import { buildExportBundle } from '../src/settings.js';

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
    () => parseOptions(['--bogus', 'x'], { allowed: ['notes'] }),
    /\uc54c \uc218 \uc5c6\ub294 \uc635\uc158: --bogus/,
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

test('parseLimit rejects partially numeric and unsafe values', () => {
  assert.equal(parseLimit({ limit: '10' }), 10);
  assert.throws(() => parseLimit({ limit: '10abc' }), /양의 정수/);
  assert.throws(() => parseLimit({ limit: '9007199254740992' }), /안전 정수/);
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

test('buildSkillAuthorPrompt routes to skill-author and tolerates an empty request', () => {
  assert.equal(buildSkillAuthorPrompt('claude', 'weekly-retro'), '/skill-author weekly-retro');
  assert.equal(buildSkillAuthorPrompt('claude', ''), '/skill-author');
  assert.equal(buildSkillAuthorPrompt('codex', 'weekly-retro'), 'skill-author 태스크를 실행한다. 요청: weekly-retro');
  assert.equal(buildSkillAuthorPrompt('codex', '  '), 'skill-author 태스크를 실행한다.');
});

test('main rejects unknown commands and bad inbox subcommands', async () => {
  await assert.rejects(main(['bogus']), /알 수 없는 명령: bogus/);
  await assert.rejects(main(['inbox', 'push']), /llmwiki inbox pull/);
  await assert.rejects(main(['vault', 'bogus']), /add\|list\|show\|remove\|lint\|scaffold\|sync/);
  await assert.rejects(main(['skill', 'bogus']), /list\|new\|add\|show\|edit\|lint\|remove/);
  // `skill new`는 예전에 `skill add`의 별칭이었다. 결정론 플래그는 프롬프트가 아니라 에러로 보낸다.
  await assert.rejects(main(['skill', 'new', 'retro', '--description', 'x']), /llmwiki skill add/);
});

// 이름 인자가 빠지면 TTY에서는 목록 선택으로 넘어가고, 비-TTY에서는 기존 에러를 유지한다.
// (테스트는 비-TTY이므로 여기서는 에러 계약이 깨지지 않았음을 고정한다.)
test('name-less subcommands still error in non-TTY instead of hanging on a picker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-picker-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }, { name: 'work', path: vaultPath }]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    await assert.rejects(main(['vault', 'show']), /확인할 볼트 이름이 필요합니다/);
    await assert.rejects(main(['vault', 'remove']), /제거할 볼트 이름이 필요합니다/);
    await assert.rejects(main(['skill', 'show']), /확인할 스킬 이름이 필요합니다/);
    await assert.rejects(main(['skill', 'edit']), /편집할 스킬 이름이 필요합니다/);
    await assert.rejects(main(['skill', 'remove']), /삭제할 스킬 이름이 필요합니다/);
    await assert.rejects(main(['agent', 'set']), /설정할 에이전트 이름이 필요합니다/);
    await assert.rejects(main(['agent', 'reset']), /초기화할 에이전트 이름이 필요합니다/);
    await assert.rejects(main(['vault', 'sync']), /대상 볼트를 지정하세요/);
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

/**
 * picker 경로는 TTY에서만 돈다. stdin.isTTY를 켜고 select를 주입해
 * "무엇이 선택지로 제시되는지"와 "선택 결과가 어떻게 쓰이는지"를 검증한다.
 * onSelect(options, message) → 고를 value (null이면 취소).
 */
async function withPicker(onSelect, fn, onText) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const seen = [];
  const texts = [];
  setSelectForTest((options, message) => {
    seen.push({ message, values: options.map((o) => o.value), options });
    return onSelect(options, message);
  });
  if (onText) {
    setTextForTest((opts) => {
      texts.push(opts);
      return onText(opts);
    });
  }
  try {
    return { result: await fn(), seen, texts };
  } finally {
    setSelectForTest(null);
    setTextForTest(null);
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete process.stdin.isTTY;
  }
}

test('vault sync picker offers only git-backend vaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-sync-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [
    { name: 'localonly', path: vaultPath },
    { name: 'shared', path: vaultPath, backend: 'git', origin: 'https://example.com/w.git' },
  ]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // 취소(null)로 두면 git 동작 없이 선택지만 확인할 수 있다.
    const { result, seen } = await withPicker(() => null, () => main(['vault', 'sync']));
    assert.equal(result, false);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].values, ['shared'], 'local 백엔드 볼트는 선택지에서 제외된다');
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('vault sync degrades to an info message when no git vault exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-nogit-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'a', path: vaultPath }, { name: 'b', path: vaultPath }]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // 이름을 지정했을 때처럼 던지지 않고 false를 반환해야 한다(같은 상황·같은 심각도).
    const { result, seen } = await withPicker(() => null, () => main(['vault', 'sync']));
    assert.equal(result, false);
    assert.equal(seen.length, 0, 'git 볼트가 없으면 picker를 띄우지 않는다');
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('agent reset picker offers only agents with a custom override, and applies the pick', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-agent-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  writeRegistry(paths.registry, [], [{ name: 'codex', command: 'dbexec repo run isaac', addDir: false }]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const origLog = console.log;
  console.log = () => {};
  try {
    const { seen } = await withPicker((options) => options[0].value, () => main(['agent', 'reset']));
    assert.deepEqual(seen[0].values, ['codex'], '기본값인 claude는 초기화 대상이 아니다');
    assert.equal(readAgents(paths.registry).length, 0, '선택한 에이전트가 실제로 초기화된다');
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

/**
 * `agent set`은 이름을 생략하면 실행 명령도 반드시 비어 있다(dispatch가 첫 토큰을 이름으로
 * 잡으므로). 따라서 에이전트 선택 → 명령 입력까지 이어져야 완주한다. 이 흐름을 고정한다.
 */
test('agent set picker asks for the command and saves the tokenized result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-set-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const origLog = console.log;
  console.log = () => {};
  try {
    const { seen, texts } = await withPicker(
      () => 'codex',
      () => main(['agent', 'set']),
      () => 'dbexec repo run isaac',
    );
    assert.deepEqual(seen[0].values, ['claude', 'codex']);
    assert.equal(texts.length, 1, '에이전트를 고른 뒤 실행 명령을 물어본다');
    assert.match(texts[0].message, /codex/);

    const agents = readAgents(paths.registry);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, 'codex');
    assert.equal(agents[0].command, 'dbexec repo run isaac');
    assert.equal(agents[0].addDir, false, '커스텀 명령은 기본적으로 --add-dir를 붙이지 않는다');
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('agent set tokenizes a quoted command from the prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-quote-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const origLog = console.log;
  console.log = () => {};
  try {
    // 공백이 든 인자는 따옴표로 묶어 입력한다 → 하나의 토큰으로 보존돼야 한다.
    await withPicker(() => 'claude', () => main(['agent', 'set']), () => 'mycli "my arg" tail');
    const agents = readAgents(paths.registry);
    assert.equal(agents[0].command, 'mycli "my arg" tail');
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('agent set rejects a blank command and saves nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-blank-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    await assert.rejects(
      withPicker(() => 'claude', () => main(['agent', 'set']), () => '   '),
      /실행 명령을 입력하세요/,
    );
    assert.equal(readAgents(paths.registry).length, 0);
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('agent set keeps a command passed as arguments without prompting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-args-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const origLog = console.log;
  console.log = () => {};
  try {
    // 이름을 명시하면 picker도 text 프롬프트도 뜨지 않아야 한다(--add-dir는 그대로 해석).
    const { seen, texts } = await withPicker(
      () => assert.fail('picker가 뜨면 안 된다'),
      () => main(['agent', 'set', 'codex', '--add-dir', 'mycli']),
      () => assert.fail('text 프롬프트가 뜨면 안 된다'),
    );
    assert.equal(seen.length, 0);
    assert.equal(texts.length, 0);
    const agents = readAgents(paths.registry);
    assert.equal(agents[0].command, 'mycli');
    assert.equal(agents[0].addDir, true);
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('cancelling the agent set command prompt saves nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-setcancel-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // 명령 입력에서 취소(null)하면 에이전트는 저장되지 않는다.
    await withPicker(() => 'claude', () => main(['agent', 'set']), () => null);
    assert.equal(readAgents(paths.registry).length, 0);
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('cancelling a picker makes no changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pick-cancel-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'keep', path: vaultPath }, { name: 'other', path: vaultPath }]);

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    const { result } = await withPicker(() => null, () => main(['vault', 'remove']));
    assert.equal(result, false);
    assert.equal(readRegistry(paths.registry).length, 2, '취소하면 볼트가 지워지지 않는다');
  } finally {
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

// 이름을 명시하면 picker를 우회하고 기존 동작이 그대로 유지된다.
test('explicit names bypass the picker and keep resolving as before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-picker2-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  createSkill(paths.skillsDir, { name: 'draft', description: 'LinkedIn 초안' });

  const prev = { c: process.env.LLM_WIKI_CONFIG_HOME, d: process.env.LLM_WIKI_DATA_HOME };
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    await main(['vault', 'show', 'personal']);
    assert.ok(logs.some((l) => /personal/.test(l)));
    logs.length = 0;
    await main(['skill', 'show', 'draft']);
    assert.ok(logs.some((l) => /draft/.test(l)));
    await assert.rejects(main(['vault', 'show', 'nope']), /등록되지 않은 볼트입니다: nope/);
    await assert.rejects(main(['skill', 'show', 'nope']), /등록되지 않은 스킬입니다: nope/);
  } finally {
    console.log = origLog;
    if (prev.c === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prev.d;
  }
});

test('vault sync skips a local backend vault instead of running git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-vsync-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);

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

test('publish accepts --dry-run so it errors on config, not on the flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pubflag-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);

  const prevConfig = process.env.LLM_WIKI_CONFIG_HOME;
  const prevData = process.env.LLM_WIKI_DATA_HOME;
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // --dry-run이 allowed에 없으면 "알 수 없는 옵션"으로 실패한다. 설정 부재 에러까지 도달해야 정상.
    await assert.rejects(() => main(['publish', 'personal', '--dry-run']), /원격 publish 설정이 없습니다/);
  } finally {
    if (prevConfig === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prevData;
  }
});

test('publish subcommands route: list on empty store and add requires a token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-pubsub-'));
  const paths = getPaths({ LLM_WIKI_CONFIG_HOME: path.join(root, 'config'), LLM_WIKI_DATA_HOME: path.join(root, 'data') });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);

  const prevConfig = process.env.LLM_WIKI_CONFIG_HOME;
  const prevData = process.env.LLM_WIKI_DATA_HOME;
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // list는 빈 store에서도 성공한다(설정 없음 안내).
    assert.equal(await main(['publish', 'list']), true);
    // add는 add 서브명령으로 라우팅돼 토큰 부재까지 도달한다(볼트 이름으로 오인 안 함).
    await assert.rejects(() => main(['publish', 'add', 'personal', '--remote', 'notion', '--publish-db', 'db1']), /--remote-token\(과 --connection\)이 필요/);
  } finally {
    if (prevConfig === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prevData;
  }
});

test('vault add no longer accepts remote flags (decoupled from publish add)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-vadd-'));
  const prevConfig = process.env.LLM_WIKI_CONFIG_HOME;
  const prevData = process.env.LLM_WIKI_DATA_HOME;
  process.env.LLM_WIKI_CONFIG_HOME = path.join(root, 'config');
  process.env.LLM_WIKI_DATA_HOME = path.join(root, 'data');
  try {
    // 원격 옵션이 vault add에서 제거됐으므로 알 수 없는 옵션으로 실패해야 한다.
    await assert.rejects(
      () => main(['vault', 'add', '--name', 'x', '--path', path.join(root, 'v'), '--remote', 'notion']),
      /알 수 없는 옵션: --remote/,
    );
  } finally {
    if (prevConfig === undefined) delete process.env.LLM_WIKI_CONFIG_HOME; else process.env.LLM_WIKI_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.LLM_WIKI_DATA_HOME; else process.env.LLM_WIKI_DATA_HOME = prevData;
  }
});

test('prepareWorkspace refreshes managed files and keeps local agent state', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal' }]);

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
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal' }]);
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
  // skill-author도 내장 명령이므로 워크스페이스에 항상 존재해야 한다(llmwiki skill new의 대상).
  assert.match(fs.readFileSync(path.join(paths.workspace, '.claude/commands/skill-author.md'), 'utf8'), /llmwiki skill lint/);

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
    { name: 'personal', path: realVault },
    { name: 'ghost', path: path.join(root, 'does-not-exist') },
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

// configureRemote: 저장 전 검증 → 성공 시에만 토큰(store)·remote.json(토큰 없이) 기록.
function stubProvider(calls) {
  return {
    name: 'notion',
    tokenPrefix: 'NOTION',
    createClient: async (token) => { calls.push(`create:${token}`); return {}; },
    validateToken: async () => { calls.push('validate'); return { ok: true }; },
    verifyDatabase: async (_c, { databaseId }) => { calls.push(`verify:${databaseId}`); return { ok: true }; },
  };
}

test('configureRemote validates before storing, then writes token to store and db to publish.json', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-cr-'));
  const vault = { name: 'personal', path: vaultPath };
  const calls = [];

  const ok = await configureRemote(paths, vault,
    { remote: 'notion', connection: 'personal', 'remote-token': 'secret_x', 'publish-db': 'db1', 'inbox-db': 'ibx' },
    { getProvider: () => stubProvider(calls) });

  assert.equal(ok, true);
  // 검증(validate/verify)이 어떤 저장보다 먼저 실행됐다.
  assert.deepEqual(calls, ['create:secret_x', 'validate', 'verify:db1', 'verify:ibx']);
  // 토큰은 named connection('personal')으로 저장된다.
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'personal'), 'secret_x');
  const config = loadRemoteConfig(paths.publish, 'personal');
  assert.equal(config.provider, 'notion');
  assert.equal(config.publish.databaseId, 'db1');
  assert.equal(config.inbox.databaseId, 'ibx');
  // 설정은 볼트 밖 전역 publish.json에 저장되고, 볼트 _meta/에는 아무것도 쓰지 않는다.
  assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'remote.json')), false);
  // publish.json에는 토큰이 절대 담기지 않는다.
  assert.doesNotMatch(fs.readFileSync(paths.publish, 'utf8'), /secret_x|token/i);
});

test('configureRemote does not store anything when validation fails', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-crfail-'));
  const vault = { name: 'personal', path: vaultPath };
  const provider = {
    name: 'notion', tokenPrefix: 'NOTION',
    createClient: async () => ({}),
    validateToken: async () => { throw new Error('Notion 토큰 검증 실패 — unauthorized'); },
    verifyDatabase: async () => ({ ok: true }),
  };
  await assert.rejects(
    () => configureRemote(paths, vault, { remote: 'notion', connection: 'personal', 'remote-token': 'bad', 'publish-db': 'db1' }, { getProvider: () => provider }),
    /토큰 검증 실패/,
  );
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'personal'), undefined);
  assert.equal(loadRemoteConfig(paths.publish, 'personal'), null);
});

test('configureRemote (non-TTY) needs a token when no connection is stored', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-crtok-'));
  const vault = { name: 'personal', path: vaultPath };
  await assert.rejects(
    () => configureRemote(paths, vault, { remote: 'notion', 'publish-db': 'db1' }, { getProvider: () => stubProvider([]) }),
    /--remote-token/,
  );
});

test('configureRemote (non-TTY) defaults the connection name to the vault name', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-crdef-'));
  const vault = { name: 'personal', path: vaultPath };
  await configureRemote(paths, vault,
    { remote: 'notion', 'remote-token': 'secret_x', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });
  const config = loadRemoteConfig(paths.publish, 'personal');
  assert.equal(config.connection, 'personal');
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'personal'), 'secret_x');
});

test('configureRemote reuses a stored connection by name without a new token', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-crreuse-'));
  addConnection(paths.secrets, 'notion', 'shared', { token: 'secret_shared', account: 'ACME' });
  const calls = [];
  const ok = await configureRemote(paths, { name: 'work', path: vaultPath },
    { remote: 'notion', connection: 'shared', 'publish-db': 'db1' },
    { getProvider: () => stubProvider(calls) });
  assert.equal(ok, true);
  // 저장된 연결 토큰으로 검증했다(새로 저장하지 않는다).
  assert.deepEqual(calls, ['create:secret_shared', 'validate', 'verify:db1']);
  assert.equal(loadRemoteConfig(paths.publish, 'work').connection, 'shared');
  assert.equal(listConnections(paths.secrets, 'notion').length, 1);
});

test('publish remove (non-TTY) keeps the connection token by default', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-prkeep-'));
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  await configureRemote(paths, { name: 'personal', path: vaultPath },
    { remote: 'notion', connection: 'personal', 'remote-token': 'secret_x', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });

  const removed = await publishRemove(paths, ['personal']);

  assert.equal(removed, true);
  assert.equal(loadRemoteConfig(paths.publish, 'personal'), null); // 설정은 삭제됐다
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'personal'), 'secret_x'); // 토큰(연결)은 유지됐다
});

test('publish remove --purge-token deletes the token once the connection is orphaned', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-prpurge-'));
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  await configureRemote(paths, { name: 'personal', path: vaultPath },
    { remote: 'notion', connection: 'personal', 'remote-token': 'secret_x', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });

  const removed = await publishRemove(paths, ['personal', '--purge-token']);

  assert.equal(removed, true);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'personal'), undefined); // 고아 → 토큰 삭제
});

test('publish remove --purge-token keeps a connection still used by another vault', async () => {
  const paths = tmpPaths();
  const vpA = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-prshareA-'));
  const vpB = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-prshareB-'));
  writeRegistry(paths.registry, [
    { name: 'alpha', path: vpA },
    { name: 'beta', path: vpB },
  ]);
  // 두 볼트가 같은 연결 'shared'를 쓴다.
  await configureRemote(paths, { name: 'alpha', path: vpA },
    { remote: 'notion', connection: 'shared', 'remote-token': 'secret_s', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });
  await configureRemote(paths, { name: 'beta', path: vpB },
    { remote: 'notion', connection: 'shared', 'publish-db': 'db2' },
    { getProvider: () => stubProvider([]) });

  // alpha만 지워도 beta가 아직 쓰므로 --purge-token이어도 토큰은 남는다.
  await publishRemove(paths, ['alpha', '--purge-token']);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'shared'), 'secret_s');

  // beta까지 지우면 고아가 되어 삭제된다.
  await publishRemove(paths, ['beta', '--purge-token']);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'shared'), undefined);
});

test('publish remove rejects conflicting --purge-token and --keep-token', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-prconf-'));
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  await configureRemote(paths, { name: 'personal', path: vaultPath },
    { remote: 'notion', connection: 'personal', 'remote-token': 'secret_x', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });
  await assert.rejects(
    () => publishRemove(paths, ['personal', '--purge-token', '--keep-token']),
    /함께 쓸 수 없습니다/,
  );
});

test('config export bundle carries no stored tokens', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-crexp-'));
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  await configureRemote(paths, { name: 'personal', path: vaultPath },
    { remote: 'notion', 'remote-token': 'secret_x', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });
  const bundle = buildExportBundle(paths);
  assert.doesNotMatch(JSON.stringify(bundle), /secret_x/);
  assert.equal('tokens' in bundle, false);
  assert.equal('secrets' in bundle, false);
});

test('connection add validates then stores the token with its account', async () => {
  const paths = tmpPaths();
  const calls = [];
  const provider = {
    name: 'notion', tokenPrefix: 'NOTION',
    createClient: async (token) => { calls.push(`create:${token}`); return {}; },
    validateToken: async () => { calls.push('validate'); return { ok: true, account: 'ACME' }; },
  };
  const ok = await connectionAdd(paths, ['--remote', 'notion', '--name', 'work-team', '--remote-token', 'secret_w'],
    { getProvider: () => provider });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['create:secret_w', 'validate']);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'work-team'), 'secret_w');
  assert.equal(listConnections(paths.secrets, 'notion')[0].account, 'ACME');
});

test('connection add (non-TTY) requires --name and --remote-token', async () => {
  const paths = tmpPaths();
  const provider = { name: 'notion', tokenPrefix: 'NOTION', createClient: async () => ({}), validateToken: async () => ({ ok: true }) };
  await assert.rejects(
    () => connectionAdd(paths, ['--remote', 'notion', '--remote-token', 't'], { getProvider: () => provider }),
    /--name이 필요/,
  );
  await assert.rejects(
    () => connectionAdd(paths, ['--remote', 'notion', '--name', 'x'], { getProvider: () => provider }),
    /--remote-token이 필요/,
  );
});

test('connection add does not store the token when validation fails', async () => {
  const paths = tmpPaths();
  const provider = {
    name: 'notion', tokenPrefix: 'NOTION',
    createClient: async () => ({}),
    validateToken: async () => { throw new Error('Notion 토큰 검증 실패 — unauthorized'); },
  };
  await assert.rejects(
    () => connectionAdd(paths, ['--remote', 'notion', '--name', 'bad', '--remote-token', 'nope'], { getProvider: () => provider }),
    /토큰 검증 실패/,
  );
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'bad'), undefined);
});

test('connection remove (non-TTY) needs --force and then deletes the token', async () => {
  const paths = tmpPaths();
  const provider = { name: 'notion', tokenPrefix: 'NOTION' };
  addConnection(paths.secrets, 'notion', 'work', { token: 'secret_w' });
  // --force 없이는 거부한다.
  await assert.rejects(
    () => connectionRemove(paths, ['work', '--remote', 'notion'], { getProvider: () => provider }),
    /--force/,
  );
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'work'), 'secret_w');
  // --force면 삭제한다.
  const removed = await connectionRemove(paths, ['work', '--remote', 'notion', '--force'], { getProvider: () => provider });
  assert.equal(removed, true);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'work'), undefined);
});

test('connection remove warns (non-TTY) when a vault still references it but still removes with --force', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-connuse-'));
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  await configureRemote(paths, { name: 'personal', path: vaultPath },
    { remote: 'notion', connection: 'shared', 'remote-token': 'secret_s', 'publish-db': 'db1' },
    { getProvider: () => stubProvider([]) });
  const provider = { name: 'notion', tokenPrefix: 'NOTION' };
  const removed = await connectionRemove(paths, ['shared', '--remote', 'notion', '--force'], { getProvider: () => provider });
  assert.equal(removed, true);
  assert.equal(getConnectionToken(paths.secrets, 'notion', 'shared'), undefined);
  // 설정 엔트리는 그대로 남는다(연결만 사라진다).
  assert.equal(loadRemoteConfig(paths.publish, 'personal').connection, 'shared');
});

test('reset wipes config but preserves registered vault files by default', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-resetvault-'));
  const vaultFile = path.join(vaultPath, 'index.md');
  fs.writeFileSync(vaultFile, '# keep me');
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);
  addConnection(paths.secrets, 'notion', 'work', { token: 'secret_w' });
  createSkill(paths.skillsDir, { name: 'weekly-retro', description: '주간 회고.' });
  fs.mkdirSync(paths.workspace, { recursive: true });
  fs.writeFileSync(path.join(paths.workspace, 'CLAUDE.md'), 'x');

  const result = await resetConfig(paths, ['--force']);
  assert.equal(result, true);
  // config 상태는 모두 사라진다.
  assert.equal(fs.existsSync(paths.registry), false);
  assert.equal(fs.existsSync(paths.secrets), false);
  assert.equal(fs.existsSync(paths.skillsDir), false);
  assert.equal(fs.existsSync(paths.workspace), false);
  // addConnection이 만든 secrets.json 무시 규칙만 있던 .gitignore는 함께 정리된다.
  assert.equal(fs.existsSync(path.join(paths.configDir, '.gitignore')), false);
  // 볼트 실제 파일은 보존된다.
  assert.equal(fs.existsSync(vaultFile), true);
});

test('reset prunes only the secrets.json rule and keeps user-authored .gitignore rules', async () => {
  const paths = tmpPaths();
  // 토큰 저장이 secrets.json 무시 규칙을 넣는다. 사용자가 별도 규칙도 넣어뒀다고 가정한다.
  addConnection(paths.secrets, 'notion', 'work', { token: 'secret_w' });
  const gitignore = path.join(paths.configDir, '.gitignore');
  fs.appendFileSync(gitignore, 'my-notes.txt\n');

  await resetConfig(paths, ['--force']);
  // 파일은 남되 secrets.json 규칙만 사라지고 사용자 규칙은 보존된다.
  assert.equal(fs.existsSync(gitignore), true);
  const rules = fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(rules, ['my-notes.txt']);
});

test('reset --purge-vaults also deletes the registered vault directory', async () => {
  const paths = tmpPaths();
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-resetpurge-'));
  fs.writeFileSync(path.join(vaultPath, 'index.md'), '# gone');
  writeRegistry(paths.registry, [{ name: 'personal', path: vaultPath }]);

  await resetConfig(paths, ['--purge-vaults', '--force']);
  assert.equal(fs.existsSync(vaultPath), false);
  assert.equal(fs.existsSync(paths.registry), false);
});

test('reset refuses without --force in non-interactive mode', async () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal' }]);
  await assert.rejects(() => resetConfig(paths, []), /--force/);
  // 거부됐으므로 레지스트리는 그대로 있어야 한다.
  assert.equal(fs.existsSync(paths.registry), true);
});

test('reset is idempotent on an empty config', async () => {
  const paths = tmpPaths();
  const result = await resetConfig(paths, ['--force']);
  assert.equal(result, true);
});
