import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stdin } from 'node:process';
import * as p from '@clack/prompts';
import { getPaths } from './paths.js';
import { lintVault } from './lint.js';
import {
  SUPPORTED_AGENTS,
  normalizeAgentCommand,
  normalizeVault,
  readAgents,
  readRegistry,
  readRegistryFile,
  writeRegistry,
} from './registry.js';
import {
  SKILL_FILE,
  createSkill,
  listSkills,
  listTemplates,
  readSkill,
  removeSkill as removeSkillDir,
  renderCommandStub,
  renderSkillsCatalog,
  skillDir,
  validateSkillName,
} from './skills.js';

const VAULT_OPTION_KEYS = ['name', 'path', 'kind', 'signals', 'notes'];
const VAULT_ADD_USAGE = 'llmwiki vault add --name <name> --path <path> [--kind open|secure] [--signals <신호>] [--notes <메모>]';
const SKILL_ADD_USAGE = 'llmwiki skill add <name> [--description <설명>] [--from <경로>] [--template <name>] [--force] [--no-edit]';
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
  llmwiki vault lint [name] [--json]  볼트가 위키 스키마를 지키는지 검사
  llmwiki vault scaffold [name]   누락된 스키마 구조를 생성 (기존 파일 보존)
  llmwiki agent list [--json]     에이전트 실행 명령 매핑 확인
  llmwiki agent set <name> [--add-dir] <cmd> [-- <명령 인자>]  claude/codex를 다른 명령으로 실행
  llmwiki agent reset <name>      실행 명령을 기본값(claude/codex)으로 복원
  llmwiki skill list [--json]     등록된 커스텀 스킬 목록
  llmwiki skill add <name>        커스텀 스킬 생성/가져오기
  llmwiki skill show <name>       스킬 상세 정보
  llmwiki skill edit <name>       $EDITOR로 SKILL.md 편집
  llmwiki skill remove <name>     스킬 삭제
  llmwiki skill templates         내장 스킬 템플릿 목록
  llmwiki skill path [name]       스킬 디렉터리 경로 출력
  llmwiki doctor                  설정·볼트·스킬·에이전트 상태 진단
  llmwiki config path             설정 파일 경로 출력
  llmwiki config edit             $EDITOR로 설정 편집

vault add 옵션:
  --name <name> --path <path> [--kind open|secure]
  [--signals <쉼표 구분 신호>] [--notes <메모>]

skill add 옵션:
  --description <설명>   에이전트가 언제 이 스킬을 쓸지 판단할 기준
  --from <경로>          기존 SKILL.md 파일이나 스킬 디렉터리를 가져옴
  --template <name>      내장 템플릿에서 생성 (llmwiki skill templates)
  --force                같은 이름의 스킬을 덮어씀
  --no-edit              생성 후 편집기를 열지 않음

볼트 종류:
  open    일반 자료용. 별도의 보안 확인 없이 읽고 쓸 수 있음
  secure  업무·고객·개인정보 등 민감 자료용. 쓰기 전 확인 및 익명화 적용

추가 정보:
  signals 요청을 이 볼트로 자동 연결할 주제·키워드 (예: 커리어, 이력서, 논문)
  notes   에이전트가 알아야 할 볼트의 용도·특이사항 (예: 커리어 자료 보유)

에이전트 실행 명령:
  claude/codex는 논리 이름이며, 실제 실행 명령을 재정의할 수 있습니다.
  예) claude가 vibe를, codex가 isaac을 실행하도록:
    llmwiki agent set claude vibe agent
    llmwiki agent set codex dbexec repo run isaac
  기본적으로 커스텀 명령에는 볼트 --add-dir 인자를 붙이지 않습니다(vibe 등은 이 플래그를
  받지 않음). claude/codex 원본처럼 --add-dir를 붙이려면 --add-dir 플래그를 추가하세요.
  실행 명령 자체가 --add-dir 같은 대시 옵션을 받아야 하면 -- 뒤에 두세요:
    llmwiki agent set codex mycli -- --add-dir .   (-- 뒤는 그대로 명령 인자로 보존)
  --add-dir를 안 붙이는 경우에도 등록된 볼트는 워크스페이스의 vaults/ 심볼릭 링크로 노출됩니다.
  매핑은 설정 파일(llmwiki config path)에 저장됩니다.

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
    const skillCount = listSkills(paths.skillsDir).length;
    const action = await p.select({
      message: vaults.length
        ? `무엇을 할까요? (볼트 ${vaults.length}개 · 커스텀 스킬 ${skillCount}개)`
        : '첫 번째 볼트를 등록해 주세요.',
      options: vaults.length ? [
        { value: 'add', label: '볼트 추가' },
        { value: 'edit', label: '기존 볼트 수정' },
        { value: 'remove', label: '볼트 삭제' },
        { value: 'skill', label: '커스텀 스킬 추가', hint: 'LinkedIn 초안 같은 사용자 정의 작업' },
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
    if (action === 'skill') await addSkill(paths, [], { outro: false });
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

// lint/scaffold 대상 볼트를 해소한다. 이름이 있으면 그 볼트, 없으면 등록된 전 볼트.
function resolveTargets(paths, name) {
  const { vaults, issues } = readRegistryFile(paths.registry);
  reportIssues(paths.registry, issues);
  if (!name) return vaults;
  const vault = vaults.find((item) => item.name === name);
  if (!vault) throw new Error(`등록되지 않은 볼트입니다: ${name}`);
  return [vault];
}

function lintVaults(paths, args = []) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: 'llmwiki vault lint [name] [--json]' });
  const targets = resolveTargets(paths, rest[0]);
  if (!targets.length) {
    console.log('등록된 볼트가 없습니다. `llmwiki vault add`로 추가하세요.');
    return;
  }

  const report = targets.map((vault) => ({ vault: vault.name, path: vault.path, kind: vault.kind, results: lintVault(vault.path) }));

  if (options.json) {
    console.log(JSON.stringify({ registry: paths.registry, vaults: report }, null, 2));
    if (report.some((entry) => entry.results.some((result) => result.level === 'error'))) process.exitCode = 1;
    return;
  }

  let errors = 0;
  for (const entry of report) {
    const entryErrors = entry.results.filter((result) => result.level === 'error').length;
    errors += entryErrors;
    if (stdin.isTTY) {
      p.intro(`llmwiki vault lint · ${entry.vault} (${entry.kind})`);
      for (const result of entry.results) p.log[result.level](`${result.label} · ${result.detail}`);
      p.outro(entryErrors ? `${entry.vault}: 위반 ${entryErrors}개` : `${entry.vault}: 스키마 위반 없음`);
    } else {
      for (const result of entry.results) console.log(`[${result.level.toUpperCase()}] ${entry.vault} · ${result.label}: ${result.detail}`);
    }
  }
  if (errors) process.exitCode = 1;
}

// templates/vault의 스켈레톤을 볼트에 가산적으로 복사한다. 기존 파일은 절대 덮어쓰지 않는다.
// created에는 볼트 루트 기준 상대 경로를 쌓아 재귀 깊이와 무관하게 표시가 정확하도록 한다.
function scaffoldTree(sourceDir, destDir, root, created) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      scaffoldTree(source, dest, root, created);
    } else if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      created.push(path.relative(root, dest));
    }
  }
}

function scaffoldVaults(paths, args = []) {
  const { rest } = parseOptions(args, { allowed: [], usage: 'llmwiki vault scaffold [name]' });
  const targets = resolveTargets(paths, rest[0]);
  if (!targets.length) {
    console.log('등록된 볼트가 없습니다. `llmwiki vault add`로 추가하세요.');
    return;
  }
  if (!fs.existsSync(paths.vaultTemplateDir)) {
    throw new Error(`볼트 템플릿을 찾을 수 없습니다: ${paths.vaultTemplateDir}`);
  }

  for (const vault of targets) {
    fs.mkdirSync(vault.path, { recursive: true });
    const created = [];
    scaffoldTree(paths.vaultTemplateDir, vault.path, vault.path, created);
    // .gitkeep은 목록에서 감춰 노이즈를 줄인다(디렉터리 생성은 이미 반영됨).
    const shown = created.filter((rel) => path.basename(rel) !== '.gitkeep');
    if (!created.length) {
      const message = `${vault.name}: 이미 스키마 구조를 갖추고 있습니다.`;
      if (stdin.isTTY) p.log.info(message); else console.log(message);
      continue;
    }
    const message = `${vault.name}: ${created.length}개 항목 생성${shown.length ? `\n${shown.map((rel) => `  + ${rel}`).join('\n')}` : ''}`;
    if (stdin.isTTY) p.log.success(message); else console.log(message);
  }
}

function listAgents(paths, args = []) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: 'llmwiki agent list [--json]' });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: llmwiki agent list [--json]`);
  const overrides = new Map(readAgents(paths.registry).map((agent) => [agent.name, agent]));
  const rows = SUPPORTED_AGENTS.map((name) => {
    const override = overrides.get(name);
    const command = override ? override.command : name;
    return {
      agent: name,
      command,
      default: !override,
      addDir: override ? override.addDir : true,
      installed: commandExists(splitCommand(command)[0] ?? name),
    };
  });

  if (options.json) {
    console.log(JSON.stringify({ registry: paths.registry, agents: rows }, null, 2));
    return;
  }
  const lines = rows.map((row) => `${row.agent} → ${row.command}${row.default ? ' (기본값)' : ''} · add-dir ${row.addDir ? 'yes' : 'no'} · ${row.installed ? '실행 가능' : '명령 없음'}`);
  if (stdin.isTTY) p.note(lines.join('\n'), 'llmwiki · 에이전트 실행 명령');
  else for (const line of lines) console.log(line);
}

// set 명령의 인자에서 --add-dir/--no-add-dir 플래그만 뽑아내고 나머지는 명령 토큰으로 둔다.
// `--` 뒤는 경계로 취급해 그대로 명령 토큰으로 보존한다. 실행 명령 자체가 --add-dir 같은
// 대시 옵션을 받아야 하는 경우 `llmwiki agent set codex mycli -- --add-dir` 처럼 넘긴다.
export function extractAddDirFlag(tokens) {
  const command = [];
  let addDir; // 미지정
  let literal = false;
  for (const token of tokens) {
    if (literal) { command.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    if (token === '--add-dir') addDir = true;
    else if (token === '--no-add-dir') addDir = false;
    else command.push(token);
  }
  return { command, addDir };
}

// 토큰 배열을 레지스트리에 저장할 단일 문자열로 직렬화한다. 공백이 든 토큰은
// 따옴표로 감싸 splitCommand가 원래 경계를 복원할 수 있게 한다(예: "profile name").
export function serializeCommand(tokens) {
  return tokens.map((token) => {
    if (token.includes('"')) throw new Error(`명령 토큰에 큰따옴표(")는 사용할 수 없습니다: ${token}`);
    return /\s/.test(token) ? `"${token}"` : token;
  }).join(' ');
}

function setAgent(paths, name, commandTokens) {
  if (!name) throw new Error('설정할 에이전트 이름이 필요합니다.\n사용법: llmwiki agent set <claude|codex> [--add-dir|--no-add-dir] <명령...>');
  const { command, addDir } = extractAddDirFlag(commandTokens);
  if (!command.length) throw new Error(`실행 명령이 필요합니다.\n사용법: llmwiki agent set ${name} <명령...>  (예: llmwiki agent set codex dbexec repo run isaac)`);
  // 커스텀 wrapper는 대개 --add-dir를 받지 않으므로 기본 off. 필요하면 --add-dir로 켠다.
  const agent = normalizeAgentCommand({ name, command: serializeCommand(command), addDir: addDir ?? false });
  ensureRegistry(paths);
  const agents = readAgents(paths.registry).filter((item) => item.name !== agent.name);
  agents.push(agent);
  writeRegistry(paths.registry, readRegistry(paths.registry), agents);
  const message = `에이전트 설정 완료 · ${agent.name} → ${agent.command} · add-dir ${agent.addDir ? 'yes' : 'no'}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
}

function resetAgent(paths, name) {
  if (!name) throw new Error('초기화할 에이전트 이름이 필요합니다.\n사용법: llmwiki agent reset <claude|codex>');
  if (!SUPPORTED_AGENTS.includes(name)) throw new Error(`agent는 ${SUPPORTED_AGENTS.join(' 또는 ')}여야 합니다.`);
  ensureRegistry(paths);
  const agents = readAgents(paths.registry);
  const next = agents.filter((item) => item.name !== name);
  if (next.length === agents.length) {
    const message = `이미 기본값입니다 · ${name} → ${name}`;
    if (stdin.isTTY) p.log.info(message);
    else console.log(message);
    return;
  }
  writeRegistry(paths.registry, readRegistry(paths.registry), next);
  const message = `기본값으로 초기화 · ${name} → ${name}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
}

function skillLine(skill) {
  return `${skill.name}${skill.description ? ` · ${skill.description}` : ''}`;
}

function listSkillsCommand(paths, args = []) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: 'llmwiki skill list [--json]' });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: llmwiki skill list [--json]`);
  const skills = listSkills(paths.skillsDir);

  if (options.json) {
    console.log(JSON.stringify({ skillsDir: paths.skillsDir, skills }, null, 2));
    return;
  }
  if (!skills.length) {
    console.log('등록된 커스텀 스킬이 없습니다. `llmwiki skill add <name>`으로 만들거나 `llmwiki skill templates`로 내장 템플릿을 확인하세요.');
    return;
  }
  if (stdin.isTTY) {
    p.intro(`llmwiki · 커스텀 스킬 ${skills.length}개`);
    for (const skill of skills) {
      p.note([
        skill.description || '설명 없음',
        skill.dir,
        ...skill.issues.map((issue) => `⚠ ${issue}`),
      ].join('\n'), skill.name);
    }
    p.outro('호출: Claude `/<name>` · Codex `<name>`');
  } else {
    for (const skill of skills) console.log(skillLine(skill));
  }
}

async function addSkill(paths, args, { outro = true } = {}) {
  const { options, rest } = parseOptions(args, {
    allowed: ['name', 'description', 'from', 'template', 'force', 'edit', 'no-edit'],
    booleans: ['force', 'edit', 'no-edit'],
    usage: SKILL_ADD_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${SKILL_ADD_USAGE}`);

  const templates = listTemplates(paths.templatesDir);
  let from = options.from;
  let templateName = options.template;
  if (templateName) {
    if (from) throw new Error('--from과 --template는 동시에 사용할 수 없습니다.');
    const template = templates.find((item) => item.name === templateName);
    if (!template) throw new Error(`없는 템플릿입니다: ${templateName}\n사용 가능한 템플릿: llmwiki skill templates`);
    from = template.dir;
  }

  if (!from && !rest.length && !options.name && stdin.isTTY && templates.length) {
    const choice = await p.select({
      message: '시작 방법',
      options: [
        { value: '', label: '빈 스킬로 시작', hint: '기본 구조만 갖는 SKILL.md 생성' },
        ...templates.map((template) => ({
          value: template.name,
          label: `템플릿 · ${template.name}`,
          hint: (template.description || '').slice(0, 60),
        })),
      ],
    });
    if (cancelPrompt(choice)) return false;
    if (choice) {
      templateName = choice;
      from = templates.find((template) => template.name === choice).dir;
    }
  }

  let name = rest[0] ?? options.name ?? templateName;
  if (!name && stdin.isTTY) {
    const answer = await p.text({
      message: '스킬 이름',
      placeholder: 'linkedin-draft',
      validate(value) {
        try { validateSkillName(value); } catch (error) { return error.message; }
      },
    });
    if (cancelPrompt(answer)) return false;
    name = answer;
  }
  if (!name) throw new Error(`스킬 이름이 필요합니다.\n사용법: ${SKILL_ADD_USAGE}`);
  name = validateSkillName(name);

  let description = options.description;
  if (description === undefined && !from && stdin.isTTY) {
    const answer = await p.text({
      message: '설명 (에이전트가 언제 이 스킬을 쓸지 판단하는 기준)',
      placeholder: '커리어 자료를 근거로 LinkedIn 프로필 초안을 생성한다. "링크드인 프로필", "헤드라인" 등에 사용한다.',
      defaultValue: '',
    });
    if (cancelPrompt(answer)) return false;
    description = answer;
  }

  const { dir, existed } = createSkill(paths.skillsDir, { name, description, from, force: options.force });
  const message = `${existed ? '스킬 덮어쓰기 완료' : '스킬 생성 완료'} · ${name} → ${path.join(dir, SKILL_FILE)}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);

  const skipEdit = Boolean(options['no-edit'] || options.edit === false || from);
  if (!skipEdit && stdin.isTTY) {
    const open = options.edit === true
      ? true
      : await p.confirm({ message: '지금 SKILL.md를 편집할까요?', initialValue: true });
    if (!cancelPrompt(open) && open) openInEditor(path.join(dir, SKILL_FILE));
  }
  const hint = `다음 실행부터 Claude /${name} · Codex ${name} 로 호출됩니다.`;
  if (!stdin.isTTY) console.log(hint);
  else if (outro) p.outro(hint);
  else p.log.info(hint);
  return true;
}

function showSkill(paths, name) {
  if (!name) throw new Error('확인할 스킬 이름이 필요합니다.\n사용법: llmwiki skill show <name>');
  const dir = skillDir(paths.skillsDir, name);
  if (!fs.existsSync(dir)) throw new Error(`등록되지 않은 스킬입니다: ${name}`);
  const skill = readSkill(dir);
  const details = [
    `이름   ${skill.name}`,
    `설명   ${skill.description || '없음'}`,
    `경로   ${skill.dir}`,
    `파일   ${fs.readdirSync(dir).sort().join(', ') || '없음'}`,
    `호출   Claude /${skill.name} · Codex ${skill.name}`,
    `상태   ${skill.issues.length ? skill.issues.join(' / ') : '정상'}`,
  ].join('\n');
  if (stdin.isTTY) p.note(details, '스킬 상세');
  else console.log(details);
}

function editSkill(paths, name) {
  if (!name) throw new Error('편집할 스킬 이름이 필요합니다.\n사용법: llmwiki skill edit <name>');
  const file = path.join(skillDir(paths.skillsDir, name), SKILL_FILE);
  if (!fs.existsSync(file)) throw new Error(`등록되지 않은 스킬입니다: ${name}`);
  openInEditor(file);
}

async function removeSkillCommand(paths, name) {
  if (!name) throw new Error('삭제할 스킬 이름이 필요합니다.\n사용법: llmwiki skill remove <name>');
  const dir = skillDir(paths.skillsDir, name);
  if (!fs.existsSync(dir)) throw new Error(`등록되지 않은 스킬입니다: ${name}`);
  if (stdin.isTTY) {
    const accepted = await p.confirm({ message: `${name} 스킬을 삭제할까요? (${dir})`, initialValue: false });
    if (cancelPrompt(accepted) || !accepted) return false;
  }
  removeSkillDir(paths.skillsDir, name);
  const message = `삭제됨 · ${name}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
  return true;
}

function listSkillTemplates(paths) {
  const templates = listTemplates(paths.templatesDir);
  if (!templates.length) return console.log('내장 템플릿이 없습니다.');
  for (const template of templates) console.log(skillLine(template));
  console.log('\n사용: llmwiki skill add <name> --template <template>');
}

const WORKSPACE_DOCS = ['AGENTS.md', 'CLAUDE.md', 'WIKI-CLI.md', 'wikis.example.md'];
const WORKSPACE_MANAGED = ['wikis.local.md', 'SKILLS.md', '.claude/commands/', '.claude/skills/', 'vaults/'];
const VAULTS_DIRNAME = 'vaults';
const WORKSPACE_NOTICE = `# 이 디렉터리는 llmwiki가 관리합니다

라우팅 지침과 볼트 레지스트리를 한곳에 모아 에이전트를 실행하기 위한 작업 공간입니다.

- 매 실행마다 덮어씀: ${WORKSPACE_DOCS.join(', ')},
  ${WORKSPACE_MANAGED.join(', ')}
- 그대로 유지됨: 위 목록 이외의 파일 (예: .claude/settings.local.json)

\`${VAULTS_DIRNAME}/\`는 등록된 볼트로 향하는 심볼릭 링크입니다. \`--add-dir\`를 받지
않는 에이전트(예: vibe)도 이 링크로 볼트에 접근할 수 있습니다. 실제 볼트 경로는
\`wikis.local.md\`에 있습니다.

지침을 바꾸려면 이 디렉터리가 아니라 설치된 패키지를 수정하세요.
볼트 등록 정보는 \`llmwiki config path\`가 알려주는 설정 파일에서 관리합니다.
커스텀 스킬은 \`llmwiki skill\` 명령으로 관리합니다 (원본은 설정 디렉터리의 skills/).
`;

/**
 * 등록된 볼트를 워크스페이스의 vaults/<name>으로 심볼릭 링크한다. --add-dir를 받지
 * 않는 에이전트(vibe 등)도 cwd 하위에서 볼트에 접근할 수 있게 하는 통로다.
 * 매 실행마다 새로 만들어 삭제·경로 변경을 반영한다.
 */
function syncVaultLinks(paths) {
  const dir = path.join(paths.workspace, VAULTS_DIRNAME);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const vault of readRegistry(paths.registry)) {
    if (!fs.existsSync(vault.path)) continue;
    try {
      fs.symlinkSync(vault.path, path.join(dir, vault.name), IS_WINDOWS ? 'junction' : 'dir');
    } catch (error) {
      const message = `볼트 링크 실패 · ${vault.name}: ${error.message}`;
      if (stdin.isTTY) p.log.warn(message);
      else console.error(`[WARN] ${message}`);
    }
  }
}

function syncDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

/**
 * 사용자 스킬을 워킬스페이스로 복사하고, Claude 슬래시 명령과 Codex가 읽는
 * SKILLS.md 카탈로그를 생성해 두 에이전트 표면의 패리티를 맞춴다.
 */
function syncSkills(paths) {
  const commandsDir = path.join(paths.workspace, '.claude', 'commands');
  const skillsDest = path.join(paths.workspace, '.claude', 'skills');
  fs.rmSync(skillsDest, { recursive: true, force: true });
  fs.mkdirSync(skillsDest, { recursive: true });

  const published = [];
  const warnings = [];
  for (const skill of listSkills(paths.skillsDir)) {
    if (!fs.existsSync(skill.file)) {
      warnings.push(`${skill.name}: ${SKILL_FILE}이 없어 생략합니다.`);
      continue;
    }
    // 내장 라우핑 명령을 스킬 슬래시 명령이 덮어쓰지 못하게 마는다.
    if (fs.existsSync(path.join(commandsDir, `${skill.name}.md`))) {
      warnings.push(`${skill.name}: 내장 명령과 이름이 겹쳐서 생략합니다.`);
      continue;
    }
    fs.cpSync(skill.dir, path.join(skillsDest, skill.name), { recursive: true });
    fs.writeFileSync(path.join(commandsDir, `${skill.name}.md`), renderCommandStub(skill));
    published.push(skill);
    if (skill.issues.length) warnings.push(`${skill.name}: ${skill.issues.join(' / ')}`);
  }

  fs.writeFileSync(path.join(paths.workspace, 'SKILLS.md'), renderSkillsCatalog(published));
  for (const warning of warnings) {
    if (stdin.isTTY) p.log.warn(`스킬 · ${warning}`);
    else console.error(`[WARN] 스킬: ${warning}`);
  }
  return published;
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
  syncDirectory(path.join(paths.packageRoot, '.claude', 'commands'), path.join(paths.workspace, '.claude', 'commands'));
  syncSkills(paths);

  syncVaultLinks(paths);

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

/**
 * 논리 에이전트 이름(claude/codex)을 실행 정보로 해소한다.
 * - tokens: 실제 실행 토큰 배열(예: `dbexec repo run isaac` → ['dbexec','repo','run','isaac'])
 * - addDir: 등록된 볼트를 `--add-dir <경로>`로 넘길지 여부
 * 재정의가 없으면 이름 자체를 실행하고 --add-dir를 붙인다(claude/codex 기본).
 */
function resolveAgentCommand(paths, name) {
  const override = readAgents(paths.registry).find((agent) => agent.name === name);
  const tokens = override ? splitCommand(override.command) : [name];
  if (!tokens.length) throw new Error(`${name} 에이전트 명령을 해석할 수 없습니다: ${override?.command}`);
  return { tokens, addDir: override ? override.addDir : true };
}

function resolveAgent(paths, requested) {
  if (requested) {
    if (!SUPPORTED_AGENTS.includes(requested)) throw new Error(`지원하지 않는 에이전트입니다: ${requested}`);
    return requested;
  }
  const configured = process.env.LLM_WIKI_AGENT;
  if (configured) return resolveAgent(paths, configured);
  // 자동 감지는 논리 이름이 아니라 실제로 실행될 명령의 존재 여부로 판단한다.
  for (const name of SUPPORTED_AGENTS) {
    if (commandExists(resolveAgentCommand(paths, name).tokens[0])) return name;
  }
  throw new Error('Claude Code 또는 Codex를 찾을 수 없습니다. 설치하거나 `llmwiki agent set`으로 실행 명령을 지정하세요.');
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

  const skills = listSkills(paths.skillsDir);
  if (!skills.length) add('info', '커스텀 스킬', `없음 · 필요하면 llmwiki skill add <name> (${paths.skillsDir})`);
  for (const skill of skills) {
    if (skill.issues.length) add('warn', `스킬 ${skill.name}`, skill.issues.join(' / '));
    else add('success', `스킬 ${skill.name}`, skill.description);
  }

  const labels = { claude: 'Claude Code', codex: 'Codex' };
  const found = {};
  for (const name of SUPPORTED_AGENTS) {
    const { tokens, addDir } = fs.existsSync(paths.registry) ? resolveAgentCommand(paths, name) : { tokens: [name], addDir: true };
    const command = tokens.join(' ');
    const custom = command !== name;
    found[name] = commandExists(tokens[0]);
    const state = found[name] ? (custom ? '실행 가능' : '설치됨') : (custom ? '명령 없음' : '찾을 수 없음');
    const detail = custom ? `${command} · add-dir ${addDir ? 'yes' : 'no'} · ${state}` : state;
    add(found[name] ? 'success' : 'warn', labels[name], detail);
  }
  if (!Object.values(found).some(Boolean)) add('error', '에이전트', 'Claude Code 또는 Codex 설치 필요 (또는 llmwiki agent set)');

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
  const agent = resolveAgent(paths, requestedAgent);
  const { tokens: [command, ...commandArgs], addDir } = resolveAgentCommand(paths, agent);
  const vaultArgs = addDir
    ? readRegistry(paths.registry)
      .filter((vault) => fs.existsSync(vault.path))
      .flatMap((vault) => ['--add-dir', vault.path])
    : [];
  const label = command === agent ? agent : `${agent} → ${[command, ...commandArgs].join(' ')}`;
  console.log(`${label} 시작 (workspace: ${workspace})`);
  const child = runAsync(command, [...commandArgs, ...vaultArgs, ...agentArgs], {
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
export function splitCommand(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new Error(`$EDITOR 또는 $VISUAL 환경 변수를 설정하세요. (대상: ${file})`);
  const [command, ...editorArgs] = splitCommand(editor);
  if (!command) throw new Error(`$EDITOR 값을 해석할 수 없습니다: ${editor}`);
  // 셸 문자열을 조립하지 않고 인자로 전달해 경로 속 $()·백틱 해석을 막는다.
  const result = runSync(command, [...editorArgs, file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`편집기가 상태 코드 ${result.status}로 종료되었습니다.`);
}

function editConfig(paths) {
  ensureRegistry(paths);
  openInEditor(paths.registry);
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
    if (action === 'lint') return lintVaults(paths, vaultArgs);
    if (action === 'scaffold') return scaffoldVaults(paths, vaultArgs);
    throw new Error('사용법: llmwiki vault <add|list|show|remove|lint|scaffold>');
  }
  if (command === 'agent' || command === 'agents') {
    const [action = 'list', name, ...commandTokens] = rest;
    if (action === 'list' || action === 'ls') return listAgents(paths, rest.slice(1));
    if (action === 'set') return setAgent(paths, name, commandTokens);
    if (action === 'reset') return resetAgent(paths, name);
    throw new Error('사용법: llmwiki agent <list|set|reset>');
  }
  if (command === 'skill' || command === 'skills') {
    const [action = 'list', ...skillArgs] = rest;
    if (action === 'list' || action === 'ls') return listSkillsCommand(paths, skillArgs);
    if (action === 'add' || action === 'new') {
      if (stdin.isTTY) p.intro('llmwiki · 커스텀 스킬 추가');
      return addSkill(paths, skillArgs);
    }
    if (action === 'show') return showSkill(paths, skillArgs[0]);
    if (action === 'edit') return editSkill(paths, skillArgs[0]);
    if (action === 'remove' || action === 'rm') return removeSkillCommand(paths, skillArgs[0]);
    if (action === 'templates') return listSkillTemplates(paths);
    if (action === 'path') return console.log(skillArgs[0] ? skillDir(paths.skillsDir, skillArgs[0]) : paths.skillsDir);
    throw new Error('사용법: llmwiki skill <list|add|show|edit|remove|templates|path>');
  }
  if (command === 'config') {
    const [action] = rest;
    if (action === 'path') return console.log(paths.registry);
    if (action === 'edit') return editConfig(paths);
    throw new Error('사용법: llmwiki config <path|edit>');
  }
  throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
}
