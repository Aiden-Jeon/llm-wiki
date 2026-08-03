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
import {
  formatTimestamp,
  rawNoteFilename,
  renderRawNote,
  resolveCaptureVault,
  writeRawNote,
} from './capture.js';
import { loadRemoteConfig, upsertRemoteConfig, removeRemoteConfig, listRemoteConfigs, DEFAULT_PROVIDER } from './remote.js';
import { renderNote } from './note.js';
import { getProvider, listProviders } from './providers/index.js';
import { resolveRemoteToken, normalizeVaultKey } from './providers/token.js';
import {
  addConnection,
  listConnections,
  getConnection,
  getConnectionToken,
  removeConnection,
  hasConnection,
  normalizeConnectionName,
  legacyConnectionName,
  pruneSecretsGitignore,
} from './secrets.js';
import { pushSync, deleteRemoteDatabaseMapping, REMOTE_MAP_FILE } from './sync.js';
import { pullInbox } from './inbox.js';
import {
  gitAddCommit,
  gitClone,
  gitCommitFile,
  gitPullRebase,
  gitPush,
  gitRemoteUrl,
  gitSetRemote,
  fileHasChanges,
  hasUpstream,
  isGitAvailable,
  isGitRepo,
} from './git.js';
import { applyImportBundle, readExportBundle, writeExportBundle } from './settings.js';

const VAULT_OPTION_KEYS = ['name', 'path', 'kind', 'backend', 'origin', 'signals', 'notes'];
const VAULT_BOOLEAN_KEYS = [];
const VAULT_ADD_USAGE = 'llmwiki vault add --name <name> [--path <path>] [--kind open|secure] [--backend local|git] [--origin <git-url>] [--signals <신호>] [--notes <메모>]';
const VAULT_SYNC_USAGE = 'llmwiki vault sync [name] [--message <msg>] [--no-push] [--pull-only]';
const CAPTURE_USAGE = 'llmwiki capture [--vault <name>] [--title <제목>] [--text <내용>]';
const PUBLISH_USAGE = 'llmwiki publish [vault] [--dry-run] [--limit <n>]';
const PUBLISH_ADD_USAGE = 'llmwiki publish add [vault] [--remote <provider>] [--connection <name>] [--remote-token <token>] [--publish-db <id>] [--inbox-db <id>] [--title-prop <name>] [--allow-publish]';
const PUBLISH_REMOVE_USAGE = 'llmwiki publish remove [vault] [--purge-token | --keep-token]';
const PUBLISH_LIST_USAGE = 'llmwiki publish list [--json]';
const PUBLISH_VIEW_USAGE = 'llmwiki publish view [vault]';
const CONNECTION_ADD_USAGE = 'llmwiki connection add [--remote <provider>] [--name <name>] [--remote-token <token>]';
const CONNECTION_LIST_USAGE = 'llmwiki connection list [--json]';
const CONNECTION_REMOVE_USAGE = 'llmwiki connection remove <name> [--remote <provider>] [--force]';
const CONFIG_EXPORT_USAGE = 'llmwiki config export [--output <file>]';
const CONFIG_IMPORT_USAGE = 'llmwiki config import <file> [--vaults-dir <dir>] [--force]';
const INBOX_USAGE = 'llmwiki inbox pull [vault] [--dry-run] [--limit <n>]';
const SKILL_ADD_USAGE = 'llmwiki skill add <name> [--description <설명>] [--from <경로>] [--template <name>] [--force] [--no-edit]';
const RESET_USAGE = 'llmwiki reset [--purge-vaults] [--force]';
const IS_WINDOWS = process.platform === 'win32';

const HELP = `llmwiki — 여러 LLM Markdown 위키를 한 곳에서 운영합니다.

사용법:
  llmwiki                         설정된 에이전트로 시작
  llmwiki start [claude|codex] [-- <agent args>]
  llmwiki claude [agent args]     Claude Code로 바로 시작
  llmwiki codex [agent args]      Codex로 바로 시작
  llmwiki new <url|경로|텍스트>    에이전트를 띄워 입력을 ingest
  llmwiki capture [options]       자유 텍스트 메모를 볼트 raw/notes/에 저장
  llmwiki publish [vault] [--dry-run] [--limit <n>]   로컬 위키를 원격에 발행 (view, 단방향)
  llmwiki publish add [vault] [options]  볼트에 원격 provider를 연결 (발행 설정)
  llmwiki publish list [--json]   등록된 발행 설정 목록
  llmwiki publish remove [vault]  발행 설정 삭제(고아가 된 연결이면 토큰 삭제 여부를 물어봄)
  llmwiki connection add [options]  원격 provider 토큰을 이름 붙여 저장 (워크스페이스별 연결)
  llmwiki connection list [--json]  저장된 연결 목록
  llmwiki connection remove <name>  저장된 연결(토큰) 삭제
  llmwiki inbox pull [vault] [--dry-run] [--limit <n>]  원격 inbox의 새 항목을 가져옴
  llmwiki setup                   초기 설정 및 볼트 등록
  llmwiki vault add [options]     볼트 추가/수정
  llmwiki vault list [--json]     등록된 볼트 목록
  llmwiki vault show <name>       볼트 상세 정보 및 상태
  llmwiki vault remove <name>     볼트 제거
  llmwiki vault lint [name] [--json]  볼트가 위키 스키마를 지키는지 검사
  llmwiki vault scaffold [name]   누락된 스키마 구조를 생성 (기존 파일 보존)
  llmwiki vault sync [name] [--message <msg>] [--no-push] [--pull-only]  git 백엔드 볼트 동기화
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
  llmwiki reset [--purge-vaults] [--force]   모든 사용자 설정을 지워 setup 이전 상태로 초기화
  llmwiki config path             설정 파일 경로 출력
  llmwiki config edit             $EDITOR로 설정 편집
  llmwiki config export [--output <file>]        설정(볼트·스킬)을 JSON 번들로 내보내기
  llmwiki config import <file> [--vaults-dir <dir>] [--force]  다른 머신의 설정 가져오기

vault add 옵션:
  --name <name> [--path <path>] [--kind open|secure]
  [--backend local|git] [--origin <git-url>]
  [--signals <쉼표 구분 신호>] [--notes <메모>]
  원격 발행 연결은 볼트와 분리돼 있습니다 → llmwiki publish add <vault> 참고.

볼트 백엔드:
  local  이 머신의 폴더 (기본값)
  git    git repo. --origin으로 clone하고(path 생략 시 ~/llmwiki-vaults/<name>),
         llmwiki vault sync로 pull→commit→push해 여러 머신에서 같은 위키를 작업

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

capture 옵션:
  --vault <name>   대상 볼트 (미지정 시 단일 볼트면 자동, 여러 개면 선택/에러)
  --title <제목>   메모 제목 (파일명 slug·frontmatter에 사용)
  --text <내용>    메모 본문 (미지정 시 TTY 프롬프트, 파이프면 stdin)

원격 연동 (publish/inbox):
  발행 설정은 볼트와 분리돼 전역 config의 publish.json에 볼트 이름으로 둡니다 (토큰 제외).
    { "version": 1, "vaults": { "personal": { "provider": "notion",
        "publish": { "databaseId": "…" }, "inbox": { "databaseId": "…" }, "allowPublish": false } } }
  llmwiki publish add <vault>로 이 엔트리를 생성하고 토큰을 secrets.json(0600)에 저장합니다.
  대화형(TTY)이면 대상 데이터베이스를 새로 만들거나 기존 목록에서 고를 수 있어(DB id 직접 입력 불필요),
  비대화형은 --publish-db/--inbox-db로 id를 직접 지정합니다.
  provider가 원격 대상을 결정합니다(현재 지원: notion). publish는 wiki/** 페이지를
  단방향 push해 view를 발행하고, 발행 상태는 <vault>/_meta/remote-map.json에 기록합니다
  (설정=전역, 상태=볼트: 상태는 git 볼트와 함께 이동해 여러 머신에서 중복 발행을 막습니다).
  secure 볼트는 allowPublish: true 필요. Notion provider는 @notionhq/client가 필요합니다:
  npm i @notionhq/client

토큰 저장·해소 순서 (앞이 우선):
  1. publish.json 엔트리의 tokenEnv가 가리키는 환경 변수
  2. LLMWIKI_<PROVIDER>_TOKEN_<VAULT>  (환경 변수)
  3. LLMWIKI_<PROVIDER>_TOKEN          (환경 변수)
  4. 설정 디렉터리 secrets.json         (0600, git·config export 제외)
  환경 변수가 secrets.json보다 우선합니다(CI·스크립트가 저장 토큰을 덮어쓸 수 있게).

환경 변수:
  LLM_WIKI_AGENT       기본 에이전트 (claude 또는 codex)
  LLM_WIKI_CONFIG_HOME 설정 디렉터리 재정의
  LLM_WIKI_DATA_HOME   런타임 데이터 디렉터리 재정의
  LLMWIKI_<PROVIDER>_TOKEN          원격 토큰 (모든 볼트 공통 폴백, 예: LLMWIKI_NOTION_TOKEN)
  LLMWIKI_<PROVIDER>_TOKEN_<VAULT>  볼트별 원격 토큰 (예: LLMWIKI_NOTION_TOKEN_PERSONAL)`;

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

async function askVault(paths, initial = {}, { edit = false } = {}) {
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

  // 백엔드 선택. 편집 중이거나 addVault가 이미 확정한 경우(initial.backend)는 건너뛴다.
  let backend = initial.backend;
  if (backend === undefined && !edit) {
    backend = await p.select({
      message: '볼트 백엔드',
      initialValue: 'local',
      options: [
        { value: 'local', label: 'Local', hint: '이 머신의 폴더' },
        { value: 'git', label: 'Git', hint: 'git repo · llmwiki vault sync로 머신 간 공유' },
      ],
    });
    if (cancelPrompt(backend)) return null;
  }
  backend = backend || 'local';

  // git 백엔드: origin을 받아 기본 위치로 clone하고 path를 확정한다(이미 확정됐으면 재사용).
  let vaultPath;
  let origin = initial.origin || '';
  if (backend === 'git' && !edit && initial.path === undefined) {
    if (!origin) {
      origin = await p.text({
        message: 'git 원격 URL (origin)',
        placeholder: 'git@github.com:me/wiki.git',
        validate(value) { if (!value.trim()) return 'git 백엔드는 origin이 필요합니다.'; },
      });
      if (cancelPrompt(origin)) return null;
    }
    const provisioned = ensureGitVault(paths, { name, origin });
    vaultPath = provisioned.path;
    origin = provisioned.origin;
  } else {
    vaultPath = !edit && initial.path !== undefined ? initial.path : await p.text({
      message: '볼트 경로',
      placeholder: '~/wikis/personal',
      initialValue: edit ? initial.path : undefined,
      validate(value) { if (!value.trim()) return '볼트 경로는 필수입니다.'; },
    });
    if (cancelPrompt(vaultPath)) return null;
  }

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

  const vault = normalizeVault({ name, path: vaultPath, kind, backend, origin, signals, notes });
  console.log(renderNote([
    `이름    ${vault.name}`,
    `경로    ${vault.path}`,
    `종류    ${vault.kind}`,
    `백엔드  ${vault.backend}${vault.origin ? ` · ${vault.origin}` : ''}`,
    `신호    ${vault.signals || '없음'}`,
    `메모    ${vault.notes || '없음'}`,
  ].join('\n'), '등록 내용'));

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

/**
 * git backend 볼트의 로컬 저장소를 준비한다. 순수 등록 헬퍼(레지스트리는 건드리지 않음).
 * - resolvedPath 미지정 시 기본 위치 paths.vaultsHome/<name>.
 * - 대상이 이미 git repo면 그대로 쓰고, origin 미지정 시 remote에서 자동 채운다.
 * - 아니면 origin으로 clone한다(origin 필수).
 * 반환: { path, origin }.
 */
function ensureGitVault(paths, { name, resolvedPath, origin }) {
  if (!isGitAvailable()) throw new Error('git backend 볼트를 쓰려면 git이 필요합니다. git을 설치하세요.');
  const target = resolvedPath || path.join(paths.vaultsHome, name);

  if (isGitRepo(target)) {
    const actual = gitRemoteUrl(target);
    // origin을 지정하지 않았으면 저장소의 실제 remote를 그대로 쓴다.
    if (!origin) {
      if (!actual) throw new Error(`${target}에 origin 원격이 없습니다. --origin으로 지정하세요.`);
      return { path: target, origin: actual };
    }
    // origin을 지정했는데 저장소에 remote가 없으면 그 값으로 설정한다.
    if (!actual) {
      gitSetRemote(target, origin);
      return { path: target, origin };
    }
    // 지정한 origin과 저장소의 실제 remote가 다르면, 등록 메타데이터가 실제 push/pull 대상과
    // 어긋나므로 거부한다(잘못된 origin이 조용히 기록되는 것을 막는다).
    if (actual !== origin) {
      throw new Error(
        `${target}의 실제 origin(${actual})이 지정한 --origin(${origin})과 다릅니다. `
        + '일치시키거나 --origin을 생략해 실제 값을 쓰세요.',
      );
    }
    return { path: target, origin };
  }

  if (!origin) throw new Error(`git backend 볼트는 origin(원격 URL)이 필요합니다.\n사용법: ${VAULT_ADD_USAGE}`);
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error(`${target}가 비어 있지 않아 clone할 수 없습니다. 다른 --path를 쓰거나 정리하세요.`);
  }
  if (stdin.isTTY) p.log.step(`git clone ${origin} → ${target}`);
  gitClone(origin, target);
  return { path: target, origin };
}

async function addVault(paths, args, { outro = true, initial = {}, edit = false } = {}) {
  ensureRegistry(paths);
  const { options, rest } = parseOptions(args, { allowed: VAULT_OPTION_KEYS, booleans: VAULT_BOOLEAN_KEYS, usage: VAULT_ADD_USAGE });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${VAULT_ADD_USAGE}`);

  const merged = { ...initial, ...options };
  // git backend는 등록 전에 로컬 저장소를 준비(clone)하고 path/origin을 확정한다.
  // 비-TTY이거나 옵션으로 backend=git이 넘어온 경우를 여기서 먼저 처리한다.
  if (merged.backend === 'git' && !edit) {
    if (!merged.name) throw new Error(`git backend 볼트는 --name이 필요합니다.\n사용법: ${VAULT_ADD_USAGE}`);
    const provisioned = ensureGitVault(paths, {
      name: merged.name,
      resolvedPath: merged.path,
      origin: merged.origin,
    });
    merged.path = provisioned.path;
    merged.origin = provisioned.origin;
  }

  const vault = await askVault(paths, merged, { edit });
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
  // 원격 발행 설정은 볼트와 분리돼 있다: `llmwiki publish add <vault>`로 따로 연결한다.
  return true;
}

// TTY에서 새 토큰을 입력받는다(provider가 발급 안내를 주면 먼저 보여준다). 취소 시 null.
async function promptNewToken(provider) {
  if (provider.tokenHelp) {
    const help = provider.tokenHelp;
    // p.note는 CJK·긴 URL에서 테두리가 틀어지므로 displayWidth 기반 renderNote로 그린다.
    const body = [help.url && `토큰 발급: ${help.url}`, ...(help.lines || [])].filter(Boolean).join('\n');
    if (body) console.log(renderNote(body, `${provider.name} 토큰 발급 안내`));
  }
  const entered = await p.password({ message: `${provider.name} 토큰`, mask: '•' });
  if (cancelPrompt(entered)) return null;
  return entered;
}

// TTY에서 연결 이름을 입력받는다. 기존 이름이면 덮어쓸지 확인한다. 취소 시 null.
async function promptConnectionName(paths, provider, { suggested } = {}) {
  while (true) {
    const entered = await p.text({
      message: `연결 이름 (이 ${provider.name} 워크스페이스를 부를 이름)`,
      defaultValue: suggested || '',
      placeholder: suggested || 'personal',
    });
    if (cancelPrompt(entered)) return null;
    let name;
    try { name = normalizeConnectionName(entered); }
    catch (error) { p.log.warn(error.message); continue; }
    if (hasConnection(paths.secrets, provider.name, name)) {
      const overwrite = await p.confirm({ message: `연결 '${name}'이(가) 이미 있습니다. 토큰을 덮어쓸까요?`, initialValue: false });
      if (cancelPrompt(overwrite)) return null;
      if (!overwrite) continue;
    }
    return name;
  }
}

/**
 * configureRemote가 쓸 연결(named connection)을 정한다. 반환 { name, token, isNew } | null(취소).
 * 우선순위:
 *  - `--connection <name>`: 그 이름 사용. `--remote-token` 있으면 새 토큰(isNew), 없으면 저장된
 *    연결 재사용(없고 TTY면 토큰 입력받고, 없고 비-TTY면 에러).
 *  - `--remote-token`만: 이름이 필요 → 비-TTY는 `--connection` 필수(에러), TTY는 이름 입력.
 *  - 둘 다 없음 → TTY는 저장된 연결 목록에서 고르거나 새로 추가, 비-TTY는 볼트 이름 기반
 *    레거시 연결이 있으면 재사용(마이그레이션 호환), 없으면 에러.
 */
async function resolveConfigureConnection(paths, provider, vault, opts, tty) {
  const explicitName = opts.connection ? normalizeConnectionName(opts.connection) : null;
  const explicitToken = opts['remote-token'];

  if (explicitName) {
    if (explicitToken) return { name: explicitName, token: explicitToken, isNew: true };
    const stored = getConnectionToken(paths.secrets, provider.name, explicitName);
    if (stored) return { name: explicitName, token: stored, isNew: false };
    if (!tty) throw new Error(`연결 '${explicitName}'을(를) 찾을 수 없습니다. --remote-token으로 새로 저장하세요.\n사용법: ${PUBLISH_ADD_USAGE}`);
    const token = await promptNewToken(provider);
    if (token === null) return null;
    return { name: explicitName, token, isNew: true };
  }

  if (explicitToken) {
    // 비-TTY에서 이름이 없으면 볼트 이름을 연결 이름으로 기본 지정한다(스크립트 호환).
    if (!tty) return { name: normalizeConnectionName(vault.name), token: explicitToken, isNew: true };
    const name = await promptConnectionName(paths, provider, { suggested: vault.name });
    if (name === null) return null;
    return { name, token: explicitToken, isNew: true };
  }

  if (!tty) {
    // 볼트 이름 기반 레거시 연결(v1 마이그레이션 결과)이 있으면 그대로 쓴다.
    const legacy = legacyConnectionName(normalizeVaultKey(vault.name));
    const token = getConnectionToken(paths.secrets, provider.name, legacy);
    if (token) return { name: legacy, token, isNew: false };
    throw new Error(`--remote 사용 시 저장된 연결이 없으면 --remote-token(과 --connection)이 필요합니다.\n사용법: ${PUBLISH_ADD_USAGE}`);
  }

  // TTY: 저장된 연결에서 고르거나 새로 추가한다.
  const existing = listConnections(paths.secrets, provider.name);
  if (existing.length) {
    const picked = await p.select({
      message: `${provider.name} 연결 선택`,
      options: [
        ...existing.map((c) => ({ value: c.name, label: c.name, hint: c.account })),
        { value: '__new__', label: '+ 새 연결 추가' },
      ],
    });
    if (cancelPrompt(picked)) return null;
    if (picked !== '__new__') {
      return { name: picked, token: getConnectionToken(paths.secrets, provider.name, picked), isNew: false };
    }
  }
  const name = await promptConnectionName(paths, provider, { suggested: vault.name });
  if (name === null) return null;
  const token = await promptNewToken(provider);
  if (token === null) return null;
  return { name, token, isNew: true };
}

/**
 * 볼트에 원격 provider를 연결한다. named connection(토큰)과 DB id를 받아 실호출로 검증한 뒤,
 * 성공해야만 (새 연결이면) 토큰을 secrets store에 저장하고 전역 publish.json에 대상 설정과
 * 연결 이름을 기록한다. 같은 연결을 여러 볼트가 공유할 수 있다.
 * getProvider는 테스트 주입 seam이다. 비-TTY에서는 --remote가 있어야만 동작한다.
 */
export async function configureRemote(paths, vault, opts = {}, { getProvider: resolveProvider = getProvider } = {}) {
  const tty = Boolean(stdin.isTTY);

  // 연결 여부: 비-TTY는 --remote가 있을 때만, TTY는 확인 프롬프트로 결정한다.
  let providerName = opts.remote;
  if (!providerName) {
    if (!tty) return false;
    const wants = await p.confirm({ message: '이 볼트에 원격 provider를 연결할까요?', initialValue: false });
    if (cancelPrompt(wants) || !wants) return false;
    const picked = await p.select({
      message: '원격 provider',
      options: listProviders().map((n) => ({ value: n, label: n })),
    });
    if (cancelPrompt(picked)) return false;
    providerName = picked;
  }

  const provider = resolveProvider(providerName);

  if (!vault || !fs.existsSync(vault.path)) {
    const note = `${vault.name} 볼트 경로가 아직 없습니다. 원격 설정은 경로 생성 후 다시 시도하세요.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 사용할 named connection(토큰)을 정한다: 저장된 연결 재사용 또는 새 토큰 입력.
  const conn = await resolveConfigureConnection(paths, provider, vault, opts, tty);
  if (!conn) return false;
  const { name: connectionName, token } = conn;

  // 클라이언트 생성 + 토큰 검증을 먼저 한다(대화형 대상 선택이 client를 쓴다).
  // 실패하면 아무것도 저장하지 않는다.
  let client;
  let account;
  const spinTok = tty ? p.spinner() : null;
  if (spinTok) spinTok.start('토큰 검증 중');
  try {
    client = await provider.createClient(token);
    if (typeof provider.validateToken === 'function') {
      const result = await provider.validateToken(client);
      account = result && result.account;
    }
  } catch (error) {
    if (spinTok) spinTok.stop('검증 실패');
    throw error;
  }
  if (spinTok) spinTok.stop(account ? `토큰 확인 완료 · ${account}` : '토큰 확인 완료');

  // 대상 해소: TTY이고 provider가 목록/생성을 지원하면 대화형(새로 생성/기존 선택/건너뛰기),
  // 아니면 플래그(--publish-db/--inbox-db)로 받고 verifyDatabase로 존재만 확인한다.
  let publishDb;
  let inboxDb;
  let publishTitleProp;
  const interactive = tty && typeof provider.listDatabases === 'function';
  if (interactive) {
    // 새 DB 생성 시 기본 이름은 볼트명 + 목적(publish/inbox)이 드러나게 제안한다.
    const pub = await selectRemoteDatabase(provider, client, { label: 'publish', checkSchema: true, defaultName: `${vault.name} Wiki` });
    if (pub && pub.cancelled) return false;
    if (pub) { publishDb = pub.databaseId; publishTitleProp = pub.titleProperty; }
    const ibx = await selectRemoteDatabase(provider, client, { label: 'inbox', checkSchema: false, defaultName: `${vault.name} Inbox` });
    if (ibx && ibx.cancelled) return false;
    if (ibx) inboxDb = ibx.databaseId;
  } else {
    publishDb = opts['publish-db'];
    inboxDb = opts['inbox-db'];
    // 목록 미지원 provider를 TTY에서 쓸 때의 폴백: id를 직접 입력받는다.
    if (tty && !publishDb && !inboxDb) {
      const s = await p.text({ message: 'publish 대상 데이터베이스 id (없으면 비움)', defaultValue: '' });
      if (cancelPrompt(s)) return false;
      publishDb = (s || '').trim();
      const i = await p.text({ message: 'inbox 데이터베이스 id (없으면 비움)', defaultValue: '' });
      if (cancelPrompt(i)) return false;
      inboxDb = (i || '').trim();
    }
  }

  if (!publishDb && !inboxDb) {
    const note = interactive
      ? '대상을 하나도 선택하지 않았습니다. 원격 설정을 건너뜁니다.'
      : 'publish-db 또는 inbox-db 중 최소 하나가 필요합니다. 원격 설정을 건너뜁니다.';
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // secure 볼트는 publish(민감 방향)에 명시적 allowPublish가 필요하다. 없으면 inbox만 설정한다.
  if (publishDb && vault.kind === 'secure') {
    let allowPublish;
    if (tty) {
      p.log.warn(`secure 볼트를 ${provider.name}에 push하게 됩니다. 고객명·자격증명·내부 URL 익명화를 확인하세요.`);
      const ok = await p.confirm({ message: `${vault.name}(secure) publish를 활성화할까요?`, initialValue: false });
      if (cancelPrompt(ok)) return false;
      allowPublish = ok === true;
    } else {
      allowPublish = opts['allow-publish'] === true;
    }
    if (!allowPublish) {
      const note = 'secure 볼트 publish에는 allowPublish(--allow-publish 또는 확인)가 필요합니다. inbox만 설정합니다.';
      if (tty) p.log.warn(note); else console.error(note);
      publishDb = '';
      if (!inboxDb) return false;
    }
  }

  // 비-대화형 경로는 대상 DB의 존재를 여기서 확인한다(대화형은 목록/생성 과정에서 이미 확인됨).
  if (!interactive && typeof provider.verifyDatabase === 'function') {
    if (publishDb) await provider.verifyDatabase(client, { databaseId: publishDb });
    if (inboxDb) await provider.verifyDatabase(client, { databaseId: inboxDb });
  }

  // 통과 → 토큰은 named connection으로 store에만(새 토큰일 때만), 대상 설정은 전역
  // publish.json에(토큰 없이) 기록하고 어떤 연결을 쓰는지 연결 이름을 남긴다.
  if (conn.isNew) addConnection(paths.secrets, provider.name, connectionName, { token, account });
  const patch = { provider: provider.name, connection: connectionName };
  if (publishDb) {
    patch.publish = { databaseId: publishDb };
    const titleProp = opts['title-prop'] || publishTitleProp;
    if (titleProp) patch.publish.titleProperty = titleProp;
    if (vault.kind === 'secure') patch.allowPublish = true;
  }
  if (inboxDb) patch.inbox = { databaseId: inboxDb };
  upsertRemoteConfig(paths.publish, vault.name, patch);

  const tokenNote = conn.isNew ? `연결 '${connectionName}' 저장됨(secrets.json)` : `연결 '${connectionName}' 사용`;
  const summary = `발행 설정 · ${vault.name} → ${provider.name}${publishDb ? ' · publish' : ''}${inboxDb ? ' · inbox' : ''} · ${tokenNote}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return true;
}

/**
 * 대화형으로 원격 대상 데이터베이스를 정한다(TTY 전용). 새로 생성 / 기존 선택 / 건너뛰기.
 * checkSchema면 기존 DB 선택 시 publish 스키마와 비교해 누락/충돌을 보여주고 진행 여부를 묻는다.
 * 반환: { databaseId, titleProperty? }(정함) | null(건너뜀·후보 없음) | { cancelled: true }(중단).
 */
async function selectRemoteDatabase(provider, client, { label, checkSchema, defaultName = 'llm-wiki' }) {
  const withSpinner = async (message, fn) => {
    const spin = p.spinner();
    spin.start(message);
    try { const result = await fn(); spin.stop(`${message} 완료`); return result; }
    catch (error) { spin.stop(`${message} 실패`); throw error; }
  };

  const action = await p.select({
    message: `${label} 대상 데이터베이스`,
    options: [
      { value: 'existing', label: '기존 데이터베이스 사용' },
      { value: 'new', label: '새 데이터베이스 생성' },
      { value: 'skip', label: '설정 안 함' },
    ],
    initialValue: 'skip',
  });
  if (cancelPrompt(action)) return { cancelled: true };
  if (action === 'skip') return null;

  if (action === 'new') {
    if (typeof provider.listPages !== 'function' || typeof provider.createDatabase !== 'function') {
      p.log.warn('이 provider는 데이터베이스 생성을 지원하지 않습니다. 기존 데이터베이스를 사용하세요.');
      return { cancelled: true };
    }
    const pages = await withSpinner('페이지 목록 불러오는 중', () => provider.listPages(client, {}));
    if (!pages.length) {
      p.log.warn(`접근 가능한 페이지가 없습니다. ${provider.connectHelp || '대상을 provider에 연결한 뒤 다시 시도하세요.'}`);
      return { cancelled: true };
    }
    const parent = await p.select({
      message: '새 데이터베이스를 만들 부모 페이지',
      options: pages.map((pg) => ({ value: pg.id, label: pg.title || '(제목 없음)' })),
    });
    if (cancelPrompt(parent)) return { cancelled: true };
    const title = await p.text({ message: '새 데이터베이스 이름', defaultValue: defaultName, placeholder: defaultName });
    if (cancelPrompt(title)) return { cancelled: true };
    return withSpinner('데이터베이스 생성 중', () => provider.createDatabase(client, { parentPageId: parent, title: (title || defaultName).trim() }));
  }

  // 기존 선택
  const dbs = await withSpinner('데이터베이스 목록 불러오는 중', () => provider.listDatabases(client, {}));
  if (!dbs.length) {
    p.log.warn(`접근 가능한 데이터베이스가 없습니다. ${provider.connectHelp || '대상을 provider에 연결한 뒤 다시 시도하세요.'}`);
    return { cancelled: true };
  }
  const dbId = await p.select({
    message: `${label} 데이터베이스 선택`,
    options: dbs.map((db) => ({ value: db.id, label: db.title })),
  });
  if (cancelPrompt(dbId)) return { cancelled: true };

  if (!checkSchema || typeof provider.inspectDatabase !== 'function') return { databaseId: dbId };

  const info = await withSpinner('스키마 확인 중', () => provider.inspectDatabase(client, { databaseId: dbId }));
  if (info.ok) return { databaseId: dbId, titleProperty: info.titleProperty };

  // 스키마 불일치 → 내역을 보여주고 진행 여부를 묻는다(싫다고 하면 중단).
  const lines = [];
  if (info.missing.length) lines.push(`누락된 속성(추가 가능): ${info.missing.join(', ')}`);
  if (info.conflicts.length) {
    lines.push(`타입이 다른 속성(자동 수정 안 함, 손으로 고쳐야 함):`);
    for (const c of info.conflicts) lines.push(`  · ${c.name}: 현재 ${c.actual} → 기대 ${c.expected}`);
  }
  console.log(renderNote(lines.join('\n'), `${label} 스키마 불일치`));

  const message = info.missing.length
    ? '누락 속성을 추가하고 계속할까요? (타입 충돌은 그대로 둡니다)'
    : '이 상태로 계속할까요?';
  const proceed = await p.confirm({ message, initialValue: false });
  if (cancelPrompt(proceed) || !proceed) return { cancelled: true };

  if (info.missing.length && typeof provider.applySchema === 'function') {
    await withSpinner('스키마 갱신 중', () => provider.applySchema(client, { databaseId: dbId, missing: info.missing }));
  }
  return { databaseId: dbId, titleProperty: info.titleProperty };
}

/**
 * `llmwiki publish add [vault]`: 볼트에 원격 provider를 연결하는 독립 명령.
 * 대상 볼트를 해소한 뒤 configureRemote로 검증·저장을 위임한다.
 */
async function publishAdd(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['remote', 'connection', 'remote-token', 'publish-db', 'inbox-db', 'title-prop', 'allow-publish'],
    booleans: ['allow-publish'],
    usage: PUBLISH_ADD_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_ADD_USAGE}`);
  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_ADD_USAGE);
  if (!vault) return false;
  return configureRemote(paths, vault, options);
}

/**
 * `llmwiki publish list [--json]`: 전역 publish.json에 등록된 발행 설정을 나열한다.
 */
function publishList(paths, args) {
  const { options, rest } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: PUBLISH_LIST_USAGE });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${PUBLISH_LIST_USAGE}`);
  const configs = listRemoteConfigs(paths.publish);
  if (options.json === true) {
    console.log(JSON.stringify(configs, null, 2));
    return true;
  }
  const names = Object.keys(configs);
  if (!names.length) {
    console.log('등록된 발행 설정이 없습니다. `llmwiki publish add <vault>`로 연결하세요.');
    return true;
  }
  for (const name of names) {
    const c = configs[name];
    const parts = [];
    if (c.connection) parts.push(`연결=${c.connection}`);
    if (c.publish && c.publish.databaseId) parts.push(`publish=${c.publish.databaseId}`);
    if (c.inbox && c.inbox.databaseId) parts.push(`inbox=${c.inbox.databaseId}`);
    if (c.allowPublish) parts.push('allowPublish');
    console.log(`${name} · ${c.provider || DEFAULT_PROVIDER}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
  }
  return true;
}

/**
 * `llmwiki publish remove [vault]`: 발행 설정 엔트리를 지운다.
 * 토큰은 이 볼트가 아니라 named connection에 묶여 여러 볼트가 공유할 수 있으므로 자동으로는
 * 건드리지 않는다(설정만 unlink). 다만 이 볼트를 지운 뒤 그 연결을 쓰는 볼트가 하나도 남지
 * 않으면(고아 연결), TTY에서 토큰도 지울지 물어본다(`--purge-token`으로 질문 없이 강제,
 * `--keep-token`으로 유지). 다른 볼트가 아직 쓰는 공유 연결은 절대 지우지 않는다.
 */
export async function publishRemove(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['purge-token', 'keep-token'],
    booleans: ['purge-token', 'keep-token'],
    usage: PUBLISH_REMOVE_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_REMOVE_USAGE}`);
  if (options['purge-token'] && options['keep-token']) {
    throw new Error('--purge-token과 --keep-token은 함께 쓸 수 없습니다.');
  }
  const tty = Boolean(stdin.isTTY);
  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_REMOVE_USAGE);
  if (!vault) return false;
  const config = loadRemoteConfig(paths.publish, vault.name);
  if (!config) {
    const note = `${vault.name} 볼트에 발행 설정이 없습니다.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 삭제 전에 이 볼트가 쓰던 provider·연결을 기억해 둔다(고아 판정에 쓴다).
  const provider = config.provider || DEFAULT_PROVIDER;
  const connection = config.connection;
  // 발행 설정을 제거하기 전에 DB id를 추출해 remote-map에서 해당 DB 항목도 지운다.
  const publishDbId = config.publish && config.publish.databaseId;

  const removed = removeRemoteConfig(paths.publish, vault.name);

  // remote-map에서 해당 DB의 매핑을 제거한다(파일이 없으면 무시).
  if (publishDbId && fs.existsSync(vault.path)) {
    deleteRemoteDatabaseMapping(vault.path, publishDbId);
  }

  const summary = `발행 설정 삭제 · ${vault.name}`;
  if (tty) p.log.success(summary); else console.log(summary);

  // 이 볼트를 지운 뒤 그 연결을 쓰는 볼트가 하나도 없고, 토큰이 실제로 저장돼 있으면
  // 고아 연결이다 — 정리할지 처리한다(공유 연결은 여기 걸리지 않아 안전).
  if (connection && hasConnection(paths.secrets, provider, connection)) {
    const stillUsed = (connectionUsage(paths).get(`${provider}:${connection}`) || []).length > 0;
    if (!stillUsed) {
      let purge;
      if (options['purge-token']) purge = true;
      else if (options['keep-token']) purge = false;
      else if (tty) {
        const ok = await p.confirm({
          message: `연결 '${provider}:${connection}'을(를) 이제 아무 볼트도 쓰지 않습니다. 저장된 토큰도 지울까요?`,
          initialValue: false,
        });
        if (cancelPrompt(ok)) return removed;
        purge = ok === true;
      } else {
        // 비대화형은 물어볼 수 없으므로 토큰을 유지하고 안내만 한다.
        console.log(`연결 '${provider}:${connection}'이(가) 더 이상 쓰이지 않습니다. 지우려면 llmwiki connection remove ${connection} --remote ${provider}`);
        purge = false;
      }
      if (purge && removeConnection(paths.secrets, provider, connection)) {
        const note = `연결 삭제됨 · ${provider}:${connection}`;
        if (tty) p.log.success(note); else console.log(note);
      }
    }
  }
  return removed;
}

// connection add/list/remove가 공유하는 provider 해소: --remote 우선, 없으면 TTY 선택, 비-TTY는 기본값.
async function resolveConnectionProvider(opts, tty, resolveProvider = getProvider) {
  if (opts.remote) return resolveProvider(opts.remote);
  const names = listProviders();
  if (!tty || names.length === 1) return resolveProvider(names[0] || DEFAULT_PROVIDER);
  const picked = await p.select({ message: '원격 provider', options: names.map((n) => ({ value: n, label: n })) });
  if (cancelPrompt(picked)) return null;
  return resolveProvider(picked);
}

/**
 * `llmwiki connection add`: 원격 provider 토큰을 이름 붙여 저장한다(워크스페이스별 연결).
 * 토큰을 실호출로 검증한 뒤에만 저장하고, 검증에서 얻은 account를 함께 기록한다.
 */
export async function connectionAdd(paths, args, { getProvider: resolveProvider = getProvider } = {}) {
  const { options } = parseOptions(args, {
    allowed: ['remote', 'name', 'remote-token'],
    usage: CONNECTION_ADD_USAGE,
  });
  const tty = Boolean(stdin.isTTY);
  const provider = await resolveConnectionProvider(options, tty, resolveProvider);
  if (!provider) return false;

  // 이름: 플래그 우선. 없으면 TTY에서 입력(중복 시 덮어쓸지 확인), 비-TTY는 필수.
  let name = options.name ? normalizeConnectionName(options.name) : null;
  if (!name) {
    if (!tty) throw new Error(`--name이 필요합니다.\n사용법: ${CONNECTION_ADD_USAGE}`);
    name = await promptConnectionName(paths, provider, {});
    if (name === null) return false;
  } else if (tty && hasConnection(paths.secrets, provider.name, name)) {
    const overwrite = await p.confirm({ message: `연결 '${name}'이(가) 이미 있습니다. 토큰을 덮어쓸까요?`, initialValue: false });
    if (cancelPrompt(overwrite) || !overwrite) return false;
  }

  // 토큰: 플래그 우선. 없으면 TTY에서 입력, 비-TTY는 필수.
  let token = options['remote-token'];
  if (!token) {
    if (!tty) throw new Error(`--remote-token이 필요합니다.\n사용법: ${CONNECTION_ADD_USAGE}`);
    token = await promptNewToken(provider);
    if (token === null) return false;
  }

  // 검증 후에만 저장한다.
  let account;
  const spin = tty ? p.spinner() : null;
  if (spin) spin.start('토큰 검증 중');
  try {
    const client = await provider.createClient(token);
    if (typeof provider.validateToken === 'function') {
      const result = await provider.validateToken(client);
      account = result && result.account;
    }
  } catch (error) {
    if (spin) spin.stop('검증 실패');
    throw error;
  }
  if (spin) spin.stop(account ? `토큰 확인 완료 · ${account}` : '토큰 확인 완료');

  addConnection(paths.secrets, provider.name, name, { token, account });
  const summary = `연결 저장됨 · ${provider.name}:${name}${account ? ` · ${account}` : ''}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return true;
}

/** `llmwiki connection list [--json]`: 저장된 연결을 나열한다(토큰은 절대 출력하지 않는다). */
export function connectionList(paths, args) {
  const { options } = parseOptions(args, { allowed: ['json'], booleans: ['json'], usage: CONNECTION_LIST_USAGE });
  const connections = listConnections(paths.secrets);
  if (options.json === true) {
    // 토큰은 빼고 메타데이터만 노출한다.
    console.log(JSON.stringify(connections.map(({ provider, name, account, updatedAt }) => ({ provider, name, account, updatedAt })), null, 2));
    return true;
  }
  if (!connections.length) {
    console.log('저장된 연결이 없습니다. `llmwiki connection add`로 추가하세요.');
    return true;
  }
  // 어떤 볼트가 각 연결을 쓰는지도 함께 보여준다.
  const usage = connectionUsage(paths);
  for (const c of connections) {
    const users = usage.get(`${c.provider}:${c.name}`) || [];
    const parts = [c.account, users.length ? `볼트: ${users.join(', ')}` : null].filter(Boolean);
    console.log(`${c.provider}:${c.name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
  }
  return true;
}

/** provider:connection → 그 연결을 참조하는 볼트 이름 목록. */
function connectionUsage(paths) {
  const map = new Map();
  const configs = listRemoteConfigs(paths.publish);
  for (const [vaultName, c] of Object.entries(configs)) {
    const provider = c.provider || DEFAULT_PROVIDER;
    const connection = c.connection || legacyConnectionName(normalizeVaultKey(vaultName));
    const key = `${provider}:${connection}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(vaultName);
  }
  return map;
}

/**
 * `llmwiki connection remove <name>`: 저장된 연결(토큰)을 삭제한다.
 * 이 연결을 참조하는 볼트가 있으면 경고하고, TTY에서는 정말 지울지 확인한다
 * (비-TTY는 --force 없이는 거부한다). 토큰은 재발급이 번거로우므로 물어본 뒤 지운다.
 */
export async function connectionRemove(paths, args, { getProvider: resolveProvider = getProvider } = {}) {
  const { options, rest } = parseOptions(args, {
    allowed: ['remote', 'force'],
    booleans: ['force'],
    usage: CONNECTION_REMOVE_USAGE,
  });
  if (!rest.length) throw new Error(`삭제할 연결 이름이 필요합니다.\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  const tty = Boolean(stdin.isTTY);
  const provider = await resolveConnectionProvider(options, tty, resolveProvider);
  if (!provider) return false;
  const name = normalizeConnectionName(rest[0]);

  const entry = getConnection(paths.secrets, provider.name, name);
  if (!entry) {
    const note = `연결 '${provider.name}:${name}'을(를) 찾을 수 없습니다.`;
    if (tty) p.log.warn(note); else console.error(note);
    return false;
  }

  // 이 연결을 쓰는 볼트가 있으면 알린다(설정은 남지만 토큰이 사라져 발행이 막힌다).
  const users = connectionUsage(paths).get(`${provider.name}:${name}`) || [];
  if (users.length) {
    const warn = `이 연결을 쓰는 볼트: ${users.join(', ')} — 삭제하면 해당 볼트의 발행/수집이 토큰을 잃습니다.`;
    if (tty) p.log.warn(warn); else console.error(warn);
  }

  if (tty) {
    const ok = await p.confirm({ message: `연결 '${provider.name}:${name}'의 토큰을 삭제할까요?`, initialValue: false });
    if (cancelPrompt(ok) || !ok) return false;
  } else if (!options.force) {
    throw new Error(`비대화형 환경에서 연결을 삭제하려면 --force가 필요합니다.\n사용법: ${CONNECTION_REMOVE_USAGE}`);
  }

  const removed = removeConnection(paths.secrets, provider.name, name);
  const summary = `연결 삭제됨 · ${provider.name}:${name}`;
  if (tty) p.log.success(summary); else console.log(summary);
  return removed;
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
      const backend = vault.backend === 'git' ? `git · ${vault.origin}` : vault.backend;
      // p.note는 박스 폭을 문자열 길이로 계산해 CJK(2칸)·긴 URL에서 오른쪽 테두리가
      // 틀어진다. displayWidth 기반의 renderNote로 같은 박스를 정렬 맞춰 그린다.
      console.log(renderNote([
        `${vault.kind} · ${backend} · ${status.exists ? '경로 정상' : '경로 없음'}`,
        vault.path,
        `신호: ${vault.signals || '없음'}`,
      ].join('\n'), vault.name));
    }
    p.outro('상세 정보: llmwiki vault show <name>');
  } else {
    console.table(vaults.map(({ name, path: vaultPath, kind, backend, origin, signals }) => ({ name, kind, backend, origin, path: vaultPath, signals })));
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
    `백엔드     ${vault.backend}${vault.origin ? ` · ${vault.origin}` : ''}`,
    `경로       ${vault.path}`,
    `라우팅 신호 ${vault.signals || '없음'}`,
    `메모       ${vault.notes || '없음'}`,
    `경로 상태   ${status.exists ? '정상' : '찾을 수 없음'}`,
    `CLAUDE.md  ${status.claude ? '있음' : '없음'}`,
    `AGENTS.md  ${status.agents ? '있음' : '없음'}`,
    `index.md   ${status.index ? '있음' : '없음'}`,
  ].join('\n');
  if (stdin.isTTY) console.log(renderNote(details, '볼트 상세'));
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
  const report = targets.map((vault) => ({ vault: vault.name, path: vault.path, kind: vault.kind, results: lintVault(vault.path) }));

  // --json은 볼트가 없어도 기계 판독 형식을 유지한다(CI 소비자 계약).
  if (options.json) {
    console.log(JSON.stringify({ registry: paths.registry, vaults: report }, null, 2));
    if (report.some((entry) => entry.results.some((result) => result.level === 'error'))) process.exitCode = 1;
    return;
  }

  if (!targets.length) {
    console.log('등록된 볼트가 없습니다. `llmwiki vault add`로 추가하세요.');
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

async function scaffoldVaults(paths, args = []) {
  const { rest } = parseOptions(args, { allowed: [], usage: 'llmwiki vault scaffold [name]' });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: llmwiki vault scaffold [name]`);
  const targets = resolveTargets(paths, rest[0]);
  if (!targets.length) {
    console.log('등록된 볼트가 없습니다. `llmwiki vault add`로 추가하세요.');
    return;
  }
  if (!fs.existsSync(paths.vaultTemplateDir)) {
    throw new Error(`볼트 템플릿을 찾을 수 없습니다: ${paths.vaultTemplateDir}`);
  }

  for (const vault of targets) {
    if (vault.kind === 'secure') {
      if (!rest[0] && !stdin.isTTY) {
        throw new Error('secure 볼트 scaffold는 볼트 이름을 명시해야 합니다: llmwiki vault scaffold <name>');
      }
      if (stdin.isTTY) {
        p.log.warn(`${vault.name}은 secure 볼트입니다. 스키마 파일과 디렉터리를 추가합니다.`);
        const accepted = await p.confirm({ message: `${vault.name}(secure)에 scaffold를 적용할까요?`, initialValue: false });
        if (cancelPrompt(accepted) || !accepted) continue;
      }
    }
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

// `llmwiki vault sync [name]`: git backend 볼트를 원격과 동기화한다(pull --rebase → commit → push).
async function syncVault(paths, args = []) {
  const { options, rest } = parseOptions(args, {
    allowed: ['message', 'no-push', 'pull-only'],
    booleans: ['no-push', 'pull-only'],
    usage: VAULT_SYNC_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${VAULT_SYNC_USAGE}`);

  ensureRegistry(paths);
  const vaults = readRegistry(paths.registry);
  if (!vaults.length) throw new Error('등록된 볼트가 없습니다. 먼저 `llmwiki vault add`로 볼트를 등록하세요.');
  const { vault, ambiguous } = resolveCaptureVault(vaults, rest[0]);
  if (ambiguous) throw new Error(`대상 볼트를 지정하세요.\n사용법: ${VAULT_SYNC_USAGE}`);

  if (vault.backend !== 'git') {
    const message = `${vault.name}은 ${vault.backend} 백엔드라 sync 대상이 아닙니다. git 백엔드 볼트만 동기화합니다.`;
    if (stdin.isTTY) p.log.info(message); else console.log(message);
    return false;
  }
  if (!fs.existsSync(vault.path)) throw new Error(`볼트 경로를 찾을 수 없습니다: ${vault.path}`);
  if (!isGitAvailable()) throw new Error('git이 필요합니다. git을 설치하세요.');
  if (!isGitRepo(vault.path)) throw new Error(`${vault.path}는 git 저장소가 아닙니다. origin에서 clone됐는지 확인하세요.`);

  const report = (level, message) => { if (stdin.isTTY) p.log[level](message); else console.log(message); };

  // 1) pull --rebase. 단, 빈 원격에서 clone한 직후에는 추적 브랜치가 없어 pull이 실패한다.
  //    이 경우 당겨올 것이 없으므로 건너뛰고 첫 커밋·push로 원격을 초기화한다.
  if (hasUpstream(vault.path)) {
    gitPullRebase(vault.path);
    report('step', 'pull --rebase 완료');
  } else {
    report('step', '원격에 추적 브랜치가 없어 pull 생략 (첫 sync)');
  }
  if (options['pull-only']) { report('success', `vault sync 완료(pull-only) · ${vault.name}`); return true; }

  // 2) commit
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const message = options.message || `chore: llmwiki vault sync (${stamp})`;
  const commit = gitAddCommit(vault.path, message);
  report('step', commit.committed ? `commit 완료 · ${message}` : '변경 사항 없음 (commit 생략)');

  // 3) push
  if (options['no-push']) { report('success', `vault sync 완료(no-push) · ${vault.name}`); return true; }
  gitPush(vault.path);
  report('success', `vault sync 완료 · ${vault.name} → ${vault.origin}`);
  return true;
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
  if (stdin.isTTY) console.log(renderNote(lines.join('\n'), 'llmwiki · 에이전트 실행 명령'));
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
      console.log(renderNote([
        skill.description || '설명 없음',
        skill.dir,
        ...skill.issues.map((issue) => `⚠ ${issue}`),
      ].join('\n'), skill.name));
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
  if (stdin.isTTY) console.log(renderNote(details, '스킬 상세'));
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
      const backendLabel = vault.backend === 'git' ? `git(${vault.origin})` : 'local';
      if (!status.exists) add('error', vault.name, `경로 없음 · ${vault.path}`);
      else if (vault.backend === 'git' && !isGitRepo(vault.path)) {
        add('warn', vault.name, `git 백엔드지만 git 저장소가 아님 · ${vault.path}`);
      } else if (!status.claude) add('warn', vault.name, `경로 정상 · CLAUDE.md 없음 · ${backendLabel}`);
      else add('success', vault.name, `정상 · ${vault.kind} · ${backendLabel} · index.md ${status.index ? '있음' : '없음'}`);
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

/**
 * 워크스페이스를 준비하고 에이전트를 실행한다. start/new의 공통 런처다.
 * - agentArgs: 에이전트에 그대로 전달할 인자
 * - initialPrompt: 세션 시작 시 주입할 초기 프롬프트. 기본 claude/codex는 마지막 positional
 *   토큰으로 받는다. 커스텀 오버라이드 명령은 이 인자를 안 받을 수 있으므로 주입하지 않고,
 *   대신 사용자가 붙여넣을 수 있게 안내만 출력한다.
 */
async function launchAgent(paths, requestedAgent, { agentArgs = [], initialPrompt } = {}) {
  const workspace = prepareWorkspace(paths);
  const agent = resolveAgent(paths, requestedAgent);
  const { tokens: [command, ...commandArgs], addDir } = resolveAgentCommand(paths, agent);
  const vaultArgs = addDir
    ? readRegistry(paths.registry)
      .filter((vault) => fs.existsSync(vault.path))
      .flatMap((vault) => ['--add-dir', vault.path])
    : [];
  const isDefaultCommand = command === agent;
  // 기본 claude/codex만 trailing positional 프롬프트를 받는다. 오버라이드는 안내만 한다.
  const promptArgs = initialPrompt && isDefaultCommand ? [initialPrompt] : [];
  const label = isDefaultCommand ? agent : `${agent} → ${[command, ...commandArgs].join(' ')}`;
  console.log(`${label} 시작 (workspace: ${workspace})`);
  if (initialPrompt && !isDefaultCommand) {
    console.log(`이 에이전트는 초기 프롬프트 주입을 지원하지 않습니다. 세션에서 아래를 붙여넣으세요:\n${initialPrompt}`);
  }
  const child = runAsync(command, [...commandArgs, ...vaultArgs, ...agentArgs, ...promptArgs], {
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

async function start(paths, requestedAgent, agentArgs = []) {
  return launchAgent(paths, requestedAgent, { agentArgs });
}

/**
 * 에이전트가 실행할 ingest 초기 프롬프트를 만든다.
 * - claude: `.claude/commands/wiki-add.md` 슬래시 명령을 그대로 부른다.
 * - codex: 슬래시 명령이 없으므로 AGENTS.md의 wiki-add 태스크를 자연어로 지시한다.
 */
export function buildIngestPrompt(agent, input) {
  if (agent === 'codex') return `wiki-add 태스크를 실행한다. 입력: ${input}`;
  return `/wiki-add ${input}`;
}

// `llmwiki new <입력>`: 에이전트를 띄우고 ingest 워크플로우를 시작하는 shortcut.
async function startIngest(paths, requestedAgent, inputArgs = []) {
  const input = inputArgs.join(' ').trim();
  if (!input) throw new Error('추가할 입력이 필요합니다.\n사용법: llmwiki new <url|경로|텍스트>');
  const agent = resolveAgent(paths, requestedAgent);
  return launchAgent(paths, agent, { initialPrompt: buildIngestPrompt(agent, input) });
}

// 비-TTY 입력(파이프)을 끝까지 읽는다. `echo ... | llmwiki capture --vault x`를 지원한다.
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

// `llmwiki capture`: 자유 텍스트 메모를 대상 볼트의 raw/notes/에 기록하는 결정론 빠른 캡처.
async function capture(paths, args) {
  ensureRegistry(paths);
  const { options, rest } = parseOptions(args, {
    allowed: ['vault', 'title', 'text'],
    usage: CAPTURE_USAGE,
  });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${CAPTURE_USAGE}`);

  const vaults = readRegistry(paths.registry);
  if (!vaults.length) throw new Error('등록된 볼트가 없습니다. 먼저 `llmwiki vault add`로 볼트를 등록하세요.');

  const resolved = resolveCaptureVault(vaults, options.vault);
  let vault = resolved.vault;
  if (!vault) {
    if (!stdin.isTTY) throw new Error(`대상 볼트를 지정하세요.\n사용법: ${CAPTURE_USAGE}`);
    vault = await chooseVault(vaults, '메모를 저장할 볼트를 선택하세요.');
    if (!vault) return false;
  }
  if (!fs.existsSync(vault.path)) throw new Error(`볼트 경로를 찾을 수 없습니다: ${vault.path}`);

  // 본문: --text > TTY 프롬프트 > 파이프 stdin.
  let body = options.text;
  if (body === undefined) {
    if (stdin.isTTY) {
      const input = await p.text({ message: '메모 내용', placeholder: '자유롭게 입력하세요.' });
      if (cancelPrompt(input)) return false;
      body = input;
    } else {
      body = await readStdin();
    }
  }
  if (!String(body ?? '').trim()) throw new Error('메모 내용이 비어 있습니다.');

  // secure 볼트 쓰기 게이트. 비-TTY에서 --vault 없이 secure로 해소되면 위에서 이미 막힌다.
  if (vault.kind === 'secure') {
    if (!options.vault && !stdin.isTTY) throw new Error('secure 볼트 쓰기는 --vault로 명시해야 합니다.');
    if (stdin.isTTY) {
      p.log.warn('secure 볼트입니다. 고객명·자격증명·내부 URL을 저장하지 말고 사례는 익명화하세요.');
      const accepted = await p.confirm({ message: `${vault.name}(secure)에 메모를 저장할까요?`, initialValue: false });
      if (cancelPrompt(accepted) || !accepted) return false;
    }
  }

  const now = new Date();
  const contents = renderRawNote({
    title: options.title,
    body,
    source: 'capture',
    createdAt: formatTimestamp(now),
  });
  const notePath = writeRawNote(vault.path, rawNoteFilename(now, options.title), contents);

  const message = `메모 저장됨 · ${vault.name} → ${notePath}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);

  // 선택적 ingest 다리 (세 입력 경로 중 유일한 연결). TTY에서만 제안한다.
  if (stdin.isTTY) {
    const ingest = await p.confirm({ message: '지금 이 노트를 ingest 할까요?', initialValue: false });
    if (!cancelPrompt(ingest) && ingest) return startIngest(paths, undefined, [notePath]);
  }
  return true;
}

/**
 * 원격 명령(publish/inbox)이 대상 볼트를 해소한다. positional 이름 우선, 없으면 단일 볼트.
 * 여러 볼트인데 이름이 없으면 TTY에서는 목록에서 선택하게 하고, 비-TTY에서는 에러를 낸다
 * (원격 쓰기는 정확히 한 볼트로 해소한다).
 */
async function resolveRemoteVault(paths, requestedName, usage) {
  ensureRegistry(paths);
  const vaults = readRegistry(paths.registry);
  if (!vaults.length) throw new Error('등록된 볼트가 없습니다. 먼저 `llmwiki vault add`로 볼트를 등록하세요.');
  let { vault, ambiguous } = resolveCaptureVault(vaults, requestedName);
  if (ambiguous) {
    if (!stdin.isTTY) throw new Error(`대상 볼트를 지정하세요.\n사용법: ${usage}`);
    vault = await chooseVault(vaults, '대상 볼트를 선택하세요.');
    if (!vault) return null;
  }
  if (!fs.existsSync(vault.path)) throw new Error(`볼트 경로를 찾을 수 없습니다: ${vault.path}`);
  return vault;
}

/**
 * 원격 설정을 읽고 provider를 해소한다. 설정은 전역 publish.json에서 볼트 이름으로 읽고,
 * provider는 그 엔트리의 provider 값에서 추론한다.
 * kind는 'publish' | 'inbox' — 없으면 해당 기능이 설정되지 않은 것.
 */
function resolveRemote(paths, vault, kind) {
  const config = loadRemoteConfig(paths.publish, vault.name);
  if (!config || !config[kind] || !config[kind].databaseId) {
    throw new Error(`${vault.name} 볼트에 원격 ${kind} 설정이 없습니다. \`llmwiki publish add ${vault.name}\`으로 연결하세요.`);
  }
  return { config, provider: getProvider(config.provider) };
}

export function parseLimit(options) {
  if (options.limit && !/^[1-9]\d*$/.test(String(options.limit))) throw new Error('--limit은 양의 정수여야 합니다.');
  const limit = options.limit ? Number(options.limit) : undefined;
  if (options.limit && !Number.isSafeInteger(limit)) throw new Error('--limit은 양의 안전 정수여야 합니다.');
  return limit;
}

// `llmwiki publish [vault]`: 로컬 위키를 원격(provider)으로 단방향 push해 view를 발행한다.
async function publish(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['limit', 'dry-run'],
    booleans: ['dry-run'],
    usage: PUBLISH_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'publish');

  // secure 볼트는 명시적 allowPublish 없이는 거부하고, TTY에서 확인·익명화 게이트를 거친다.
  if (vault.kind === 'secure') {
    if (!config.allowPublish) {
      throw new Error(`${vault.name}은 secure 볼트입니다. \`llmwiki publish add ${vault.name} --allow-publish\`로 발행을 활성화해야 합니다.`);
    }
    if (stdin.isTTY) {
      p.log.warn(`secure 볼트를 ${provider.name}에 발행합니다. 고객명·자격증명·내부 URL이 익명화됐는지 확인하세요.`);
      const accepted = await p.confirm({ message: `${vault.name}(secure)을 ${provider.name}으로 발행할까요?`, initialValue: false });
      if (cancelPrompt(accepted) || !accepted) return false;
    }
  }

  const dryRun = options['dry-run'] === true;
  const limit = parseLimit(options);

  // 토큰·클라이언트는 dry-run이 아닐 때만 필요하다(오프라인에서 diff 미리보기 가능).
  const client = dryRun
    ? null
    : await provider.createClient(resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }));
  const summary = await pushSync(vault.path, {
    provider,
    client,
    ctx: { databaseId: config.publish.databaseId, titleProp: config.publish.titleProperty },
    subdirs: config.publish.syncedSubdirs || provider.defaultSyncSubdirs,
    dryRun,
    limit,
  });

  const message = dryRun
    ? `[dry-run] ${vault.name} → ${provider.name} · 생성 예정 ${summary.planned.create} · 갱신 예정 ${summary.planned.update} · 변경 없음 ${summary.unchanged}`
    : `publish 완료 · ${vault.name} → ${provider.name} · 생성 ${summary.created} · 갱신 ${summary.updated} · 변경 없음 ${summary.unchanged}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);

  // 첫 발행에서 뷰 탭을 만들었으면 알리고, 실패했으면 발행은 유지한 채 경고만 낸다.
  if (!dryRun && summary.viewsCreated && summary.viewsCreated.length) {
    const note = `뷰 생성 · ${summary.viewsCreated.join(', ')}`;
    if (stdin.isTTY) p.log.success(note); else console.log(note);
  } else if (!dryRun && summary.viewsError) {
    const note = `뷰 생성은 건너뜀 — ${summary.viewsError} (\`llmwiki publish view ${vault.name}\`로 재시도)`;
    if (stdin.isTTY) p.log.warn(note); else console.error(note);
  }

  // 발행 dedup 상태(_meta/remote-map.json)는 git으로 볼트를 따라 이동해 머신·클론 간에
  // 공유돼야 중복 발행을 막는다. 커밋되지 않으면 클론·경로 이동 때 유실돼 전체가 재발행된다.
  // git 백엔드에서 이 파일에 미커밋 변경이 있으면 커밋할지 묻는다(push는 `vault sync`가 담당).
  if (!dryRun && vault.backend === 'git' && isGitRepo(vault.path) && fileHasChanges(vault.path, REMOTE_MAP_FILE)) {
    let commit = stdin.isTTY;
    if (stdin.isTTY) {
      const answer = await p.confirm({
        message: `발행 상태(${REMOTE_MAP_FILE})가 바뀌었습니다. 커밋할까요? (커밋하지 않으면 다음 발행에서 중복될 수 있습니다)`,
        initialValue: true,
      });
      commit = !cancelPrompt(answer) && answer;
    }
    if (commit) {
      const result = gitCommitFile(vault.path, REMOTE_MAP_FILE, `chore: llmwiki publish 상태 갱신 (${vault.name})`);
      const note = result.committed
        ? `발행 상태 커밋 완료 · ${REMOTE_MAP_FILE} (push는 \`llmwiki vault sync ${vault.name}\`)`
        : `발행 상태 변경 없음 (커밋 생략)`;
      if (stdin.isTTY) p.log.success(note); else console.log(note);
    } else {
      const note = `발행 상태(${REMOTE_MAP_FILE})가 커밋되지 않았습니다. 유실되면 중복 발행되니 \`llmwiki vault sync ${vault.name}\`로 커밋·push하세요.`;
      if (stdin.isTTY) p.log.warn(note); else console.error(note);
    }
  }
  return true;
}

// `llmwiki publish view [vault]`: 발행 대상 DB에 뷰 탭(Table/Board/Gallery/List)을 자동 생성한다.
// 발행(publish)과 별개인 초기 1회성 작업이다. @notionhq/client 5.x가 필요하다.
async function publishView(paths, args) {
  const { rest } = parseOptions(args, { allowed: [], usage: PUBLISH_VIEW_USAGE });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${PUBLISH_VIEW_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], PUBLISH_VIEW_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'publish');
  if (typeof provider.createViews !== 'function') {
    throw new Error(`${provider.name} provider는 뷰 자동 생성을 지원하지 않습니다.`);
  }

  const client = await provider.createClient(
    resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }),
  );
  const created = await provider.createViews(client, { databaseId: config.publish.databaseId });

  const message = created.length
    ? `뷰 생성 완료 · ${vault.name} → ${provider.name} · ${created.join(', ')}`
    : `생성된 뷰가 없습니다 · ${vault.name}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
  return true;
}

// `llmwiki inbox pull [vault]`: 원격 inbox의 새 항목을 raw/notes/로 가져온다.
async function inboxPull(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['limit', 'dry-run'],
    booleans: ['dry-run'],
    usage: INBOX_USAGE,
  });
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${INBOX_USAGE}`);

  const vault = await resolveRemoteVault(paths, rest[0], INBOX_USAGE);
  if (!vault) return false;
  const { config, provider } = resolveRemote(paths, vault, 'inbox');

  const dryRun = options['dry-run'] === true;
  const limit = parseLimit(options);

  // dry-run은 읽기 전용이다. 실제 파일 기록은 capture와 같은 secure 쓰기 게이트를 거친다.
  if (!dryRun && vault.kind === 'secure') {
    if (!rest[0] && !stdin.isTTY) throw new Error('secure 볼트 inbox pull은 볼트 이름을 명시해야 합니다.');
    if (stdin.isTTY) {
      p.log.warn('secure 볼트에 원격 inbox 내용을 저장합니다. 고객명·자격증명·내부 URL이 포함되지 않았는지 확인하세요.');
      const accepted = await p.confirm({ message: `${vault.name}(secure)에 inbox 항목을 저장할까요?`, initialValue: false });
      if (cancelPrompt(accepted) || !accepted) return false;
    }
  }

  const client = await provider.createClient(
    resolveRemoteToken(process.env, { prefix: provider.tokenPrefix, vaultName: vault.name, config, secretsPath: paths.secrets, provider: provider.name }),
  );
  const result = await pullInbox(vault.path, {
    provider,
    client,
    ctx: { databaseId: config.inbox.databaseId },
    dryRun,
    limit,
  });

  const message = dryRun
    ? `[dry-run] ${vault.name} ← ${provider.name} · 가져올 항목 ${result.pulled.length} · 이미 있음 ${result.skipped}`
    : `inbox pull 완료 · ${vault.name} ← ${provider.name} · 가져옴 ${result.pulled.length} · 이미 있음 ${result.skipped}`;
  if (stdin.isTTY) p.log.success(message);
  else console.log(message);
  return true;
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

// `llmwiki config export [--output <file>]`: 볼트 레지스트리 + 스킬을 JSON 번들로 내보낸다.
function exportConfig(paths, args) {
  const { options, rest } = parseOptions(args, { allowed: ['output'], usage: CONFIG_EXPORT_USAGE });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${CONFIG_EXPORT_USAGE}`);
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = options.output || `llmwiki-settings-${stamp}.json`;
  const written = writeExportBundle(paths, outFile);
  const message = `설정 export 완료 · ${written} (볼트·스킬 포함, 토큰·에이전트 오버라이드 제외)`;
  if (stdin.isTTY) p.log.success(message); else console.log(message);
  return true;
}

// `llmwiki config import <file> [--vaults-dir <dir>] [--force]`: 번들에서 설정을 복원한다.
async function importConfig(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['vaults-dir', 'force'],
    booleans: ['force'],
    usage: CONFIG_IMPORT_USAGE,
  });
  const file = rest[0];
  if (!file) throw new Error(`가져올 번들 파일이 필요합니다.\n사용법: ${CONFIG_IMPORT_USAGE}`);
  if (rest.length > 1) throw new Error(`알 수 없는 인자: ${rest.slice(1).join(' ')}\n사용법: ${CONFIG_IMPORT_USAGE}`);

  ensureRegistry(paths);
  const bundle = readExportBundle(file);
  const vaultsDir = options['vaults-dir'] || paths.vaultsHome;
  const force = options.force === true;

  // git 볼트 clone은 CLI 계층의 ensureGitVault에 위임한다(settings.js는 git에 의존하지 않음).
  const provisionGitVault = (entry) => ensureGitVault(
    { vaultsHome: vaultsDir },
    { name: entry.name, origin: entry.origin },
  );

  const summary = applyImportBundle(paths, bundle, { force, provisionGitVault });

  const lines = [
    `스킬 복원 ${summary.skills.restored.length}${summary.skills.skipped.length ? ` · 스킵 ${summary.skills.skipped.length}(이미 있음, --force로 덮어쓰기)` : ''}`,
    `git 볼트 clone ${summary.vaults.cloned.length}`,
  ];
  if (summary.vaults.skippedLocal.length) {
    lines.push(`local 볼트 ${summary.vaults.skippedLocal.length}개는 경로를 알 수 없어 등록하지 않았습니다: ${summary.vaults.skippedLocal.join(', ')} (수동 재등록 필요)`);
  }
  for (const fail of summary.vaults.failed) lines.push(`볼트 ${fail.name} 실패: ${fail.reason}`);

  const message = `설정 import 완료\n${lines.join('\n')}`;
  if (stdin.isTTY) p.log.success(message); else console.log(message);
  return true;
}

/**
 * `llmwiki reset [--purge-vaults] [--force]`: 모든 사용자 설정을 지워 setup 이전 상태로 되돌린다.
 * 레지스트리·토큰·발행 설정·커스텀 스킬·워크스페이스를 삭제한다. 등록된 볼트의 실제 파일은
 * 기본적으로 보존하고(레지스트리 엔트리만 사라짐), --purge-vaults면 볼트 디렉터리까지 지운다.
 * configDir/vaultsHome 자체는 지우지 않고 이름을 지정한 파일·개별 볼트 경로만 삭제한다.
 * (agent reset과 무관 — 이건 최상위 명령이다.)
 */
export async function resetConfig(paths, args) {
  const { options, rest } = parseOptions(args, {
    allowed: ['purge-vaults', 'force'],
    booleans: ['purge-vaults', 'force'],
    usage: RESET_USAGE,
  });
  if (rest.length) throw new Error(`알 수 없는 인자: ${rest.join(' ')}\n사용법: ${RESET_USAGE}`);
  const tty = Boolean(stdin.isTTY);
  const purgeVaults = options['purge-vaults'] === true;

  // 삭제 대상 수집. config 파일/디렉터리는 존재하는 것만, 볼트 경로는 purge일 때만.
  // 레지스트리는 깨져 있어도 reset은 진행돼야 하므로 issues는 무시한다(파일이 없으면 빈 목록).
  // .gitignore는 사용자 규칙이 섞여 있을 수 있어 통째로 지우지 않고 아래에서 규칙만 발라낸다.
  const configTargets = [
    { path: paths.registry, recursive: false, label: '볼트 레지스트리' },
    { path: paths.secrets, recursive: false, label: '연결 토큰(secrets.json)' },
    { path: paths.publish, recursive: false, label: '발행 설정(publish.json)' },
    { path: paths.skillsDir, recursive: true, label: '커스텀 스킬' },
    { path: paths.workspace, recursive: true, label: '실행 워크스페이스' },
  ].filter((target) => fs.existsSync(target.path));

  const vaultTargets = purgeVaults
    ? readRegistryFile(paths.registry).vaults
      .filter((vault) => fs.existsSync(vault.path))
      .map((vault) => ({
        path: vault.path,
        recursive: true,
        label: `볼트 파일 · ${vault.name}${vault.backend === 'git' ? ' (git)' : ''}`,
        git: vault.backend === 'git',
      }))
    : [];

  const targets = [...configTargets, ...vaultTargets];
  // .gitignore에 우리 규칙(secrets.json)이 있으면 정리 대상이다(파일 삭제와 별개로 카운트).
  const gitignoreFile = path.join(paths.configDir, '.gitignore');
  const prunesGitignore = fs.existsSync(gitignoreFile)
    && fs.readFileSync(gitignoreFile, 'utf8').split(/\r?\n/).some((row) => row.trim() === 'secrets.json');

  if (!targets.length && !prunesGitignore) {
    const message = '이미 초기 상태입니다 — 지울 설정이 없습니다.';
    if (tty) p.log.info(message); else console.log(message);
    return true;
  }

  // 확인 게이트. TTY는 대상 요약 박스 + 확인, 비-TTY는 --force가 없으면 거부한다.
  const hasGitVault = vaultTargets.some((target) => target.git);
  if (tty) {
    const summaryLines = targets.map((target) => `${target.label} · ${target.path}`);
    if (purgeVaults) {
      summaryLines.push('', '⚠ --purge-vaults: 등록된 볼트의 실제 파일이 영구 삭제됩니다.');
      if (hasGitVault) summaryLines.push('⚠ git 볼트가 포함됩니다 — push하지 않은 커밋은 복구할 수 없습니다.');
    }
    console.log(renderNote(summaryLines.join('\n'), '초기화 대상'));
    const accepted = await p.confirm({ message: '이 항목을 모두 삭제할까요? (되돌릴 수 없습니다)', initialValue: false });
    if (cancelPrompt(accepted) || !accepted) {
      if (accepted === false) p.cancel('초기화하지 않았습니다.');
      return false;
    }
  } else if (options.force !== true) {
    throw new Error(`비대화형 환경에서 설정을 초기화하려면 --force가 필요합니다.\n사용법: ${RESET_USAGE}`);
  }

  for (const target of targets) {
    fs.rmSync(target.path, { recursive: target.recursive, force: true });
  }
  // secrets.json 무시 규칙만 제거한다(사용자가 넣은 다른 규칙은 보존, 남는 게 없으면 파일 삭제).
  const prunedGitignore = pruneSecretsGitignore(paths.configDir);

  const removedCount = targets.length + (prunedGitignore ? 1 : 0);
  const summary = `설정 초기화 완료 · ${removedCount}개 항목 정리${purgeVaults ? ' (볼트 파일 포함)' : ''}\n\`llmwiki setup\`으로 다시 설정하세요.`;
  if (tty) p.log.success(summary); else console.log(summary);
  return true;
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
  if (command === 'reset') {
    if (stdin.isTTY) p.intro('llmwiki · 설정 초기화');
    return resetConfig(paths, rest);
  }
  if (command === 'claude' || command === 'codex') return start(paths, command, rest);
  if (command === 'start') {
    const agent = ['claude', 'codex'].includes(rest[0]) ? rest.shift() : undefined;
    if (rest[0] === '--') rest.shift();
    return start(paths, agent, rest);
  }
  if (command === 'new') {
    const agent = ['claude', 'codex'].includes(rest[0]) ? rest.shift() : undefined;
    return startIngest(paths, agent, rest);
  }
  if (command === 'capture') {
    if (stdin.isTTY) p.intro('llmwiki · 메모 캡처');
    return capture(paths, rest);
  }
  if (command === 'publish') {
    const [action, ...pubArgs] = rest;
    // add/list/remove는 예약 서브명령. 그 외 첫 토큰은 볼트 이름으로 보고 발행 실행에 위임한다.
    if (action === 'add') {
      if (stdin.isTTY) p.intro('llmwiki · 발행 설정');
      return publishAdd(paths, pubArgs);
    }
    if (action === 'list') return publishList(paths, pubArgs);
    if (action === 'remove') {
      if (stdin.isTTY) p.intro('llmwiki · 발행 설정 삭제');
      return publishRemove(paths, pubArgs);
    }
    if (action === 'view') {
      if (stdin.isTTY) p.intro('llmwiki · 뷰 생성');
      return publishView(paths, pubArgs);
    }
    if (stdin.isTTY) p.intro('llmwiki · 원격 발행');
    return publish(paths, rest);
  }
  if (command === 'connection' || command === 'connections') {
    const [action = 'list', ...connArgs] = rest;
    if (action === 'add') {
      if (stdin.isTTY) p.intro('llmwiki · 연결 추가');
      return connectionAdd(paths, connArgs);
    }
    if (action === 'list' || action === 'ls') return connectionList(paths, connArgs);
    if (action === 'remove' || action === 'rm') {
      if (stdin.isTTY) p.intro('llmwiki · 연결 삭제');
      return connectionRemove(paths, connArgs);
    }
    throw new Error('사용법: llmwiki connection <add|list|remove>');
  }
  if (command === 'inbox') {
    const [action, ...inboxArgs] = rest;
    if (action === 'pull') {
      if (stdin.isTTY) p.intro('llmwiki · Notion inbox');
      return inboxPull(paths, inboxArgs);
    }
    throw new Error(`사용법: ${INBOX_USAGE}`);
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
    if (action === 'sync') return syncVault(paths, vaultArgs);
    throw new Error('사용법: llmwiki vault <add|list|show|remove|lint|scaffold|sync>');
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
    const [action, ...configArgs] = rest;
    if (action === 'path') return console.log(paths.registry);
    if (action === 'edit') return editConfig(paths);
    if (action === 'export') return exportConfig(paths, configArgs);
    if (action === 'import') {
      if (stdin.isTTY) p.intro('llmwiki · 설정 가져오기');
      return importConfig(paths, configArgs);
    }
    throw new Error('사용법: llmwiki config <path|edit|export|import>');
  }
  throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
}
