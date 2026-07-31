import fs from 'node:fs';
import path from 'node:path';

export const SKILL_FILE = 'SKILL.md';
// 내장 라우팅 명령과 이름이 겹치면 워크스페이스에서 서로를 덮어쓴다.
export const RESERVED_SKILL_NAMES = ['wiki-add', 'wiki-search', 'wiki-use'];
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

이 스킬이 무엇을 하는지 한 단락으로 적는다. 대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.

## 입력

사용자에게 무엇을 물어야 하는지, 무엇을 가정하면 안 되는지 적는다.

## 근거 소스

대상 볼트에서 어떤 페이지를 읽어 근거로 삼을지 적는다 (\`index.md\`로 위치 확인 후 필요한 것만 읽는다).

## 워크플로우

1. 입력·범위 확인. 모호하면 질문한다.
2. 근거 읽기.
3. 결과 생성.
4. 출력. 파일링이 필요하면 대상 볼트 \`CLAUDE.md\`의 Query Filing 워크플로우를 따른다.

## 주의

- 근거에 없는 내용을 만들지 않는다.
- \`kind: secure\` 볼트에서 raw 민감 자료를 끌어오지 않는다.
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

대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다. \`kind: secure\` 볼트는 쓰기 전 확인·익명화 게이트를 거친다.

요청: $ARGUMENTS
`;
}

export function renderSkillsCatalog(skills) {
  const header = `# 커스텀 스킬 카탈로그

\`llmwiki skill\` 명령으로 관리하는 사용자 정의 스킬 목록이다. 원본은 사용자 설정 디렉터리에 있고, 매 실행마다 이 워크스페이스의 \`.claude/skills/\`로 동기화된다. 이 파일은 자동 생성되므로 직접 편집하지 않는다.

각 스킬의 정본 워크플로우는 \`.claude/skills/<name>/${SKILL_FILE}\`다. 대상 볼트는 \`WIKI-CLI.md\`의 라우팅 절차로 해소한다.`;

  if (!skills.length) {
    return `${header}

등록된 커스텀 스킬이 없다. 사용자가 스킬을 요청하면 \`llmwiki skill add <name>\`으로 등록하도록 안내한다.
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
