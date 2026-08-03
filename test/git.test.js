import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitAddCommit, gitClone, gitPullRebase } from '../src/git.js';
import * as gitmod from '../src/git.js';

const HAS_GIT = gitmod.isGitAvailable();

function run(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llmwiki-${prefix}-`));
}

// 커밋을 받을 수 있는 bare 원격 + 초기 커밋이 담긴 작업 저장소를 만든다.
function seedRemote() {
  const root = tmp('git');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  run(['init', '--bare', remote]);
  run(['clone', remote, seed]);
  run(['-C', seed, 'config', 'user.email', 'test@example.com']);
  run(['-C', seed, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(seed, 'index.md'), '# seed\n');
  run(['-C', seed, 'add', '-A']);
  run(['-C', seed, 'commit', '-m', 'init']);
  // 기본 브랜치 이름에 관계없이 현재 브랜치를 push.
  run(['-C', seed, 'push', 'origin', 'HEAD']);
  return { root, remote };
}

test('isGitRepo / gitRemoteUrl detect a cloned repo', { skip: !HAS_GIT }, () => {
  const { remote } = seedRemote();
  const dest = tmp('clone');
  fs.rmSync(dest, { recursive: true, force: true });
  gitClone(remote, dest);
  assert.ok(gitmod.isGitRepo(dest));
  assert.equal(gitmod.gitRemoteUrl(dest), remote);
  assert.ok(!gitmod.isGitRepo(tmp('empty')));
});

test('gitAddCommit skips when there are no changes', { skip: !HAS_GIT }, () => {
  const { remote } = seedRemote();
  const dest = tmp('clone2');
  fs.rmSync(dest, { recursive: true, force: true });
  gitClone(remote, dest);
  run(['-C', dest, 'config', 'user.email', 'test@example.com']);
  run(['-C', dest, 'config', 'user.name', 'Test']);
  const result = gitAddCommit(dest, 'noop');
  assert.equal(result.committed, false);
});

test('clone → edit → commit → push → pull round-trips content', { skip: !HAS_GIT }, () => {
  const { remote } = seedRemote();

  // 머신 A: clone, 편집, commit, push.
  const a = tmp('a');
  fs.rmSync(a, { recursive: true, force: true });
  gitClone(remote, a);
  run(['-C', a, 'config', 'user.email', 'a@example.com']);
  run(['-C', a, 'config', 'user.name', 'A']);
  fs.writeFileSync(path.join(a, 'note.md'), 'hello from A\n');
  const committed = gitAddCommit(a, 'add note');
  assert.equal(committed.committed, true);
  gitmod.gitPush(a);

  // 머신 B: clone 후 A의 변경이 보여야 한다.
  const b = tmp('b');
  fs.rmSync(b, { recursive: true, force: true });
  gitClone(remote, b);
  assert.equal(fs.readFileSync(path.join(b, 'note.md'), 'utf8'), 'hello from A\n');

  // B가 pull --rebase 해도 깨지지 않는다(변경 없음).
  run(['-C', b, 'config', 'user.email', 'b@example.com']);
  run(['-C', b, 'config', 'user.name', 'B']);
  assert.ok(gitPullRebase(b).ok);
});
