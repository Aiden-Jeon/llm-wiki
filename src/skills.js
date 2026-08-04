import fs from 'node:fs';
import path from 'node:path';

export const SKILL_FILE = 'SKILL.md';
// 내장 명령과 이름이 겹치면 워크스페이스에서 서로를 덮어쓴다(.claude/commands/와 1:1).
export const RESERVED_SKILL_NAMES = ['wiki-add', 'wiki-search', 'wiki-use', 'wiki-lint', 'skill-author'];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validateSkillName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('스킬 이름이 필요합니다.');
  if (!NAME_PATTERN.test(name)) {
    throw new Error('스킬 이름은 소문자/숫자로 시작하고 소문자, 숫자, - 만 사용할 수 있습니다.');
  }
  if (RESERVED_SKILL_NAMES.includes(name)) {
    throw new Error(`내장 명령과 같은 이름은 사용할 수 없습니다: ${name}`);
  }
  return name;
}

/**
 * SKILL.md 프론트매터에서 name/description만 읽는다. YAML 파서를 넣지 않고
 * `key: value` 한 줄 형식(따옴표 허용)만 지원한다 — skill 규격이 그 이상을 요구하지 않는다.
 */
export function parseSkillFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (!match) return { fields: {}, body: content.trim() };

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { fields, body: content.slice(match[0].length).trim() };
}

export function readSkill(dir) {
  const name = path.basename(dir);
  const file = path.join(dir, SKILL_FILE);
  const issues = [];
  if (!fs.existsSync(file)) {
    return { name, dir, file, description: '', issues: [`${SKILL_FILE} 파일이 없습니다.`] };
  }

  const { fields } = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!fields.description) issues.push('프론트매터에 description이 없습니다. 에이전트가 스킬을 언제 쓸지 판단할 수 없습니다.');
  if (fields.name && fields.name !== name) issues.push(`프론트매터 name(${fields.name})이 디렉터리 이름(${name})과 다릅니다.`);
  if (RESERVED_SKILL_NAMES.includes(name)) issues.push('내장 명령과 이름이 겹칩니다. 다른 이름으로 바꾸세요.');
  if (!NAME_PATTERN.test(name)) issues.push('스킬 이름은 소문자/숫자와 - 만 사용할 수 있습니다.');

  return { name, dir, file, description: fields.description ?? '', issues };
}

// SKILL.md 계약. `templates/skills/`의 스켈레톤과 `.claude/commands/skill-author.md`가 같은
// 계약을 만족시켜야 하므로 검사 목록을 여기 한곳에만 둔다(드리프트 방지).
// 각 항목은 동등한 대안 제목의 배열이다. 입력 해소를 '디스패처'로 쓰는 스킬처럼
// 표현이 달라도 계약을 만족하는 경우를 허용한다.
export const SKILL_REQUIRED_SECTIONS = [['근거 소스'], ['워크플로우']];
export const SKILL_RECOMMENDED_SECTIONS = [['입력', '디스패처'], ['주의']];
// 설명이 이보다 짧으면 에이전트가 "언제 이 스킬을 쓸지" 판단할 근거가 되지 못한다.
const DESCRIPTION_MIN_LENGTH = 40;
// 본문이 이보다 짧으면 실행 가능한 워크플로우라기보다 제목 모음이다.
const BODY_MIN_LENGTH = 200;
// 스켈레톤은 모든 지시문에 TODO를 달아 두므로, 편집 전 스킬을 결정론적으로 걸러낼 수 있다.
const PLACEHOLDER_PATTERN = /TODO|FIXME/i;
// 머신 의존 경로. 볼트 경로는 레지스트리에서 해소해야 하며 스킬에 박으면 다른 머신에서 깨진다.
const ABSOLUTE_PATH_PATTERN = /(^|[\s`(])(\/Users\/|\/home\/|~\/|[A-Z]:\\)/m;

function bodySections(body) {
  return [...body.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((match) => match[1]);
}

/**
 * 스킬 하나를 SKILL.md 계약에 대해 검사한다. `lintVault`와 같은 {level, label, detail}
 * 배열을 돌려주고 표시는 호출자(cli.js)가 담당한다.
 * level: error(실행을 막는 위반) · warn(품질 휴리스틱) · success · info.
 */
export function lintSkill(dir) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });
  const name = path.basename(dir);
  const file = path.join(dir, SKILL_FILE);

  if (!fs.existsSync(file)) {
    add('error', '파일', `${SKILL_FILE}이 없습니다: ${file}`);
    return results;
  }

  // 1. 이름 (error) — 워크스페이스 동기화가 이 이름으로 슬래시 명령을 만든다.
  if (!NAME_PATTERN.test(name)) add('error', '이름', `소문자/숫자와 - 만 사용할 수 있습니다: ${name}`);
  if (RESERVED_SKILL_NAMES.includes(name)) add('error', '이름', `내장 명령과 겹칩니다: ${name} (동기화 시 생략됨)`);

  const content = fs.readFileSync(file, 'utf8');
  const { fields, body } = parseSkillFrontmatter(content);

  // 2. frontmatter (error) — 에이전트가 스킬을 발견·선택하는 유일한 표면이다.
  if (!/^---\r?\n/.test(content)) {
    add('error', 'frontmatter', 'frontmatter가 없습니다. `---` 블록에 name·description이 필요합니다.');
  }
  if (!fields.name) add('error', 'frontmatter', 'name이 없습니다.');
  else if (fields.name !== name) add('error', 'frontmatter', `name(${fields.name})이 디렉터리 이름(${name})과 다릅니다.`);

  const description = (fields.description ?? '').trim();
  if (!description) {
    add('error', 'frontmatter', 'description이 없습니다. 에이전트가 스킬을 언제 쓸지 판단할 수 없습니다.');
  } else {
    if (PLACEHOLDER_PATTERN.test(description)) add('error', 'description', `플레이스홀더가 남아 있습니다: ${description.slice(0, 60)}…`);
    if (description.length < DESCRIPTION_MIN_LENGTH) {
      add('warn', 'description', `너무 짧습니다(${description.length}자). 무엇을 하는지 + 어떤 발화에서 트리거되는지 적으세요.`);
    }
    // 트리거 발화 인용이 없으면 라우터가 유사 요청을 이 스킬로 연결하지 못한다.
    if (!/["'“”][^"'“”]{2,}["'“”]/.test(description)) {
      add('warn', 'description', '트리거 발화 예시가 없습니다. 사용자가 실제로 말할 표현을 인용으로 넣으세요.');
    }
  }

  // 3. 본문 계약 (error/warn)
  const sections = bodySections(body);
  const has = (titles) => titles.some((title) => sections.some((section) => section.includes(title)));
  const label = (titles) => titles.map((title) => `## ${title}`).join(' 또는 ');
  for (const titles of SKILL_REQUIRED_SECTIONS) {
    if (!has(titles)) add('error', '섹션', `필수 섹션 없음: ${label(titles)}`);
  }
  for (const titles of SKILL_RECOMMENDED_SECTIONS) {
    if (!has(titles)) add('warn', '섹션', `권장 섹션 없음: ${label(titles)}`);
  }
  if (body.length < BODY_MIN_LENGTH) add('warn', '본문', `본문이 ${body.length}자입니다. 실행 가능한 워크플로우로 보기 어렵습니다.`);
  if (PLACEHOLDER_PATTERN.test(body)) add('error', '본문', '템플릿 플레이스홀더가 남아 있습니다. 실제 워크플로우로 채우세요.');

  // 4. 이식성 (warn) — 경로·볼트는 레지스트리에서 해소해야 한다.
  if (ABSOLUTE_PATH_PATTERN.test(body)) {
    add('warn', '이식성', '머신 의존 절대 경로가 있습니다. 볼트 경로는 레지스트리(wikis.local.md)로 해소하세요.');
  }
  if (!/WIKI-CLI\.md|볼트/.test(body)) {
    add('warn', '라우팅', '대상 볼트를 어떻게 해소하는지 적혀 있지 않습니다. `WIKI-CLI.md`의 라우팅 절차를 참조하세요.');
  }

  if (!results.some((result) => result.level === 'error' || result.level === 'warn')) {
    add('success', name, description);
  }
  return results;
}

export function listSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => readSkill(path.join(skillsDir, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listTemplates(templatesDir) {
  if (!fs.existsSync(templatesDir)) return [];
  return listSkills(templatesDir);
}

export function renderSkillTemplate({ name, description = '' }) {
  return `---
name: ${name}
description: ${yamlQuote(description || `TODO: 이 스킬을 언제 사용하는지, 어떤 발화에서 트리거되는지 한두 문장으로 적는다.`)}
---

# ${name}

TODO: 이 스킬이 무엇을 하는지, 무엇은 하지 않는지 한 단락으로 적는다.
대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.

## 입력

TODO: 사용자에게 무엇을 물어야 하는지, 무엇을 가정하면 안 되는지 적는다.

## 근거 소스

TODO: 대상 볼트에서 어떤 페이지를 읽어 근거로 삼을지 적는다 (\`index.md\`로 위치 확인 후 필요한 것만 읽는다).

## 워크플로우

1. 입력·범위 확인. 모호하면 질문한다.
2. 근거 읽기.
3. 결과 생성.
4. 출력. 파일링이 필요하면 대상 볼트 \`CLAUDE.md\`의 Query Filing 워크플로우를 따른다.

TODO: 위 스텝을 이 스킬의 실제 절차로 바꾼다.

## 주의

- 근거에 없는 내용을 만들지 않는다.

> 이 파일은 스켈레톤이다. \`llmwiki skill lint ${name}\`이 TODO가 남아 있는 동안 error를 보고한다.
> 에이전트와 함께 채우려면 \`llmwiki skill new ${name}\`을 실행한다.
`;
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

/** Claude Code 슬래시 명령은 스킬마다 자동 생성한다 (Codex는 SKILLS.md 카탈로그를 본다). */
export function renderCommandStub(skill) {
  const summary = skill.description
    ? skill.description.split(/(?<=[.!?])\s|(?<=다\.)\s/)[0].trim()
    : `${skill.name} 스킬을 실행한다`;
  return `---
description: ${yamlQuote(summary)}
---

\`${skill.name}\` 스킬을 호출한다. 정본 워크플로우는 \`.claude/skills/${skill.name}/${SKILL_FILE}\`를 따른다.

대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.

요청: $ARGUMENTS
`;
}

export function renderSkillsCatalog(skills) {
  const header = `# 커스텀 스킬 카탈로그

\`llmwiki skill\` 명령으로 관리하는 사용자 정의 스킬 목록이다. 원본은 사용자 설정 디렉터리에 있고, 매 실행마다 이 워크스페이스의 \`.claude/skills/\`로 동기화된다. 이 파일은 자동 생성되므로 직접 편집하지 않는다.

각 스킬의 정본 워크플로우는 \`.claude/skills/<name>/${SKILL_FILE}\`다. 대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.`;

  if (!skills.length) {
    return `${header}

등록된 커스텀 스킬이 없다. 사용자가 스킬을 요청하면 skill-author 워크플로우로 작성한다(터미널에서는 \`llmwiki skill new <name>\`).
`;
  }

  const rows = skills.map((skill) => {
    const description = (skill.description || '설명 없음').replaceAll('|', '\\|');
    return `| ${skill.name} | \`/${skill.name}\` · \`${skill.name}\` | ${description} |`;
  });
  return `${header}

| 스킬 | 호출 (Claude · Codex) | 설명 |
|------|----------------------|------|
${rows.join('\n')}
`;
}

/** 다른 이름으로 가져온 스킬은 프로토매터 name을 디렉터리 이름에 맞춰준다. */
function alignSkillName(file, name) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const { fields } = parseSkillFrontmatter(content);
  if (!fields.name || fields.name === name) return;
  fs.writeFileSync(file, content.replace(/^(\s*name\s*:).*$/m, `$1 ${name}`));
}

export function skillDir(skillsDir, name) {
  return path.join(skillsDir, validateSkillName(name));
}

export function createSkill(skillsDir, { name, description = '', from, force = false } = {}) {
  const dir = skillDir(skillsDir, name);
  const existed = fs.existsSync(dir);
  if (existed && !force) throw new Error(`이미 존재하는 스킬입니다: ${path.basename(dir)} (덮어쓰려면 --force)`);

  let source;
  let sourceIsDirectory = false;
  if (from) {
    source = path.resolve(from);
    if (!fs.existsSync(source)) throw new Error(`가져올 경로를 찾을 수 없습니다: ${source}`);
    sourceIsDirectory = fs.statSync(source).isDirectory();
    if (sourceIsDirectory && !fs.existsSync(path.join(source, SKILL_FILE))) {
      throw new Error(`${source}에 ${SKILL_FILE}이 없습니다.`);
    }
    const resolvedDir = path.resolve(dir);
    const sourceContainsDestination = sourceIsDirectory
      && (resolvedDir === source || (!path.relative(source, resolvedDir).startsWith('..') && !path.isAbsolute(path.relative(source, resolvedDir))));
    const sameSkillFile = !sourceIsDirectory && source === path.resolve(dir, SKILL_FILE);
    if (sourceContainsDestination || sameSkillFile) {
      throw new Error('가져올 경로와 대상 스킬 경로가 같거나 대상이 원본 안에 있습니다. 다른 경로를 사용하세요.');
    }
  }

  if (!from) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SKILL_FILE), renderSkillTemplate({ name: path.basename(dir), description }));
    return { dir, existed };
  }

  if (sourceIsDirectory) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(source, dir, { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, path.join(dir, SKILL_FILE));
  }
  alignSkillName(path.join(dir, SKILL_FILE), path.basename(dir));
  return { dir, existed };
}

export function removeSkill(skillsDir, name) {
  const dir = skillDir(skillsDir, name);
  if (!fs.existsSync(dir)) throw new Error(`등록되지 않은 스킬입니다: ${path.basename(dir)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
