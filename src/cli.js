import fs from 'node:fs';
import path from 'node:path';
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
import { renderNote } from './note.js';
import { pruneSecretsGitignore } from './secrets.js';
import {
  gitAddCommit,
  gitClone,
  gitPullRebase,
  gitPush,
  gitRemoteUrl,
  gitSetRemote,
  hasUpstream,
  isGitAvailable,
  isGitRepo,
} from './git.js';
import { applyImportBundle, readExportBundle, writeExportBundle } from './settings.js';
import {
  publishAdd,
  publishList,
  publishRemove,
  connectionAdd,
  connectionList,
  connectionRemove,
  publish,
  publishView,
  inboxPull,
} from './commands/remote.js';
import {
  VAULT_OPTION_KEYS,
  VAULT_BOOLEAN_KEYS,
  VAULT_ADD_USAGE,
  VAULT_SYNC_USAGE,
  CAPTURE_USAGE,
  CONFIG_EXPORT_USAGE,
  CONFIG_IMPORT_USAGE,
  INBOX_USAGE,
  SKILL_ADD_USAGE,
  RESET_USAGE,
  HELP,
} from './help.js';
import {
  parseOptions,
  runSync,
  runAsync,
  reportIssues,
  cancelPrompt,
  inspectVault,
  ensureRegistry,
  chooseVault,
  chooseName,
  splitCommand,
  openInEditor,
} from './prompts.js';

const IS_WINDOWS = process.platform === 'win32';

// 테스트가 의존하는 공개 표면을 유지한다.
export { parseOptions, splitCommand };
export { configureRemote, publishRemove, connectionAdd, connectionRemove, parseLimit } from './commands/remote.js';

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

  const normalizedPath = normalizeVault({ name, path: vaultPath }).path;
  const status = inspectVault(normalizedPath);
  if (status.exists) {
    p.log.success(`경로 확인 · CLAUDE.md ${status.claude ? '✓' : '–'} · AGENTS.md ${status.agents ? '✓' : '–'} · index.md ${status.index ? '✓' : '–'}`);
  } else {
    p.log.warn('아직 존재하지 않는 경로입니다. 등록은 가능하지만 사용 전에 생성해야 합니다.');
  }

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

  const vault = normalizeVault({ name, path: vaultPath, backend, origin, signals, notes });
  console.log(renderNote([
    `이름    ${vault.name}`,
    `경로    ${vault.path}`,
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
        `${backend} · ${status.exists ? '경로 정상' : '경로 없음'}`,
        vault.path,
        `신호: ${vault.signals || '없음'}`,
      ].join('\n'), vault.name));
    }
    p.outro('상세 정보: llmwiki vault show <name>');
  } else {
    console.table(vaults.map(({ name, path: vaultPath, backend, origin, signals }) => ({ name, backend, origin, path: vaultPath, signals })));
  }
}

async function showVault(paths, name) {
  const { vaults, issues } = readRegistryFile(paths.registry);
  reportIssues(paths.registry, issues);
  let vault;
  if (name) {
    vault = vaults.find((item) => item.name === name);
    if (!vault) throw new Error(`등록되지 않은 볼트입니다: ${name}`);
  } else {
    if (!stdin.isTTY) throw new Error('확인할 볼트 이름이 필요합니다.\n사용법: llmwiki vault show <name>');
    if (!vaults.length) throw new Error('등록된 볼트가 없습니다. 먼저 `llmwiki vault add`로 볼트를 등록하세요.');
    vault = await chooseVault(vaults, '확인할 볼트를 선택하세요.');
    if (!vault) return false;
  }
  const status = inspectVault(vault.path);
  const details = [
    `이름       ${vault.name}`,
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
  return true;
}

async function removeVault(paths, name, { confirm = false } = {}) {
  const vaults = readRegistry(paths.registry);
  let target;
  if (name) {
    target = vaults.find((vault) => vault.name === name);
    if (!target) throw new Error(`등록되지 않은 볼트입니다: ${name}`);
  } else {
    if (!stdin.isTTY) throw new Error('제거할 볼트 이름이 필요합니다.\n사용법: llmwiki vault remove <name>');
    if (!vaults.length) throw new Error('등록된 볼트가 없습니다.');
    target = await chooseVault(vaults, '제거할 볼트를 선택하세요.');
    if (!target) return false;
    name = target.name;
  }

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
  const report = targets.map((vault) => ({ vault: vault.name, path: vault.path, results: lintVault(vault.path) }));

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
      p.intro(`llmwiki vault lint · ${entry.vault}`);
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
  let { vault, ambiguous } = resolveCaptureVault(vaults, rest[0]);
  if (ambiguous) {
    if (!stdin.isTTY) throw new Error(`대상 볼트를 지정하세요.\n사용법: ${VAULT_SYNC_USAGE}`);
    // sync는 git 백엔드만 대상이므로 선택지도 git 볼트로 좁힌다.
    const gitVaults = vaults.filter((item) => item.backend === 'git');
    // 하나도 없으면 이름을 지정했을 때와 같은 info 경로로 흘린다(같은 상황에 같은 심각도).
    if (!gitVaults.length) {
      const message = 'git 백엔드 볼트가 없습니다. sync는 git 백엔드 볼트만 동기화합니다.';
      p.log.info(message);
      return false;
    }
    vault = await chooseVault(gitVaults, '동기화할 볼트를 선택하세요.');
    if (!vault) return false;
  }

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

async function setAgent(paths, name, commandTokens) {
  // 이름을 생략하면 실행 명령도 함께 비어 있다(dispatch가 첫 토큰을 이름으로 잡으므로).
  // 그래서 에이전트만 고르게 하면 곧바로 '실행 명령이 필요합니다'로 끝난다 → 명령까지 물어본다.
  let { command, addDir } = extractAddDirFlag(commandTokens);
  if (!name) {
    if (!stdin.isTTY) throw new Error('설정할 에이전트 이름이 필요합니다.\n사용법: llmwiki agent set <claude|codex> [--add-dir|--no-add-dir] <명령...>');
    const overrides = new Map(readAgents(paths.registry).map((agent) => [agent.name, agent]));
    name = await chooseName(
      SUPPORTED_AGENTS.map((value) => ({ value, hint: overrides.get(value) ? `현재: ${overrides.get(value).command}` : '기본값' })),
      '설정할 에이전트를 선택하세요.',
    );
    if (!name) return;
    if (!command.length) {
      const entered = await p.text({
        message: `${name}을 실행할 명령`,
        placeholder: name === 'codex' ? 'dbexec repo run isaac' : 'vibe agent',
        validate(value) { if (!value.trim()) return '실행 명령을 입력하세요.'; },
      });
      if (cancelPrompt(entered)) return;
      command = splitCommand(entered.trim());
    }
  }
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

async function resetAgent(paths, name) {
  if (!name) {
    if (!stdin.isTTY) throw new Error('초기화할 에이전트 이름이 필요합니다.\n사용법: llmwiki agent reset <claude|codex>');
    // 커스텀 설정이 있는 에이전트만 초기화 대상이다.
    const overrides = readAgents(paths.registry).map((agent) => agent.name);
    if (!overrides.length) throw new Error('커스텀 설정된 에이전트가 없습니다. 이미 모두 기본값입니다.');
    name = await chooseName(overrides.map((value) => ({ value })), '초기화할 에이전트를 선택하세요.');
    if (!name) return;
  }
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

/**
 * 스킬 이름을 해소한다. 이름이 있으면 그대로 검증하고, 없으면 TTY에서 목록으로 고르게 한다.
 * verb는 프롬프트·에러 문구에 쓰는 동작 이름('확인할' 등). 취소하면 null.
 */
async function resolveSkillName(paths, name, verb, usage) {
  if (name) {
    if (!fs.existsSync(skillDir(paths.skillsDir, name))) throw new Error(`등록되지 않은 스킬입니다: ${name}`);
    return name;
  }
  if (!stdin.isTTY) throw new Error(`${verb} 스킬 이름이 필요합니다.\n사용법: ${usage}`);
  const skills = listSkills(paths.skillsDir);
  if (!skills.length) throw new Error('등록된 커스텀 스킬이 없습니다. `llmwiki skill add <name>`으로 만드세요.');
  return chooseName(
    skills.map((skill) => ({ value: skill.name, hint: skill.description || undefined })),
    `${verb} 스킬을 선택하세요.`,
  );
}

async function showSkill(paths, name) {
  const target = await resolveSkillName(paths, name, '확인할', 'llmwiki skill show <name>');
  if (!target) return false;
  const dir = skillDir(paths.skillsDir, target);
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
  return true;
}

async function editSkill(paths, name) {
  const target = await resolveSkillName(paths, name, '편집할', 'llmwiki skill edit <name>');
  if (!target) return false;
  const file = path.join(skillDir(paths.skillsDir, target), SKILL_FILE);
  // 디렉터리는 있지만 SKILL.md가 없는 스킬도 목록에 나온다(listSkills는 디렉터리만 본다).
  // 목록에서 방금 고른 이름을 "등록되지 않았다"고 하면 모순이므로 실제 원인을 알린다.
  if (!fs.existsSync(file)) throw new Error(`${target} 스킬에 ${SKILL_FILE}가 없습니다: ${file}`);
  openInEditor(file);
  return true;
}

async function removeSkillCommand(paths, name) {
  const target = await resolveSkillName(paths, name, '삭제할', 'llmwiki skill remove <name>');
  if (!target) return false;
  const dir = skillDir(paths.skillsDir, target);
  if (stdin.isTTY) {
    const accepted = await p.confirm({ message: `${target} 스킬을 삭제할까요? (${dir})`, initialValue: false });
    if (cancelPrompt(accepted) || !accepted) return false;
  }
  removeSkillDir(paths.skillsDir, target);
  const message = `삭제됨 · ${target}`;
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
      else add('success', vault.name, `정상 · ${backendLabel} · index.md ${status.index ? '있음' : '없음'}`);
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
