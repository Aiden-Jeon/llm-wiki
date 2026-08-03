import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// git backend 볼트를 위한 얇은 git CLI 래퍼. 시스템 git을 subprocess로 호출한다.
// 코어 CLI는 git에 의존하지 않으며, git backend 명령을 쓸 때만 필요하다.
// 각 함수는 { ok, stdout, stderr, status }를 돌려주거나(관찰용), 실패 시 명확한 에러를 던진다.

const IS_WINDOWS = process.platform === 'win32';

// git을 실행하고 결과를 정규화한다. cwd는 대상 저장소.
function git(args, { cwd } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Windows에서 git은 .exe라 shell 없이 실행되지만, PATH 탐색을 위해 shell을 켠다.
    shell: IS_WINDOWS,
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('git이 필요합니다. git을 설치한 뒤 다시 시도하세요.');
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

// 실패 시 stderr를 담은 에러를 던진다.
function gitOrThrow(args, { cwd, action } = {}) {
  const result = git(args, { cwd });
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `상태 코드 ${result.status}`;
    throw new Error(`git ${action || args[0]} 실패: ${detail}`);
  }
  return result;
}

export function isGitAvailable() {
  try {
    return git(['--version']).ok;
  } catch {
    return false;
  }
}

// 디렉터리가 git 작업 트리인지 확인한다(.git 존재 + rev-parse 성공).
export function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  return git(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).ok;
}

// origin 원격 URL을 돌려준다. 없으면 빈 문자열.
export function gitRemoteUrl(dir) {
  const result = git(['remote', 'get-url', 'origin'], { cwd: dir });
  return result.ok ? result.stdout : '';
}

// origin을 dest로 clone한다. 상위 디렉터리를 만들어 둔다.
export function gitClone(origin, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return gitOrThrow(['clone', origin, dest], { action: 'clone' });
}

// 원격 변경을 rebase로 당겨온다. 로컬 변경은 autostash로 잠시 치운다.
export function gitPullRebase(dir) {
  return gitOrThrow(['pull', '--rebase', '--autostash'], { cwd: dir, action: 'pull' });
}

// 작업 트리에 커밋할 변경이 있는지.
export function hasChanges(dir) {
  return gitStatusPorcelain(dir).length > 0;
}

// porcelain 상태 문자열(빈 문자열이면 깨끗함).
export function gitStatusPorcelain(dir) {
  return gitOrThrow(['status', '--porcelain'], { cwd: dir, action: 'status' }).stdout;
}

/**
 * 모든 변경을 스테이징하고 커밋한다. 변경이 없으면 커밋하지 않고 { ok, committed: false }.
 */
export function gitAddCommit(dir, message) {
  if (!hasChanges(dir)) return { ok: true, committed: false };
  gitOrThrow(['add', '-A'], { cwd: dir, action: 'add' });
  gitOrThrow(['commit', '-m', message], { cwd: dir, action: 'commit' });
  return { ok: true, committed: true };
}

export function gitPush(dir) {
  return gitOrThrow(['push'], { cwd: dir, action: 'push' });
}
