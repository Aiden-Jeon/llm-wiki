import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSkill,
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

test('parseSkillFrontmatter reads quoted and colon-containing values', () => {
  const { fields, body } = parseSkillFrontmatter('---\nname: demo\ndescription: "a: b, c"\n---\n\n# Demo\n');
  assert.equal(fields.name, 'demo');
  assert.equal(fields.description, 'a: b, c');
  assert.equal(body, '# Demo');
});

test('validateSkillName rejects reserved and malformed names', () => {
  assert.equal(validateSkillName('linkedin-draft'), 'linkedin-draft');
  assert.throws(() => validateSkillName('wiki-add'), /\ub0b4\uc7a5 \uba85\ub839/);
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

test('renderCommandStub quotes descriptions so frontmatter stays valid YAML', () => {
  const stub = renderCommandStub({ name: 'demo', description: 'A: b "c". \ub2e4\uc74c \ubb38\uc7a5\uc740 \ubb34\uc2dc\ud55c\ub2e4.' });
  assert.match(stub, /^---\ndescription: "A: b \\"c\\."?/);
  assert.match(stub, /\.claude\/skills\/demo\/SKILL\.md/);
  assert.match(stub, /\$ARGUMENTS/);
});

test('renderSkillsCatalog escapes table separators and handles empty state', () => {
  assert.match(renderSkillsCatalog([]), /llmwiki skill add/);
  const catalog = renderSkillsCatalog([{ name: 'demo', description: 'a | b' }]);
  assert.match(catalog, /\| demo \| `\/demo` · `demo` \| a \\\| b \|/);
});
