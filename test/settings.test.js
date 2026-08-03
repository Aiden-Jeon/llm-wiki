import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../src/paths.js';
import { writeRegistry, readRegistry } from '../src/registry.js';
import { createSkill, listSkills } from '../src/skills.js';
import {
  applyImportBundle,
  buildExportBundle,
  readExportBundle,
  writeExportBundle,
} from '../src/settings.js';

function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-settings-'));
  return getPaths({
    LLM_WIKI_CONFIG_HOME: path.join(root, 'config'),
    LLM_WIKI_DATA_HOME: path.join(root, 'data'),
    LLM_WIKI_VAULTS_HOME: path.join(root, 'vaults'),
  });
}

test('buildExportBundle includes vaults (no path) and skills, excludes agents/tokens', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [
    { name: 'gwiki', path: '/tmp/gwiki', kind: 'open', backend: 'git', origin: 'git@x:y.git' },
    { name: 'local', path: '/tmp/local', kind: 'secure' },
  ], [{ name: 'claude', command: 'vibe agent', addDir: false }]);
  createSkill(paths.skillsDir, { name: 'weekly-retro', description: '주간 회고' });

  const bundle = buildExportBundle(paths);
  assert.equal(bundle.version, 1);
  const git = bundle.vaults.find((v) => v.name === 'gwiki');
  assert.equal(git.origin, 'git@x:y.git');
  assert.equal(git.backend, 'git');
  assert.equal(git.path, undefined); // path는 번들에 없다
  assert.ok(!('agents' in bundle)); // 에이전트 오버라이드 제외
  const skill = bundle.skills.find((s) => s.name === 'weekly-retro');
  assert.ok(skill.files.some((f) => f.path === 'SKILL.md' && /주간 회고/.test(f.content)));
});

test('writeExportBundle then readExportBundle round-trips', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'a', path: '/tmp/a', kind: 'open' }]);
  const out = path.join(os.tmpdir(), `bundle-${Date.now()}.json`);
  writeExportBundle(paths, out);
  const bundle = readExportBundle(out);
  assert.equal(bundle.vaults[0].name, 'a');
});

test('readExportBundle rejects bad version and missing file', () => {
  const bad = path.join(os.tmpdir(), `bad-${Date.now()}.json`);
  fs.writeFileSync(bad, JSON.stringify({ version: 999 }));
  assert.throws(() => readExportBundle(bad), /지원하지 않는 번들 버전/);
  assert.throws(() => readExportBundle('/no/such/file.json'), /찾을 수 없습니다/);
});

test('applyImportBundle restores skills and clones git vaults via the provisioner', () => {
  const src = tmpPaths();
  createSkill(src.skillsDir, { name: 'weekly-retro', description: '회고' });
  writeRegistry(src.registry, [
    { name: 'gwiki', path: '/tmp/gwiki', kind: 'open', backend: 'git', origin: 'git@x:y.git' },
    { name: 'localonly', path: '/tmp/localonly', kind: 'open' },
  ]);
  const bundle = buildExportBundle(src);

  const dest = tmpPaths();
  const cloned = [];
  const provisionGitVault = (entry) => {
    // clone을 스텁: 대상 디렉터리만 만들고 경로/URL을 돌려준다.
    const p = path.join(dest.vaultsHome, entry.name);
    fs.mkdirSync(p, { recursive: true });
    cloned.push(entry.name);
    return { path: p, origin: entry.origin };
  };

  const summary = applyImportBundle(dest, bundle, { provisionGitVault });
  assert.deepEqual(summary.skills.restored, ['weekly-retro']);
  assert.deepEqual(summary.vaults.cloned, ['gwiki']);
  assert.deepEqual(summary.vaults.skippedLocal, ['localonly']);
  assert.deepEqual(cloned, ['gwiki']);

  // 스킬이 실제로 복원됐고, git 볼트가 레지스트리에 등록됐다.
  assert.deepEqual(listSkills(dest.skillsDir).map((s) => s.name), ['weekly-retro']);
  const vaults = readRegistry(dest.registry);
  assert.deepEqual(vaults.map((v) => v.name), ['gwiki']);
  assert.equal(vaults[0].backend, 'git');
  assert.equal(vaults[0].path, path.join(dest.vaultsHome, 'gwiki'));
});

test('applyImportBundle skips existing skills unless force', () => {
  const dest = tmpPaths();
  createSkill(dest.skillsDir, { name: 'dup', description: '기존' });
  const bundle = {
    version: 1,
    vaults: [],
    skills: [{ name: 'dup', files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: dup\ndescription: 새것\n---\n' }] }],
  };

  const skipped = applyImportBundle(dest, bundle, {});
  assert.deepEqual(skipped.skills.skipped, ['dup']);
  assert.match(fs.readFileSync(path.join(dest.skillsDir, 'dup', 'SKILL.md'), 'utf8'), /기존/);

  const forced = applyImportBundle(dest, bundle, { force: true });
  assert.deepEqual(forced.skills.restored, ['dup']);
  assert.match(fs.readFileSync(path.join(dest.skillsDir, 'dup', 'SKILL.md'), 'utf8'), /새것/);
});
