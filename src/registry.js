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
  const expandedPath = rawPath === '~' || rawPath.startsWith('~/')
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

export function parseRegistry(content) {
  const vaults = [];
  for (const line of content.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === 'name' || /^-+$/.test(cells[0])) continue;
    vaults.push(normalizeVault({
      name: cells[0], path: cells[1], kind: cells[2], signals: cells[3], notes: cells[4],
    }));
  }
  return vaults;
}

export function renderRegistry(vaults) {
  const rows = vaults.map((vault) => {
    const v = normalizeVault(vault);
    return `| ${v.name} | ${v.path} | ${v.kind} | ${v.signals} | ${v.notes} |`;
  });
  return `${REGISTRY_HEADER}\n${rows.length ? `${rows.join('\n')}\n` : ''}`;
}

export function readRegistry(file) {
  if (!fs.existsSync(file)) return [];
  return parseRegistry(fs.readFileSync(file, 'utf8'));
}

export function writeRegistry(file, vaults) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderRegistry(vaults), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows may not support POSIX modes. */ }
}
