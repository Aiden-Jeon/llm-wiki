import fs from 'node:fs';
import path from 'node:path';
import { normalizeVault, readRegistry, writeRegistry } from './registry.js';
import { listSkills, skillDir, validateSkillName } from './skills.js';

// 사용자 설정을 머신 간에 옮기기 위한 JSON 번들 export/import.
// 범위: 볼트 레지스트리 + 커스텀 스킬. env/secrets.json 토큰과 에이전트 오버라이드(머신별)는 제외한다.
// 스킬 파일은 번들에 인라인한다(텍스트=utf8, 그 외=base64). zero-dep(tar/zip 안 씀).

export const BUNDLE_VERSION = 1;
// 텍스트로 인라인할 확장자(그 외는 base64). 스킬은 대부분 .md/.txt다.
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.js', '.ts', '.csv', '']);

function readSkillFiles(dir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // .git 등 숨김 제외
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXT.has(ext)) {
          files.push({ path: rel, encoding: 'utf8', content: fs.readFileSync(abs, 'utf8') });
        } else {
          files.push({ path: rel, encoding: 'base64', content: fs.readFileSync(abs).toString('base64') });
        }
      }
    }
  };
  walk(dir, '');
  return files;
}

/**
 * 현재 설정에서 export 번들 객체를 만든다. 순수(파일 읽기만).
 * 볼트 path는 머신마다 다르므로 번들에 넣지 않는다(import 시 재해석).
 */
export function buildExportBundle(paths) {
  const vaults = readRegistry(paths.registry, { strict: false }).map((v) => ({
    name: v.name,
    backend: v.backend,
    origin: v.origin,
    signals: v.signals,
    notes: v.notes,
  }));

  const skills = listSkills(paths.skillsDir).map((skill) => ({
    name: skill.name,
    files: readSkillFiles(skill.dir),
  }));

  return { version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), vaults, skills };
}

// 번들을 파일로 기록한다(0o600). 반환: 기록한 경로.
export function writeExportBundle(paths, outFile) {
  const bundle = buildExportBundle(paths);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(outFile, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  return outFile;
}

// 번들 파일을 읽고 최소 스키마를 검증한다.
export function readExportBundle(file) {
  if (!fs.existsSync(file)) throw new Error(`번들 파일을 찾을 수 없습니다: ${file}`);
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`번들 파싱 실패: ${error.message}`);
  }
  if (!bundle || typeof bundle !== 'object') throw new Error('번들 형식이 올바르지 않습니다.');
  if (bundle.version !== BUNDLE_VERSION) {
    throw new Error(`지원하지 않는 번들 버전입니다: ${bundle.version} (지원: ${BUNDLE_VERSION})`);
  }
  bundle.vaults = Array.isArray(bundle.vaults) ? bundle.vaults : [];
  bundle.skills = Array.isArray(bundle.skills) ? bundle.skills : [];
  return bundle;
}

// 번들의 스킬 하나를 skillsDir에 복원한다. 기존 스킬은 force 없이는 건드리지 않는다.
function restoreSkill(skillsDir, skill, { force }) {
  const name = validateSkillName(skill.name);
  const dir = skillDir(skillsDir, name);
  if (fs.existsSync(dir) && !force) return { name, skipped: true };

  // 기존 스킬을 지우기 전에 번들 전체를 검증하고 임시 디렉터리에 완성한다.
  // 잘못된 후반 파일 때문에 기존 스킬이 사라지거나 부분 복원 상태가 남는 것을 막는다.
  const files = Array.isArray(skill.files) ? skill.files : [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path || !['utf8', 'base64'].includes(f.encoding) || typeof f.content !== 'string') {
      throw new Error(`스킬 ${name}의 파일 항목이 올바르지 않습니다.`);
    }
    const candidate = path.join(dir, f.path);
    if (!path.resolve(candidate).startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`스킬 ${name}의 파일 경로가 올바르지 않습니다: ${f.path}`);
    }
  }

  fs.mkdirSync(skillsDir, { recursive: true });
  const staged = fs.mkdtempSync(path.join(skillsDir, `.import-${name}-`));
  try {
    for (const f of files) {
      const dest = path.join(staged, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buffer = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
      fs.writeFileSync(dest, buffer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staged, dir);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  return { name, skipped: false };
}

/**
 * 번들을 현재 설정에 적용한다. 순수 등록 로직 + git clone은 provisionGitVault 콜백에 위임한다.
 * (콜백을 주입해 이 모듈이 git/CLI에 의존하지 않게 한다 — 테스트에서 스텁 가능.)
 *
 * opts:
 *   - force: 기존 스킬을 덮어쓴다.
 *   - provisionGitVault(vault) → { path, origin }: git 볼트의 로컬 저장소를 준비(clone).
 * 반환 요약: { skills: {restored, skipped}, vaults: {cloned, skippedLocal, failed[]} }
 */
export function applyImportBundle(paths, bundle, { force = false, provisionGitVault } = {}) {
  const summary = {
    skills: { restored: [], skipped: [] },
    vaults: { cloned: [], skippedLocal: [], failed: [] },
  };

  // 스킬 복원
  for (const skill of bundle.skills) {
    const result = restoreSkill(paths.skillsDir, skill, { force });
    if (result.skipped) summary.skills.skipped.push(result.name);
    else summary.skills.restored.push(result.name);
  }

  // 볼트: git은 clone 후 등록, local은 path를 모르므로 스킵(경고).
  const existing = readRegistry(paths.registry, { strict: false });
  const byName = new Map(existing.map((v) => [v.name, v]));
  for (const entry of bundle.vaults) {
    if (entry.backend !== 'git') { summary.vaults.skippedLocal.push(entry.name); continue; }
    if (byName.has(entry.name) && !force) { summary.vaults.failed.push({ name: entry.name, reason: '이미 등록됨(--force로 덮어쓰기)' }); continue; }
    try {
      if (!provisionGitVault) throw new Error('git 볼트를 clone할 수 없습니다(provisioner 미지정).');
      const { path: clonedPath, origin } = provisionGitVault(entry);
      const vault = normalizeVault({
        name: entry.name, path: clonedPath, backend: 'git', origin,
        signals: entry.signals, notes: entry.notes,
      });
      byName.set(vault.name, vault);
      summary.vaults.cloned.push(vault.name);
    } catch (error) {
      summary.vaults.failed.push({ name: entry.name, reason: error.message });
    }
  }
  writeRegistry(paths.registry, [...byName.values()]);
  return summary;
}
