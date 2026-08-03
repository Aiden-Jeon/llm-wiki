import { stripVTControlCharacters } from 'node:util';

// clack의 p.note는 박스 폭·padding을 문자열 .length로 계산한다. 한글 등 CJK 문자는
// .length가 1이지만 터미널에서 2칸을 차지하므로, CJK가 섞인 줄일수록 오른쪽 테두리가
// 시각적으로 밀린다. 여기서는 표시폭(CJK=2)을 알고 박스를 직접 그려 정렬을 맞춘다.

// East Asian Wide/Fullwidth와 이모지 대략 범위 → 2칸. 그 외는 1칸.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0x303e) // CJK Radicals, Kangxi
    || (cp >= 0x3041 && cp <= 0x33ff) // Hiragana, Katakana, CJK symbols
    || (cp >= 0x3400 && cp <= 0x4dbf) // CJK Ext A
    || (cp >= 0x4e00 && cp <= 0x9fff) // CJK Unified
    || (cp >= 0xa000 && cp <= 0xa4cf) // Yi
    || (cp >= 0xac00 && cp <= 0xd7a3) // Hangul Syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility
    || (cp >= 0xfe30 && cp <= 0xfe4f) // CJK Compatibility Forms
    || (cp >= 0xff00 && cp <= 0xff60) // Fullwidth Forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff) // emoji
    || (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

// ANSI를 벗겨낸 뒤 코드포인트별 표시폭을 합산한다.
export function displayWidth(text) {
  const stripped = stripVTControlCharacters(String(text ?? ''));
  let width = 0;
  for (const ch of stripped) {
    width += isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

const GRAY = '\x1b[90m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

/**
 * clack p.note와 같은 모양의 박스 문자열을 만든다. 레이아웃은 clack note 렌더러를
 * 그대로 재현하되, 폭 계산만 문자열 .length가 아니라 displayWidth(CJK=2)로 바꿔
 * 한글·이모지가 섞여도 오른쪽 테두리가 어긋나지 않게 한다.
 * body는 줄바꿈으로 나뉜 여러 줄. clack처럼 위/아래에 빈 줄을 하나씩 두른다.
 * color=false면 ANSI 없이 순수 텍스트만(테스트·비색상 환경용).
 */
export function renderNote(body, title = '', { color = true } = {}) {
  // clack: `\n${body}\n`.split('\n') → 앞뒤로 빈 줄 하나씩 자동 포함.
  const lines = `\n${body}\n`.split('\n');
  const titleWidth = displayWidth(title);
  const contentWidth = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0);
  const inner = Math.max(contentWidth, titleWidth) + 2; // clack과 동일하게 여유 2칸

  const g = (s) => (color ? `${GRAY}${s}${RESET}` : s);
  const dim = (s) => (color ? `${DIM}${s}${RESET}` : s);
  const green = (s) => (color ? `${GREEN}${s}${RESET}` : s);

  const gutter = g('│');
  const header = `${green('◇')}  ${title} ${g('─'.repeat(Math.max(inner - titleWidth - 1, 1)) + '╮')}`;
  const rows = lines.map((line) => {
    const pad = ' '.repeat(inner - displayWidth(line));
    return `${gutter}  ${dim(line)}${pad}${gutter}`;
  });
  const footer = g(`├${'─'.repeat(inner + 2)}╯`);

  // 맨 앞 gutter 한 줄은 clack이 note 위에 항상 찍는다(p.log 흐름과의 간격).
  return [gutter, header, ...rows, footer].join('\n');
}
