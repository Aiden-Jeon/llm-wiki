import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REGISTRY_HEADER = `# 볼트 레지스트리

이 파일은 \`llmwiki\`가 관리합니다. 경로는 절대 경로로 저장됩니다.

| name | path | kind | signals | notes |
|------|------|------|---------|-------|`;

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
  const kind = validateField('kind', vault.kind || 'open');
  if (!['open', 'secure'].includes(kind)) throw new Error('kind는 open 또는 secure여야 합니다.');

  return {
    name,
    path: vaultPath,
    kind,
    signals: validateField('signals', vault.signals),
    notes: validateField('notes', vault.notes),
  };
}

/**
 * 레지스트리 표를 행 단위로 파싱한다. 잘못된 행은 버리지 않고 issues로 수집해
 * `llmwiki doctor`가 파일·줄 번호와 함께 보고할 수 있게 한다.
 */
export function parseRegistryFile(content) {
  const vaults = [];
  const issues = [];
  const seen = new Map();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (!/^\s*\|/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === 'name' || /^-+$/.test(cells[0] ?? '')) continue;

    const raw = line.trim();
    if (cells.length !== 5) {
      issues.push({ line: lineNumber, raw, message: `열이 정확히 5개(name/path/kind/signals/notes) 필요하지만 ${cells.length}개입니다.` });
      continue;
    }

    let vault;
    try {
      vault = normalizeVault({
        name: cells[0], path: cells[1], kind: cells[2], signals: cells[3], notes: cells[4],
      });
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

  return { vaults, issues };
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

export function renderRegistry(vaults) {
  const rows = vaults.map((vault) => {
    const v = normalizeVault(vault);
    return `| ${v.name} | ${v.path} | ${v.kind} | ${v.signals} | ${v.notes} |`;
  });
  return `${REGISTRY_HEADER}\n${rows.length ? `${rows.join('\n')}\n` : ''}`;
}

export function readRegistryFile(file) {
  if (!fs.existsSync(file)) return { vaults: [], issues: [] };
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

export function writeRegistry(file, vaults) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderRegistry(vaults), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows may not support POSIX modes. */ }
}
