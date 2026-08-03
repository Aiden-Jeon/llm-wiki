import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REGISTRY_HEADER = `# 볼트 레지스트리

이 파일은 \`llmwiki\`가 관리합니다. 경로는 절대 경로로 저장됩니다.

backend는 \`local\`(그냥 폴더) 또는 \`git\`(git repo, \`llmwiki vault sync\`로 동기화)입니다. origin은 git backend의 원격 URL입니다.

| name | path | backend | origin | signals | notes |
|------|------|---------|--------|---------|-------|`;

// 논리 에이전트 이름 → 실제 실행 명령을 재정의할 수 있는 대상.
export const SUPPORTED_AGENTS = ['claude', 'codex'];

const AGENT_HEADER = `## 에이전트 실행 명령

논리 이름(claude/codex)을 다른 실행 명령으로 재정의합니다. 명령은 공백으로 나뉜 토큰으로 실행됩니다(예: \`dbexec repo run isaac codex\`).

add-dir 열이 \`yes\`면 등록된 볼트를 \`--add-dir <경로>\`로 넘깁니다(claude/codex 기본). vibe처럼 이 플래그를 받지 않는 wrapper는 \`no\`로 두며, 볼트는 워크스페이스의 \`vaults/\` 심볼릭 링크로 노출됩니다.

| agent | command | add-dir |
|-------|---------|---------|`;

function validateField(label, value, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${label} 값이 필요합니다.`);
  if (/[|\r\n]/.test(text)) throw new Error(`${label}에는 | 또는 줄바꿈을 사용할 수 없습니다.`);
  return text;
}

export function normalizeVault(vault) {
  const name = validateField('name', vault.name, { required: true });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error('name은 영문자/숫자로 시작하고 영문자, 숫자, _ 및 -만 사용할 수 있습니다.');
  }

  const rawPath = validateField('path', vault.path, { required: true });
  const expandedPath = rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')
    ? path.join(os.homedir(), rawPath.slice(2))
    : rawPath;
  const vaultPath = path.resolve(expandedPath);

  const backend = validateField('backend', vault.backend || 'local');
  if (!['local', 'git'].includes(backend)) throw new Error('backend는 local 또는 git여야 합니다.');

  // origin은 git backend에서만 의미가 있다. local은 항상 빈 값으로 강제한다.
  const origin = validateField('origin', vault.origin);
  if (backend === 'git' && !origin) throw new Error('git backend 볼트는 origin(원격 URL)이 필요합니다.');
  if (backend === 'local' && origin) throw new Error('local backend 볼트에는 origin을 지정할 수 없습니다.');

  return {
    name,
    path: vaultPath,
    backend,
    origin,
    signals: validateField('signals', vault.signals),
    notes: validateField('notes', vault.notes),
  };
}

/**
 * 에이전트 명령 재정의 행을 검증한다. command는 공백으로 나뉜 토큰으로 실행되므로
 * 값 자체는 자유롭게 두되, 표를 깨는 문자(|, 줄바꿈)와 빈 값만 막는다.
 */
export function normalizeAgentCommand(agent) {
  const name = validateField('agent', agent.name, { required: true });
  if (!SUPPORTED_AGENTS.includes(name)) {
    throw new Error(`agent는 ${SUPPORTED_AGENTS.join(' 또는 ')}여야 합니다.`);
  }
  const command = validateField('command', agent.command, { required: true });
  return { name, command, addDir: agent.addDir !== false };
}

// 표의 add-dir 셀(yes/no)을 boolean으로 해석한다. 레거시 2열 항목은 기본 true.
function parseAddDir(cell) {
  const text = String(cell ?? '').trim().toLowerCase();
  if (['no', 'false', 'off', '0'].includes(text)) return false;
  return true;
}

/**
 * 레지스트리 표를 행 단위로 파싱한다. 잘못된 행은 버리지 않고 issues로 수집해
 * `llmwiki doctor`가 파일·줄 번호와 함께 보고할 수 있게 한다.
 *
 * 볼트 표(name…)와 에이전트 표(agent…)를 한 파일에 담는다. 헤더 행으로 현재
 * 섹션을 판별하고, 그 이후 데이터 행을 해당 섹션 규칙으로 해석한다.
 */
export function parseRegistryFile(content) {
  const vaults = [];
  const agents = [];
  const issues = [];
  const seen = new Map();
  const seenAgents = new Map();
  const lines = content.split(/\r?\n/);
  let section = 'vault';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (!/^\s*\|/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (/^-+$/.test(cells[0] ?? '')) continue;
    if (cells[0] === 'name') { section = 'vault'; continue; }
    if (cells[0] === 'agent') { section = 'agent'; continue; }

    const raw = line.trim();

    if (section === 'agent') {
      if (cells.length !== 2 && cells.length !== 3) {
        issues.push({ line: lineNumber, raw, message: `열이 2개(agent/command) 또는 3개(agent/command/add-dir) 필요하지만 ${cells.length}개입니다.` });
        continue;
      }
      let agent;
      try {
        agent = normalizeAgentCommand({ name: cells[0], command: cells[1], addDir: parseAddDir(cells[2]) });
      } catch (error) {
        issues.push({ line: lineNumber, raw, message: error.message });
        continue;
      }
      if (seenAgents.has(agent.name)) {
        issues.push({ line: lineNumber, raw, message: `에이전트가 중복됩니다: ${agent.name} (${seenAgents.get(agent.name)}행과 충돌).` });
        continue;
      }
      seenAgents.set(agent.name, lineNumber);
      agents.push(agent);
      continue;
    }

    // 6컬럼(현행)과 4컬럼(레거시: backend/origin 없이 저장된 파일)을 받는다.
    // 과거 kind 열이 있던 7컬럼/5컬럼도 하위 호환으로 읽되 kind 셀은 조용히 버린다.
    // 레거시 행은 backend=local, origin=''로 승격한다.
    let fields;
    if (cells.length === 6) {
      fields = { name: cells[0], path: cells[1], backend: cells[2], origin: cells[3], signals: cells[4], notes: cells[5] };
    } else if (cells.length === 4) {
      fields = { name: cells[0], path: cells[1], backend: 'local', origin: '', signals: cells[2], notes: cells[3] };
    } else if (cells.length === 7) {
      // 레거시 kind 열(cells[2])을 버리고 나머지를 매핑한다.
      fields = { name: cells[0], path: cells[1], backend: cells[3], origin: cells[4], signals: cells[5], notes: cells[6] };
    } else if (cells.length === 5) {
      // 레거시 kind 열(cells[2])을 버리고 backend=local, origin=''로 승격한다.
      fields = { name: cells[0], path: cells[1], backend: 'local', origin: '', signals: cells[3], notes: cells[4] };
    } else {
      issues.push({ line: lineNumber, raw, message: `열이 6개(name/path/backend/origin/signals/notes) 또는 4개(레거시) 필요하지만 ${cells.length}개입니다.` });
      continue;
    }

    let vault;
    try {
      vault = normalizeVault(fields);
    } catch (error) {
      issues.push({ line: lineNumber, raw, message: error.message });
      continue;
    }

    if (seen.has(vault.name)) {
      issues.push({ line: lineNumber, raw, message: `볼트 이름이 중복됩니다: ${vault.name} (${seen.get(vault.name)}행과 충돌).` });
      continue;
    }
    seen.set(vault.name, lineNumber);
    vaults.push(vault);
  }

  return { vaults, agents, issues };
}

export function parseRegistry(content) {
  return parseRegistryFile(content).vaults;
}

export function formatIssues(file, issues) {
  const details = issues.map((issue) => `  ${issue.line}행: ${issue.message}\n    ${issue.raw}`).join('\n');
  return [
    `레지스트리 파일을 읽을 수 없습니다: ${file}`,
    details,
    '`llmwiki doctor`로 확인하거나 `llmwiki config edit`로 수정하세요.',
  ].join('\n');
}

export function renderRegistry(vaults, agents = []) {
  const vaultRows = vaults.map((vault) => {
    const v = normalizeVault(vault);
    return `| ${v.name} | ${v.path} | ${v.backend} | ${v.origin} | ${v.signals} | ${v.notes} |`;
  });
  let out = `${REGISTRY_HEADER}\n${vaultRows.length ? `${vaultRows.join('\n')}\n` : ''}`;
  if (agents.length) {
    const agentRows = agents.map((agent) => {
      const a = normalizeAgentCommand(agent);
      return `| ${a.name} | ${a.command} | ${a.addDir ? 'yes' : 'no'} |`;
    });
    out += `\n${AGENT_HEADER}\n${agentRows.join('\n')}\n`;
  }
  return out;
}

export function readRegistryFile(file) {
  if (!fs.existsSync(file)) return { vaults: [], agents: [], issues: [] };
  return parseRegistryFile(fs.readFileSync(file, 'utf8'));
}

/**
 * strict(기본값)는 쓰기 경로에서 사용한다. 잘못된 행이 있는 상태로 저장하면
 * 해당 행이 조용히 삭제되므로, 문제를 먼저 알리고 중단한다.
 */
export function readRegistry(file, { strict = true } = {}) {
  const { vaults, issues } = readRegistryFile(file);
  if (strict && issues.length) throw new Error(formatIssues(file, issues));
  return vaults;
}

/** 에이전트 명령 매핑만 읽는다. 미설정·미존재 파일이면 빈 배열. */
export function readAgents(file, { strict = false } = {}) {
  const { agents, issues } = readRegistryFile(file);
  if (strict && issues.length) throw new Error(formatIssues(file, issues));
  return agents;
}

/**
 * 볼트 표를 저장하되 에이전트 표는 보존한다. agents를 넘기면 그 값으로 교체하고,
 * 생략하면 파일에 이미 있던 매핑을 그대로 유지한다(볼트 편집이 에이전트 설정을 지우지 않게).
 */
export function writeRegistry(file, vaults, agents) {
  const preserved = agents ?? (fs.existsSync(file) ? readAgents(file) : []);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderRegistry(vaults, preserved), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows may not support POSIX modes. */ }
}
