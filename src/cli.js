import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stdin } from 'node:process';
import * as p from '@clack/prompts';
import { getPaths } from './paths.js';
import { normalizeVault, readRegistry, readRegistryFile, writeRegistry } from './registry.js';

const VAULT_OPTION_KEYS = ['name', 'path', 'kind', 'signals', 'notes'];
const VAULT_ADD_USAGE = 'llmwiki vault add --name <name> --path <path> [--kind open|secure] [--signals <신호>] [--notes <메모>]';
const IS_WINDOWS = process.platform === 'win32';

const HELP = `llmwiki — 여러 LLM Markdown 위키를 한 곳에서 운영합니다.

사용법:
  llmwiki                         설정된 에이전트로 시작
  llmwiki start [claude|codex] [-- <agent args>]
  llmwiki claude [agent args]     Claude Code로 바로 시작
  llmwiki codex [agent args]      Codex로 바로 시작
  llmwiki setup                   초기 설정 및 볼트 등록
  llmwiki vault add [options]     볼트 추가/수정
  llmwiki vault list [--json]     등록된 볼트 목록
  llmwiki vault show <name>       볼트 상세 정보 및 상태
  llmwiki vault remove <name>     볼트 제거
  llmwiki doctor                  설정·볼트·에이전트 상태 진단
  llmwiki config path             설정 파일 경로 출력
  llmwiki config edit             $EDITOR로 설정 편집

vault add 옵션:
  --name <name> --path <path> [--kind open|secure]
  [--signals <쉼표 구분 신호>] [--notes <메모>]

볼트 종류:
  open    일반 자료용. 별도의 보안 확인 없이 읽고 쓸 수 있음
  secure  업무·고객·개인정보 등 민감 자료용. 쓰기 전 확인 및 익명화 적용

추가 정보:
  signals 요청을 이 볼트로 자동 연결할 주제·키워드 (예: 커리어, 이력서, 논문)
  notes   에이전트가 알아야 할 볼트의 용도·특이사항 (예: 커리어 자료 보유)

환경 변수:
  LLM_WIKI_AGENT       기본 에이전트 (claude 또는 codex)
  LLM_WIKI_CONFIG_HOME 설정 디렉터리 재정의
  LLM_WIKI_DATA_HOME   런타임 데이터 디렉터리 재정의`;

export function parseOptions(args, { allowed, booleans = [], usage } = {}) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      // 값에 '='가 포함될 수 있으므로 첫 '='만 구분자로 삼는다 (split(limit)은 뒤를 버린다).
      const body = arg.slice(2);
      const separator = body.indexOf('=');
      const key = separator === -1 ? body : body.slice(0, separator);
      const inline = separator === -1 ? undefined : body.slice(separator + 1);
      if (!key) throw new Error(`옵션 이름이 비었습니다: ${arg}`);
      if (allowed && !allowed.includes(key)) {
        throw new Error(`알 수 없는 옵션: --${key}\n사용 가능한 옵션: ${allowed.map((item) => `--${item}`).join(', ')}${usage ? `\n사용법: ${usage}` : ''}`);
      }
      if (booleans.includes(key)) {
        options[key] = inline === undefined ? true : inline !== 'false';
        continue;
      }
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`--${key} 옵션 값이 필요합니다.`);
      options[key] = value;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

// Windows의 claude.cmd / codex.cmd 같은 셰임(shim)은 shell 없이 실행할 수 없다.
function toShellCommand(command, args) {
  const quote = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [command, ...args].map(quote).join(' ');
}

function runSync(command, args, options = {}) {
  if (IS_WINDOWS) return spawnSync(toShellCommand(command, args), { ...options, shell: true });
  return spawnSync(command, args, options);
}

function runAsync(command, args, options = {}) {
  if (IS_WINDOWS) return spawn(toShellCommand(command, args), { ...options, shell: true });
  return spawn(command, args, options);
}

function reportIssues(file, issues) {
  if (!issues.length) return;
  const lines = issues.map((issue) => `${issue.line}행: ${issue.message}`);
  const message = `레지스트리에서 읽지 못한 행 ${issues.length}개 (${file})\n${lines.join('\n')}`;
  if (stdin.isTTY) p.log.warn(message);
  else console.error(`[WARN] ${message}`);
}

function cancelPrompt(value) {
  if (!p.isCancel(value)) return false;
  p.cancel('설정을 취소했습니다. 변경 사항은 저장되지 않았습니다.');
  return true;
}

function inspectVault(vaultPath) {
  return {
    exists: fs.existsSync(vaultPath),
    claude: fs.existsSync(path.join(vaultPath, 'CLAUDE.md')),
    agents: fs.existsSync(path.join(vaultPath, 'AGENTS.md')),
    index: fs.existsSync(path.join(vaultPath, 'index.md')),
  };
}

async function askVault(initial = {}, { edit = false } = {}) {
  if (!stdin.isTTY) {
    try {
      return normalizeVault(initial);
    } catch (error) {
      throw new Error(`${error.message}\n바로 등록하려면 --name과 --path가 필요합니다.\n사용법: ${VAULT_ADD_USAGE}`);
    }
  }

  const name = initial.name ?? await p.text({
    message: '볼트 이름',
    placeholder: 'personal',
    validate(value) {
      if (!value.trim()) return '볼트 이름은 필수입니다.';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value.trim())) return '영문자/숫자로 시작하고 _, -만 사용할 수 있습니다.';
    },
  });
  if (cancelPrompt(name)) return null;

  const vaultPath = !edit && initial.path !== undefined ? initial.path : await p.text({
    message: '볼트 경로',
    placeholder: '~/wikis/personal',
    initialValue: edit ? initial.path : undefined,
    validate(value) { if (!value.trim()) return '볼트 경로는 필수입니다.'; },
  });
  if (cancelPrompt(vaultPath)) return null;

  const normalizedPath = normalizeVault({ name, path: vaultPath, kind: initial.kind || 'open' }).path;
  const status = inspectVault(normalizedPath);
  if (status.exists) {
    p.log.success(`경로 확인 · CLAUDE.md ${status.claude ? '✓' : '–'} · AGENTS.md ${status.agents ? '✓' : '–'} · index.md ${status.index ? '✓' : '–'}`);
  } else {
    p.log.warn('아직 존재하지 않는 경로입니다. 등록은 가능하지만 사용 전에 생성해야 합니다.');
  }

  const kind = !edit && initial.kind !== undefined ? initial.kind : await p.select({
    message: '볼트 종류',
    initialValue: initial.kind || 'open',
    options: [
      { value: 'open', label: 'Open', hint: '일반 자료 · 별도 보안 확인 없이 읽기/쓰기' },
      { value: 'secure', label: 'Secure', hint: '민감 자료 · 쓰기 전 확인 및 익명화' },
    ],
  });
  if (cancelPrompt(kind)) return null;

  const signals = !edit && initial.signals !== undefined ? initial.signals : await p.text({
    message: '라우팅 신호',
    placeholder: '커리어, 이력서, LinkedIn',
    initialValue: edit ? initial.signals : undefined,
    defaultValue: '',
  });
  if (cancelPrompt(signals)) return null;

  const notes = !edit && initial.notes !== undefined ? initial.notes : await p.text({
    message: '메모',
    placeholder: '볼트의 용도나 에이전트가 알아야 할 특이사항',
    initialValue: edit ? initial.notes : undefined,
    defaultValue: '',
  });
  if (cancelPrompt(notes)) return null;

  const vault = normalizeVault({ name, path: vaultPath, kind, signals, notes });
  p.note([
    `이름    ${vault.name}`,
    `경로    ${vault.path}`,
    `종류    ${vault.kind}`,
    `신호    ${vault.signals || '없음'}`,
    `메모    ${vault.notes || '없음'}`,
  ].join('\n'), '등록 내용');

  const confirmed = await p.confirm({ message: '이 내용으로 저장할까요?', initialValue: true });
  if (cancelPrompt(confirmed) || !confirmed) {
    if (confirmed === false) p.cancel('저장하지 않았습니다.');
    return null;
  }
  return vault;
}

function ensureRegistry(paths) {
  if (!fs.existsSync(paths.registry)) writeRegistry(paths.registry, []);
}

async function addVault(paths, args, { outro = true, initial = {}, edit = false } = {}) {
  ensureRegistry(paths);
  const { options, rest } = parseOptions(args, { allowed: VAULT_OPTION_KEYS, usage: VAULT_ADD_USAGE });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${VAULT_ADD_USAGE}`);
  const vault = await askVault({ ...initial, ...options }, { edit });
  if (!vault) return false;
  const vaults = readRegistry(paths.registry);
  const existing = vaults.findIndex((item) => item.name === vault.name);
  if (existing >= 0) vaults[existing] = vault;
  else vaults.push(vault);
  writeRegistry(paths.registry, vaults);

  const message = `${existing >= 0 ? '볼트 수정 완료' : '볼트 추가 완료'} · ${vault.name} → ${vault.path}`;
  if (stdin.isTTY) {
    if (outro) p.outro(message);
    else p.log.success(message);
  } else console.log(message);
  return true;
}

async function setup(paths, args) {
  const existed = fs.existsSync(paths.registry);
  ensureRegistry(paths);

  if (args.length || !stdin.isTTY) {
    console.log(`${existed ? '기존 설정 사용' : '설정 파일 생성'}: ${paths.registry}`);
    if (args.length) await addVault(paths, args);
    return;
  }

  p.intro('llmwiki setup');
  p.log.info(`${existed ? '설정 파일' : '새 설정 파일'} · ${paths.registry}`);

  while (true) {
    const vaults = readRegistry(paths.registry);
    const action = await p.select({
      message: vaults.length ? `무엇을 할까요? (등록된 볼트 ${vaults.length}개)` : '첫 번째 볼트를 등록해 주세요.',
      options: vaults.length ? [
        { value: 'add', label: '볼트 추가' },
        { value: 'edit', label: '기존 볼트 수정' },
        { value: 'remove', label: '볼트 삭제' },
        { value: 'done', label: '설정 완료' },
      ] : [
        { value: 'add', label: '볼트 추가' },
        { value: 'done', label: '나중에 하기' },
      ],
    });
    if (cancelPrompt(action)) return;
    if (action === 'done') {
      p.outro(vaults.length ? '`llmwiki`를 실행해 시작하세요.' : '`llmwiki vault add`로 언제든 등록할 수 있습니다.');
      return;
    }
    if (action === 'add') await addVault(paths, [], { outro: false });
    if (action === 'edit') {
      const selected = await chooseVault(vaults, '수정할 볼트를 선택하세요.');
      if (selected) await addVault(paths, [], { outro: false, initial: selected, edit: true });
    }
    if (action === 'remove') {
      const selected = await chooseVault(vaults, '삭제할 볼트를 선택하세요.');
      if (selected) await removeVault(paths, selected.name, { confirm: true });
    }
  }
}

function listVaults(paths, args = []) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: 'llmwiki vault list [--json]' });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: llmwiki vault list [--json]`);
  const { vaults, issues } = readRegistryFile(paths.registry);

  if (options.json) {
    console.log(JSON.stringify({ registry: paths.registry, vaults, issues }, null, 2));
    return;
  }
  reportIssues(paths.registry, issues);
  if (!vaults.length) {
    console.log('등록된 볼트가 없습니다. `llmwiki vault add`로 추가하세요.');
    return;
  }
  if (stdin.isTTY) {
    p.intro(`llmwiki · 볼트 ${vaults.length}개`);
    for (const vault of vaults) {
      const status = inspectVault(vault.path);
      p.note([
        `${vault.kind} · ${status.exists ? '경로 정상' : '경로 없음'}`,
        vault.path,
        `신호: ${vault.signals || '없음'}`,
      ].join('\n'), vault.name);
    }
    p.outro('상세 정보: llmwiki vault show <name>');
  } else {
    console.table(vaults.map(({ name, path: vaultPath, kind, signals }) => ({ name, kind, path: vaultPath, signals })));
  }
}

async function chooseVault(vaults, message) {
  const name = await p.select({
    message,
    options: vaults.map((vault) => ({ value: vault.name, label: vault.name, hint: vault.kind })),
  });
  if (cancelPrompt(name)) return null;
  return vaults.find((vault) => vault.name === name);
}

function showVault(paths, name) {
  if (!name) throw new Error('확인할 볼트 이름이 필요합니다.\n사용법: llmwiki vault show <name>');
  const { vaults, issues } = readRegistryFile(paths.registry);
  reportIssues(paths.registry, issues);
  const vault = vaults.find((item) => item.name === name);
  if (!vault) throw new Error(`등록되지 않은 볼트입니다: ${name}`);
  const status = inspectVault(vault.path);
  const details = [
    `이름       ${vault.name}`,
    `종류       ${vault.kind}`,
    `경로       ${vault.path}`,
    `라우팅 신호 ${vault.signals || '없음'}`,
    `메모       ${vault.notes || '없음'}`,
    `경로 상태   ${status.exists ? '정상' : '찾을 수 없음'}`,
    `CLAUDE.md  ${status.claude ? '있음' : '없음'}`,
    `AGENTS.md  ${status.agents ? '있음' : '없음'}`,
    `index.md   ${status.index ? '있음' : '없음'}`,
  ].join('\n');
  if (stdin.isTTY) p.note(details, '볼트 상세');
  else console.log(details);
}

async function removeVault(paths, name, { confirm = false } = {}) {
  if (!name) throw new Error('제거할 볼트 이름이 필요합니다.\n사용법: llmwiki vault remove <name>');
  const vaults = readRegistry(paths.registry);
  const target = vaults.find((vault) => vault.name === name);
  if (!target) throw new Error(`등록되지 않은 볼트입니다: ${name}`);

  if (stdin.isTTY && confirm) {
    const accepted = await p.confirm({ message: `${name} 볼트를 레지스트리에서 삭제할까요?`, initialValue: false });
    if (cancelPrompt(accepted) || !accepted) return false;
  }
  writeRegistry(paths.registry, vaults.filter((vault) => vault.name !== name));
  if (stdin.isTTY) p.log.success(`삭제됨 · ${name} (실제 볼트 파일은 삭제하지 않았습니다.)`);
  else console.log(`제거됨: ${name}`);
  return true;
}

const WORKSPACE_DOCS = ['AGENTS.md', 'CLAUDE.md', 'WIKI-CLI.md', 'wikis.example.md'];
const WORKSPACE_CLAUDE_DIRS = ['commands', 'skills'];
const WORKSPACE_NOTICE = `# 이 디렉터리는 llmwiki가 관리합니다

라우팅 지침과 볼트 레지스트리를 한곳에 모아 에이전트를 실행하기 위한 작업 공간입니다.

- 매 실행마다 덮어씀: ${WORKSPACE_DOCS.join(', ')}, wikis.local.md,
  ${WORKSPACE_CLAUDE_DIRS.map((dir) => `.claude/${dir}/`).join(', ')}
- 그대로 유지됨: 위 목록 이외의 파일 (예: .claude/settings.local.json)

지침을 바꾸려면 이 디렉터리가 아니라 설치된 패키지를 수정하세요.
볼트 등록 정보는 \`llmwiki config path\`가 알려주는 설정 파일에서 관리합니다.
`;

function syncDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

export function prepareWorkspace(paths) {
  if (!fs.existsSync(paths.registry)) {
    throw new Error('설정이 없습니다. 먼저 `llmwiki setup`을 실행하세요.');
  }
  fs.mkdirSync(path.join(paths.workspace, '.claude'), { recursive: true });
  for (const doc of WORKSPACE_DOCS) {
    fs.copyFileSync(path.join(paths.packageRoot, doc), path.join(paths.workspace, doc));
  }
  // .claude 전체를 지우면 settings.local.json(사용자 승인 상태)이 매번 사라진다.
  for (const dir of WORKSPACE_CLAUDE_DIRS) {
    syncDirectory(path.join(paths.packageRoot, '.claude', dir), path.join(paths.workspace, '.claude', dir));
  }

  const workspaceRegistry = path.join(paths.workspace, 'wikis.local.md');
  fs.copyFileSync(paths.registry, workspaceRegistry);
  try { fs.chmodSync(workspaceRegistry, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  fs.writeFileSync(path.join(paths.workspace, 'WORKSPACE.md'), WORKSPACE_NOTICE);
  return paths.workspace;
}

function commandExists(command) {
  const result = runSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error) return false;
  // shell 사용 시는 실행 파일이 없어도 error 대신 0이 아닌 상태 코드가 난다.
  if (IS_WINDOWS) return result.status === 0;
  return true;
}

function resolveAgent(requested) {
  if (requested) {
    if (!['claude', 'codex'].includes(requested)) throw new Error(`지원하지 않는 에이전트입니다: ${requested}`);
    return requested;
  }
  const configured = process.env.LLM_WIKI_AGENT;
  if (configured) return resolveAgent(configured);
  if (commandExists('claude')) return 'claude';
  if (commandExists('codex')) return 'codex';
  throw new Error('Claude Code 또는 Codex를 찾을 수 없습니다. 설치 후 다시 실행하세요.');
}

function doctor(paths) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  if (!fs.existsSync(paths.registry)) {
    add('error', '설정 파일', `없음 · llmwiki setup 실행 필요 (${paths.registry})`);
  } else {
    add('success', '설정 파일', paths.registry);
    // 진단 명령은 파싱 불가능한 행이 있어도 죽지 않고 위치를 알려준다.
    const { vaults, issues } = readRegistryFile(paths.registry);
    for (const issue of issues) add('error', `레지스트리 ${issue.line}행`, `${issue.message} · ${issue.raw}`);
    if (!vaults.length && !issues.length) add('warn', '볼트', '등록된 볼트 없음');
    for (const vault of vaults) {
      const status = inspectVault(vault.path);
      if (!status.exists) add('error', vault.name, `경로 없음 · ${vault.path}`);
      else if (!status.claude) add('warn', vault.name, '경로 정상 · CLAUDE.md 없음');
      else add('success', vault.name, `정상 · ${vault.kind} · index.md ${status.index ? '있음' : '없음'}`);
    }
  }

  const claude = commandExists('claude');
  const codex = commandExists('codex');
  if (claude) add('success', 'Claude Code', '설치됨');
  else add('warn', 'Claude Code', '찾을 수 없음');
  if (codex) add('success', 'Codex', '설치됨');
  else add('warn', 'Codex', '찾을 수 없음');
  if (!claude && !codex) add('error', '에이전트', 'Claude Code 또는 Codex 설치 필요');

  if (stdin.isTTY) {
    p.intro('llmwiki doctor');
    for (const result of results) p.log[result.level](`${result.label} · ${result.detail}`);
    const errors = results.filter((result) => result.level === 'error').length;
    p.outro(errors ? `문제 ${errors}개를 확인해 주세요.` : '실행 준비가 완료되었습니다.');
  } else {
    for (const result of results) console.log(`[${result.level.toUpperCase()}] ${result.label}: ${result.detail}`);
  }
  if (results.some((result) => result.level === 'error')) process.exitCode = 1;
}

async function start(paths, requestedAgent, agentArgs = []) {
  const workspace = prepareWorkspace(paths);
  const agent = resolveAgent(requestedAgent);
  const vaultArgs = readRegistry(paths.registry)
    .filter((vault) => fs.existsSync(vault.path))
    .flatMap((vault) => ['--add-dir', vault.path]);
  console.log(`${agent} 시작 (workspace: ${workspace})`);
  const child = runAsync(agent, [...vaultArgs, ...agentArgs], {
    cwd: workspace,
    stdio: 'inherit',
    env: process.env,
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 0)));
  });
  process.exitCode = code;
}

// EDITOR는 `code -w`처럼 인자를 포함할 수 있으므로 토큰으로 나눠 사용한다.
function splitCommand(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

function editConfig(paths) {
  ensureRegistry(paths);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new Error('$EDITOR 또는 $VISUAL 환경 변수를 설정하세요.');
  const [command, ...editorArgs] = splitCommand(editor);
  if (!command) throw new Error(`$EDITOR 값을 해석할 수 없습니다: ${editor}`);
  // 셸 문자열을 조립하지 않고 인자로 전달해 경로 속 $()·백틱 해석을 막는다.
  const result = runSync(command, [...editorArgs, paths.registry], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`편집기가 상태 코드 ${result.status}로 종료되었습니다.`);
}

export async function main(args) {
  const paths = getPaths();
  const [command = 'start', ...rest] = args;

  if (['help', '--help', '-h'].includes(command)) return console.log(HELP);
  if (['--version', '-v', 'version'].includes(command)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
    return console.log(pkg.version);
  }
  if (command === 'setup' || command === 'init') return setup(paths, rest);
  if (command === 'doctor') return doctor(paths);
  if (command === 'claude' || command === 'codex') return start(paths, command, rest);
  if (command === 'start') {
    const agent = ['claude', 'codex'].includes(rest[0]) ? rest.shift() : undefined;
    if (rest[0] === '--') rest.shift();
    return start(paths, agent, rest);
  }
  if (command === 'vault') {
    const [action, ...vaultArgs] = rest;
    if (action === 'add') {
      if (stdin.isTTY) p.intro('llmwiki · 볼트 추가');
      return addVault(paths, vaultArgs);
    }
    if (action === 'list') return listVaults(paths, vaultArgs);
    if (action === 'show') return showVault(paths, vaultArgs[0]);
    if (action === 'remove') return removeVault(paths, vaultArgs[0], { confirm: true });
    throw new Error('사용법: llmwiki vault <add|list|show|remove>');
  }
  if (command === 'config') {
    const [action] = rest;
    if (action === 'path') return console.log(paths.registry);
    if (action === 'edit') return editConfig(paths);
    throw new Error('사용법: llmwiki config <path|edit>');
  }
  throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
}
