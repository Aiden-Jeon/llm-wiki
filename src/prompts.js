// CLI 명령 핸들러가 공유하는 저수준 헬퍼: 옵션 파싱, 자식 프로세스 실행, 대화형 프롬프트 유틸.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stdin } from 'node:process';
import * as p from '@clack/prompts';
import { writeRegistry } from './registry.js';

const IS_WINDOWS = process.platform === 'win32';

export function parseOptions(args, { allowed, booleans = [], usage } = {}) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      // 값에 '='가 포함될 수 있으므로 첫 '='만 구분자로 삼는다 (split(limit)은 뒤를 버린다).
      const body = arg.slice(2);
      const separator = body.indexOf('=');
      const key = separator === -1 ? body : body.slice(0, separator);
      const inline = separator === -1 ? undefined : body.slice(separator + 1);
      if (!key) throw new Error(`옵션 이름이 비었습니다: ${arg}`);
      if (allowed && !allowed.includes(key)) {
        throw new Error(`알 수 없는 옵션: --${key}\n사용 가능한 옵션: ${allowed.map((item) => `--${item}`).join(', ')}${usage ? `\n사용법: ${usage}` : ''}`);
      }
      if (booleans.includes(key)) {
        options[key] = inline === undefined ? true : inline !== 'false';
        continue;
      }
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`--${key} 옵션 값이 필요합니다.`);
      options[key] = value;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

// Windows의 claude.cmd / codex.cmd 같은 셰임(shim)은 shell 없이 실행할 수 없다.
function toShellCommand(command, args) {
  const quote = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [command, ...args].map(quote).join(' ');
}

export function runSync(command, args, options = {}) {
  if (IS_WINDOWS) return spawnSync(toShellCommand(command, args), { ...options, shell: true });
  return spawnSync(command, args, options);
}

export function runAsync(command, args, options = {}) {
  if (IS_WINDOWS) return spawn(toShellCommand(command, args), { ...options, shell: true });
  return spawn(command, args, options);
}

export function reportIssues(file, issues) {
  if (!issues.length) return;
  const lines = issues.map((issue) => `${issue.line}행: ${issue.message}`);
  const message = `레지스트리에서 읽지 못한 행 ${issues.length}개 (${file})\n${lines.join('\n')}`;
  if (stdin.isTTY) p.log.warn(message);
  else console.error(`[WARN] ${message}`);
}

export function cancelPrompt(value) {
  if (!p.isCancel(value)) return false;
  p.cancel('설정을 취소했습니다. 변경 사항은 저장되지 않았습니다.');
  return true;
}

export function inspectVault(vaultPath) {
  return {
    exists: fs.existsSync(vaultPath),
    claude: fs.existsSync(path.join(vaultPath, 'CLAUDE.md')),
    agents: fs.existsSync(path.join(vaultPath, 'AGENTS.md')),
    index: fs.existsSync(path.join(vaultPath, 'index.md')),
  };
}

export function ensureRegistry(paths) {
  if (!fs.existsSync(paths.registry)) writeRegistry(paths.registry, []);
}

/**
 * p.select를 감싸는 테스트 seam. 대화형 프롬프트는 TTY 없이는 실행할 수 없어
 * picker 경로가 테스트에서 통째로 빠지므로, 테스트가 선택 결과를 주입할 수 있게 한다.
 * null을 반환하면 취소(ESC/Ctrl+C)와 같게 처리된다.
 */
let selectImpl = null;
export function setSelectForTest(fn) { selectImpl = fn; }

async function select(options, message) {
  if (selectImpl) return selectImpl(options, message);
  const value = await p.select({ message, options });
  if (cancelPrompt(value)) return null;
  return value;
}

/**
 * p.text를 감싸는 테스트 seam. select와 같은 이유로 둔다.
 * validate는 p.text와 같은 계약(문제가 있으면 메시지 문자열 반환)이며,
 * 주입된 구현에도 적용해 테스트가 실제 검증 규칙을 함께 통과하게 한다.
 * null을 반환하면 취소와 같게 처리된다.
 */
let textImpl = null;
export function setTextForTest(fn) { textImpl = fn; }

export async function askText({ message, placeholder, validate } = {}) {
  if (textImpl) {
    const entered = await textImpl({ message, placeholder });
    if (entered === null || entered === undefined) return null;
    const problem = validate ? validate(entered) : undefined;
    if (problem) throw new Error(problem);
    return entered;
  }
  const value = await p.text({ message, placeholder, validate });
  if (cancelPrompt(value)) return null;
  return value;
}

export async function chooseVault(vaults, message) {
  const name = await select(
    vaults.map((vault) => ({ value: vault.name, label: vault.name, hint: vault.signals || undefined })),
    message,
  );
  if (name === null) return null;
  return vaults.find((vault) => vault.name === name);
}

/**
 * 이름 인자가 빠졌을 때 목록에서 고르게 한다. 볼트가 아닌 대상(스킬·에이전트·연결)도 쓴다.
 * items는 { value, label?, hint? } 배열. 취소하면 null.
 */
export async function chooseName(items, message) {
  return select(
    items.map((item) => ({ value: item.value, label: item.label || item.value, hint: item.hint || undefined })),
    message,
  );
}

// EDITOR는 `code -w`처럼 인자를 포함할 수 있으므로 토큰으로 나눠 사용한다.
export function splitCommand(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

export function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new Error(`$EDITOR 또는 $VISUAL 환경 변수를 설정하세요. (대상: ${file})`);
  const [command, ...editorArgs] = splitCommand(editor);
  if (!command) throw new Error(`$EDITOR 값을 해석할 수 없습니다: ${editor}`);
  // 셸 문자열을 조립하지 않고 인자로 전달해 경로 속 $()·백틱 해석을 막는다.
  const result = runSync(command, [...editorArgs, file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`편집기가 상태 코드 ${result.status}로 종료되었습니다.`);
}
