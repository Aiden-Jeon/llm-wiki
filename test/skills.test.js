import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSkill,
  lintSkill,
  listSkills,
  parseSkillFrontmatter,
  readSkill,
  removeSkill,
  renderCommandStub,
  renderSkillsCatalog,
  validateSkillName,
} from '../src/skills.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-skills-'));
}

/** lintSkill 결과를 레벨별 label 집합으로 압축한다(문구 변경에 덜 민감한 단정). */
function findings(dir, level) {
  return lintSkill(dir).filter((result) => result.level === level).map((result) => result.label);
}

// 계약을 만족하는 최소 SKILL.md. 각 테스트는 여기서 한 항목만 무너뜨린다.
function validSkill(name = 'weekly-retro') {
  return `---
name: ${name}
description: 위키 log.md를 근거로 주간 회고 초안을 만든다. "주간 회고", "이번 주 정리"라고 말할 때 사용한다.
---

# Weekly Retro

대상 볼트에 쌓인 기록을 근거로 회고 초안을 만든다. 대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.

## 입력

기간(기본 최근 7일)과 관점을 확인한다. 모호하면 질문한다.

## 근거 소스

대상 볼트의 \`log.md\`와 기간 내 변경 페이지를 읽는다.

## 워크플로우

1. 기간·관점 확인.
2. 근거 읽기.
3. 초안 생성 후 채팅 출력.

## 주의

- 근거에 없는 성과를 만들지 않는다.
`;
}

function writeSkill(name, content) {
  const dir = path.join(tmpDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  return dir;
}

test('parseSkillFrontmatter reads quoted and colon-containing values', () => {
  const { fields, body } = parseSkillFrontmatter('---\nname: demo\ndescription: "a: b, c"\n---\n\n# Demo\n');
  assert.equal(fields.name, 'demo');
  assert.equal(fields.description, 'a: b, c');
  assert.equal(body, '# Demo');
});

test('validateSkillName rejects reserved and malformed names', () => {
  assert.equal(validateSkillName('linkedin-draft'), 'linkedin-draft');
  assert.throws(() => validateSkillName('wiki-add'), /\ub0b4\uc7a5 \uba85\ub839/);
  assert.throws(() => validateSkillName('wiki-lint'), /\ub0b4\uc7a5 \uba85\ub839/);
  assert.throws(() => validateSkillName('Bad Name'), /\uc18c\ubb38\uc790/);
});

test('createSkill scaffolds a skill and refuses to overwrite without --force', () => {
  const skillsDir = tmpDir();
  const { dir, existed } = createSkill(skillsDir, { name: 'weekly-retro', description: '\uc8fc\uac04 \ud68c\uace0\ub97c \uc0dd\uc131\ud55c\ub2e4.' });
  assert.equal(existed, false);

  const skill = readSkill(dir);
  assert.equal(skill.name, 'weekly-retro');
  assert.equal(skill.description, '\uc8fc\uac04 \ud68c\uace0\ub97c \uc0dd\uc131\ud55c\ub2e4.');
  assert.deepEqual(skill.issues, []);

  assert.throws(() => createSkill(skillsDir, { name: 'weekly-retro' }), /--force/);
  assert.equal(createSkill(skillsDir, { name: 'weekly-retro', force: true }).existed, true);
});

test('createSkill quotes YAML-significant descriptions', () => {
  const skillsDir = tmpDir();
  const description = 'trigger: weekly\nUse "notes" \\ safely';
  const { dir } = createSkill(skillsDir, { name: 'yaml-safe', description });

  assert.equal(readSkill(dir).description, description);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /description: "trigger: weekly\\nUse \\"notes\\" \\\\ safely"/);
});

test('createSkill imports a directory and aligns frontmatter name', () => {
  const source = path.join(tmpDir(), 'origin');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: origin\ndescription: \uac00\uc838\uc628 \uc2a4\ud0ac.\n---\n\n\ubcf8\ubb38\n');
  fs.writeFileSync(path.join(source, 'reference.md'), 'extra');

  const skillsDir = tmpDir();
  const { dir } = createSkill(skillsDir, { name: 'imported', from: source });
  const skill = readSkill(dir);
  assert.deepEqual(skill.issues, []);
  assert.equal(skill.description, '\uac00\uc838\uc628 \uc2a4\ud0ac.');
  assert.ok(fs.existsSync(path.join(dir, 'reference.md')));
});

test('createSkill validates import sources before creating the destination', () => {
  const skillsDir = tmpDir();
  const missing = path.join(tmpDir(), 'missing');
  assert.throws(() => createSkill(skillsDir, { name: 'missing-source', from: missing }), /찾을 수 없습니다/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'missing-source')), false);

  const invalid = tmpDir();
  assert.throws(() => createSkill(skillsDir, { name: 'invalid-source', from: invalid }), /SKILL\.md이 없습니다/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'invalid-source')), false);
});

test('createSkill refuses to force-import a skill from its own destination', () => {
  const skillsDir = tmpDir();
  const { dir } = createSkill(skillsDir, { name: 'same', description: 'keep me' });
  assert.throws(() => createSkill(skillsDir, { name: 'same', from: dir, force: true }), /가져올 경로와 대상/);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /keep me/);
});

test('readSkill reports missing description and name mismatch', () => {
  const skillsDir = tmpDir();
  const dir = path.join(skillsDir, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: other\n---\n\nbody\n');
  const skill = readSkill(dir);
  assert.equal(skill.issues.length, 2);
});

test('listSkills skips non-skill entries and sorts by name', () => {
  const skillsDir = tmpDir();
  createSkill(skillsDir, { name: 'zeta', description: 'z' });
  createSkill(skillsDir, { name: 'alpha', description: 'a' });
  fs.writeFileSync(path.join(skillsDir, 'notes.md'), 'loose file');
  assert.deepEqual(listSkills(skillsDir).map((skill) => skill.name), ['alpha', 'zeta']);

  removeSkill(skillsDir, 'alpha');
  assert.deepEqual(listSkills(skillsDir).map((skill) => skill.name), ['zeta']);
  assert.throws(() => removeSkill(skillsDir, 'alpha'), /\ub4f1\ub85d\ub418\uc9c0 \uc54a\uc740/);
});

test('lintSkill passes a skill that satisfies the contract', () => {
  const dir = writeSkill('weekly-retro', validSkill());
  assert.deepEqual(lintSkill(dir).map((result) => result.level), ['success']);
});

test('lintSkill reports a missing SKILL.md instead of throwing', () => {
  const dir = path.join(tmpDir(), 'empty');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(findings(dir, 'error'), ['파일']);
});

test('lintSkill rejects the unedited scaffold so scaffolding alone never passes', () => {
  const skillsDir = tmpDir();
  const { dir } = createSkill(skillsDir, { name: 'fresh' });
  const errors = findings(dir, 'error');
  assert.ok(errors.includes('description'), `expected description error, got ${errors.join(',')}`);
  assert.ok(errors.includes('본문'), `expected body error, got ${errors.join(',')}`);
});

test('lintSkill requires frontmatter name to match the directory', () => {
  const dir = writeSkill('weekly-retro', validSkill('other-name'));
  assert.deepEqual(findings(dir, 'error'), ['frontmatter']);
});

test('lintSkill flags reserved names that workspace sync would skip', () => {
  const dir = writeSkill('skill-author', validSkill('skill-author'));
  assert.deepEqual(findings(dir, 'error'), ['이름']);
});

test('lintSkill requires the evidence and workflow sections', () => {
  const dir = writeSkill('thin', validSkill('thin').replace(/## 근거 소스[\s\S]*?## 워크플로우/, '## 워크플로우'));
  assert.deepEqual(findings(dir, 'error'), ['섹션']);
});

test('lintSkill warns on a description with no trigger phrases', () => {
  const dir = writeSkill('vague', validSkill('vague').replace(/description: .*/, 'description: 대상 볼트의 기록을 모아 주간 회고 초안을 만드는 스킬이다. 기간과 관점을 확인한 뒤 초안을 생성한다.'));
  assert.deepEqual(findings(dir, 'error'), []);
  assert.deepEqual(findings(dir, 'warn'), ['description']);
});

test('lintSkill accepts 디스패처 in place of 입력', () => {
  const dir = writeSkill('dispatch', validSkill('dispatch').replace('## 입력', '## 디스패처'));
  assert.deepEqual(lintSkill(dir).map((result) => result.level), ['success']);
});

// 계약(lintSkill)과 배포되는 템플릿이 어긋나면 사용자가 만든 첫 스킬부터 경고를 본다.
test('bundled skill templates satisfy the contract they are examples of', () => {
  const templatesDir = path.join(import.meta.dirname, '..', 'templates', 'skills');
  const names = fs.readdirSync(templatesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(names.length, 'expected at least one bundled template');
  for (const entry of names) {
    const results = lintSkill(path.join(templatesDir, entry.name));
    const problems = results.filter((result) => result.level === 'error' || result.level === 'warn');
    assert.deepEqual(problems, [], `${entry.name}: ${problems.map((problem) => `${problem.label}: ${problem.detail}`).join(' / ')}`);
  }
});

test('lintSkill warns on machine-dependent absolute paths', () => {
  const dir = writeSkill('hardcoded', validSkill('hardcoded').replace('`log.md`', '`/Users/someone/vaults/personal/log.md`'));
  assert.deepEqual(findings(dir, 'warn'), ['이식성']);
});

test('renderCommandStub quotes descriptions so frontmatter stays valid YAML', () => {
  const stub = renderCommandStub({ name: 'demo', description: 'A: b "c". \ub2e4\uc74c \ubb38\uc7a5\uc740 \ubb34\uc2dc\ud55c\ub2e4.' });
  assert.match(stub, /^---\ndescription: "A: b \\"c\\."?/);
  assert.match(stub, /\.claude\/skills\/demo\/SKILL\.md/);
  assert.match(stub, /\$ARGUMENTS/);
});

test('renderSkillsCatalog escapes table separators and handles empty state', () => {
  assert.match(renderSkillsCatalog([]), /llmwiki skill new/);
  const catalog = renderSkillsCatalog([{ name: 'demo', description: 'a | b' }]);
  assert.match(catalog, /\| demo \| `\/demo` · `demo` \| a \\\| b \|/);
});
