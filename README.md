# llm-wiki

여러 개의 LLM 운영 Markdown 위키(볼트)를 **하나의 설치형 CLI**에서 운영하는 경량 라우터입니다. Claude Code와 Codex를 지원합니다.

지식 추가·검색·활용을 위해 볼트마다 직접 이동할 필요 없이, 각 볼트의 Git 저장소·운영 규칙·보안 경계는 분리해서 유지합니다.

## 설치

Node.js 18 이상이 필요합니다. macOS/Linux에서 검증했으며, Windows에서는 `.cmd` 셰임을 거친 에이전트 실행을 지원합니다.

### GitHub 저장소에서 설치

작업용 clone 없이 Git 저장소 URL로 바로 전역 설치할 수 있습니다.

```bash
npm install -g github:Aiden-Jeon/llm-wiki
llmwiki setup
```

로컬 개발본을 전역 명령으로 연결하려면 다음을 사용합니다.

```bash
npm link
```

## 설정

초기 설정과 볼트 관리는 모두 CLI에서 할 수 있습니다. 대화형 터미널에서는 선택 메뉴, 입력 검증, 경로 검사, 등록 내용 요약 및 저장 확인을 제공하며, CI나 스크립트에서는 기존 옵션 기반 방식을 그대로 사용할 수 있습니다.

```bash
# 설정 파일 생성 + 대화형 볼트 등록
llmwiki setup

# 비대화형 등록
llmwiki vault add \
  --name personal \
  --path ~/wikis/personal \
  --kind open \
  --signals "커리어,AI,논문" \
  --notes "커리어 자료 보유"

llmwiki vault list
llmwiki vault list --json     # 스크립트/CI용 기계 판독 출력
llmwiki vault show personal
llmwiki vault remove personal
llmwiki doctor
llmwiki config path
llmwiki config edit
```

### 볼트 종류

| 종류 | 용도 | 동작 |
|------|------|------|
| `open` | 공개 자료, 일반 학습 노트, 민감하지 않은 개인 지식 | 별도의 보안 확인 없이 읽고 쓸 수 있음 |
| `secure` | 업무 자료, 고객 정보, 개인정보, 내부 URL 등 | 쓰기 전 사용자 확인 및 민감 정보 익명화 절차 적용 |

자료를 외부에 공개해도 문제가 없다면 `open`, 외부 노출을 피해야 한다면 `secure`를 선택하는 것이 기본 기준입니다. `secure`는 암호화 기능이 아니라 **에이전트의 보안 라우팅 정책**이라는 점에 유의하세요. 실제 파일 권한이나 디스크 암호화는 별도로 설정해야 합니다.

### 볼트 설정 항목

| 항목 | 필수 | 설명 | 예시 |
|------|------|------|------|
| `name` | 필수 | CLI에서 볼트를 구분하는 고유 식별자 | `personal`, `work` |
| `path` | 필수 | 볼트가 저장된 로컬 경로 | `~/wikis/personal` |
| `kind` | 필수 | 일반 또는 보안 볼트 구분 | `open`, `secure` |
| `signals` | 선택 | 요청을 이 볼트로 자동 연결할 주제·키워드. 쉼표로 구분 | `커리어, 이력서, LinkedIn` |
| `notes` | 선택 | 에이전트가 라우팅할 때 참고할 용도·특이사항 | `커리어 자료 보유` |

예를 들어 `signals`에 `커리어, 이력서`를 입력하면 사용자가 이력서 관련 요청을 했을 때 해당 볼트를 우선 후보로 판단합니다. 신호가 모호하거나 여러 볼트와 겹치면 에이전트가 사용자에게 대상 볼트를 확인합니다.

사용자 레지스트리는 프로젝트나 npm 설치 디렉터리가 아닌 OS 표준 설정 위치에 저장됩니다.

- macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/llm-wiki/wikis.local.md`
- Windows: `%APPDATA%\\llm-wiki\\wikis.local.md`

`LLM_WIKI_CONFIG_HOME`으로 위치를 재정의할 수 있습니다. CLI로 등록한 볼트 경로는 어디에서 실행해도 동일하게 동작하도록 절대 경로로 저장됩니다.

## 어디서든 시작

```bash
llmwiki                 # 설치된 Claude/Codex를 자동 선택
llmwiki claude          # Claude Code로 시작
llmwiki codex           # Codex로 시작
llmwiki start codex     # 동일한 명시적 형식
```

기본 에이전트는 환경 변수로 고정할 수 있습니다.

```bash
export LLM_WIKI_AGENT=claude   # 또는 codex
```

에이전트 옵션은 그대로 전달할 수 있습니다.

```bash
llmwiki claude --model sonnet
llmwiki start codex -- --model gpt-5
```

CLI는 사용자 데이터 디렉터리에 관리형 실행 워크스페이스를 준비하고 레지스트리를 동기화한 뒤 에이전트를 실행합니다. 따라서 현재 디렉터리와 관계없이 동일한 라우팅 지침과 설정으로 시작됩니다.

워크스페이스에서 매 실행마다 갱신되는 항목은 라우팅 지침 문서(`AGENTS.md`, `CLAUDE.md`, `WIKI-CLI.md`, `wikis.example.md`), `wikis.local.md`, `.claude/commands/`, `.claude/skills/`입니다. 그 이외의 파일은 그대로 유지되므로 `.claude/settings.local.json`에 쌓인 Claude Code 권한 승인을 매번 다시 하지 않아도 됩니다. 자세한 설명은 워크스페이스의 `WORKSPACE.md`에 있습니다.

## 명령

### 셸 명령 (터미널에서 실행)

| 명령 | 설명 |
|------|------|
| `llmwiki setup` | 사용자 설정 초기화 |
| `llmwiki vault add/list/show/remove` | 볼트 등록 및 상태 관리 (`list --json` 지원) |
| `llmwiki doctor` | 설정 파일, 레지스트리 파싱 오류(줄 번호), 볼트 경로, 필수 문서, 에이전트 설치 진단 |
| `llmwiki config path/edit` | 설정 위치 확인 및 직접 편집 |
| `llmwiki [claude\|codex]` | 통합 라우터 시작 |

### 에이전트 내부 명령 (라우터 세션 안에서 실행)

터미널에서 직접 실행하는 명령이 아닙니다. `llmwiki`로 에이전트를 띄운 뒤 Claude Code에서는 슬래시 커맨드로, Codex에서는 태스크 이름을 그대로 말해서 호출합니다.

| 명령 | Claude Code | Codex | 설명 |
|------|-------------|-------|------|
| wiki-add | `/wiki-add <입력>` | `wiki-add <입력>` | 지식을 적절한 볼트에 추가(ingest) |
| wiki-search | `/wiki-search <질의>` | `wiki-search <질의>` | 모든 볼트를 가로질러 검색 |
| wiki-use | `/wiki-use <질문>` | `wiki-use <질문>` | 기존 지식으로 답하거나 새 분석 생성 |
| linkedin-draft | `/linkedin-draft` | `linkedin-draft` | 커리어 자료 기반 LinkedIn 초안 생성 |

입력값으로 URL, 로컬 파일 경로, Notion URL, 자유 텍스트를 모두 넘길 수 있습니다.

```bash
llmwiki claude
```

```
/wiki-add https://arxiv.org/abs/2501.12345
/wiki-add ~/Downloads/meeting-notes.md
/wiki-search LLM 서빙 비용 최적화
```

호출하면 에이전트가 `wikis.local.md`의 볼트 목록과 `signals`로 대상 볼트를 결정하고, 해당 볼트로 `cd`한 뒤 그 볼트 `CLAUDE.md`의 워크플로우를 실행합니다. 대상이 모호하면 사용자에게 확인하며, `kind: secure` 볼트 쓰기는 확인 게이트와 익명화 절차를 거칩니다.

라우팅·보안 경계 규칙은 [`WIKI-CLI.md`](WIKI-CLI.md)를 참고하세요.

## 설계 원칙

- **볼트가 정본**: 실제 ingest/query/lint/reflect/publish 흐름은 각 볼트의 `CLAUDE.md`가 정의합니다.
- **얇은 라우터**: 이 패키지는 사용자 요청을 볼트로 라우팅하고 해당 볼트의 규칙에 위임합니다.
- **설정과 패키지 분리**: 패키지를 재설치·업데이트해도 사용자 레지스트리가 삭제되거나 덮어써지지 않습니다.
- **보안 경계 유지**: `secure` 볼트 쓰기는 확인과 익명화 절차를 거칩니다.

## 볼트 요구사항

각 볼트는 최소한 자체 `CLAUDE.md`(위키 스키마와 워크플로우) 및 `index.md`를 가지는 것을 권장합니다. Codex 전용 지침이 필요하면 `AGENTS.md`를 추가할 수 있습니다. `secure` 볼트는 보안 원칙을 명시해야 합니다.

## 개발

```bash
npm test
npm pack --dry-run
```

## 라이선스

MIT
