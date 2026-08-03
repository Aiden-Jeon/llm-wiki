# llm-wiki

여러 개의 LLM 운영 Markdown 위키(볼트)를 **하나의 설치형 CLI**에서 운영하는 경량 라우터입니다. Claude Code와 Codex를 지원합니다.

지식 추가·검색·활용을 위해 볼트마다 직접 이동할 필요 없이, 각 볼트의 Git 저장소·운영 규칙·보안 경계는 분리해서 유지합니다.

핵심 목적은 **로컬에서 지식을 작업하고, 그 결과를 Notion 같은 원격 저장소에서 보여주는 것**입니다. 전체 흐름은 세 단계입니다.

```text
① 입력 소스            ②  로컬 위키 (볼트)          ③ 원격 발행
llmwiki new     ─┐
llmwiki capture ─┼─▶  raw/ → wiki/ (Markdown)  ─▶  llmwiki sync ─▶ 원격 (provider)
llmwiki inbox pull ┘        정본은 로컬                 (local→원격 단방향)
```

- **입력 소스** — 새 정보를 로컬 볼트로 받아오는 창구(`new` / `capture` / `inbox pull`). [자세히](#입력-소스)
- **로컬 위키** — 볼트의 `raw/`·`wiki/` Markdown이 언제나 정본입니다. 볼트는 그냥 로컬 폴더(`local`)일 수도, git repo(`git`)일 수도 있습니다. git 백엔드는 `llmwiki vault sync`로 여러 머신에서 같은 위키를 작업하게 해줍니다. [자세히](#볼트-백엔드-local--git)
- **원격 발행** — `llmwiki sync`로 로컬 위키를 원격 저장소에 단방향(local→원격)으로 동기화해 view로 보여줍니다. 원격 대상은 **provider**로 추상화되어 있어 현재 Notion을 지원하고 확장 가능합니다. [자세히](#원격-발행수집-sync--inbox)

> **두 개의 다른 "동기화"**: `llmwiki vault sync`(git)는 *마크다운 파일 자체*를 머신 간에 공유하고, `llmwiki sync`(provider)는 *위키 view*를 Notion 등에 발행합니다. 두 축은 독립적이라 git 백엔드 볼트를 Notion에도 발행할 수 있습니다.

## 설치

Node.js 18 이상이 필요합니다.

```bash
npm install -g github:Aiden-Jeon/llm-wiki
```

설치 후 초기 설정을 실행합니다.

```bash
llmwiki setup
```

### 소스에서 설치

```bash
git clone https://github.com/Aiden-Jeon/llm-wiki.git
cd llm-wiki
npm install
npm link
```

## 설정

초기 설정과 볼트 관리는 CLI에서 합니다. `llmwiki setup`은 대화형이며, 플래그로 비대화형 등록도 가능합니다.

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
llmwiki vault list --json
llmwiki vault show personal
llmwiki vault remove personal
llmwiki vault lint personal   # 위키 스키마 적합성 검사 (--json 지원)
llmwiki vault scaffold personal   # 누락된 스키마 구조 생성 (기존 파일 보존)
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
| `path` | 필수¹ | 볼트가 저장된 로컬 경로 | `~/wikis/personal` |
| `kind` | 필수 | 일반 또는 보안 볼트 구분 | `open`, `secure` |
| `backend` | 선택 | 저장 방식. 기본 `local` | `local`, `git` |
| `origin` | 조건부 | git 백엔드의 원격 URL (git이면 필수) | `git@github.com:me/wiki.git` |
| `signals` | 선택 | 요청을 이 볼트로 자동 연결할 주제·키워드. 쉼표로 구분 | `커리어, 이력서, LinkedIn` |
| `notes` | 선택 | 에이전트가 라우팅할 때 참고할 용도·특이사항 | `커리어 자료 보유` |

¹ git 백엔드는 `path`를 생략하면 `~/llmwiki-vaults/<name>`로 clone합니다.

예를 들어 `signals`에 `커리어, 이력서`를 입력하면 사용자가 이력서 관련 요청을 했을 때 해당 볼트를 우선 후보로 판단합니다. 신호가 모호하거나 여러 볼트와 겹치면 에이전트가 사용자에게 대상 볼트를 확인합니다.

사용자 레지스트리는 프로젝트나 npm 설치 디렉터리가 아닌 OS 표준 설정 위치에 저장됩니다.

- `${XDG_CONFIG_HOME:-~/.config}/llm-wiki/wikis.local.md`

`LLM_WIKI_CONFIG_HOME`으로 위치를 재정의할 수 있습니다. CLI로 등록한 볼트 경로는 어디에서 실행해도 동일하게 동작하도록 절대 경로로 저장됩니다.

## 볼트 백엔드 (local / git)

볼트를 저장하는 방식입니다. 기본은 `local`(이 머신의 폴더)이고, `git`을 쓰면 볼트가 git repo가 되어 여러 머신에서 같은 위키를 작업할 수 있습니다.

```bash
# git 백엔드 볼트 등록 — origin에서 clone (path 생략 시 ~/llmwiki-vaults/gwiki)
llmwiki vault add --name gwiki --backend git --origin git@github.com:me/wiki.git

# 작업 후 원격과 동기화: pull --rebase → 변경 있으면 commit → push
llmwiki vault sync gwiki
llmwiki vault sync gwiki --message "회의 노트 정리"   # 커밋 메시지 지정
llmwiki vault sync gwiki --pull-only                  # 원격 변경만 당겨오기
llmwiki vault sync gwiki --no-push                    # 커밋만, push는 나중에
```

- `vault sync`는 **git 백엔드 볼트만** 대상입니다(local 볼트는 안내 후 건너뜁니다).
- "주기적"으로 돌리려면 cron/launchd에 `llmwiki vault sync <name>`을 예약하세요. llmwiki는 데몬을 띄우지 않습니다.
- 다른 머신에서는 아래 `config import`로 git 볼트를 자동 clone해 바로 이어서 작업할 수 있습니다.
- git이 설치돼 있어야 하며(선택 의존성), 인증은 시스템 git 설정(SSH 키·credential helper)을 그대로 씁니다.

## 설정 export / import

새 머신에서 빠르게 셋업하도록 설정을 JSON 번들로 옮깁니다. 범위는 **볼트 레지스트리 + 커스텀 스킬**입니다.

```bash
# 머신 A: 내보내기
llmwiki config export --output ~/llmwiki-settings.json

# 머신 B: 가져오기 (git 볼트는 자동 clone)
llmwiki config import ~/llmwiki-settings.json --vaults-dir ~/llmwiki-vaults
```

- **토큰은 절대 포함되지 않습니다**(원격 provider 토큰은 env 전용). 에이전트 실행 명령 오버라이드도 머신마다 다르므로 제외됩니다.
- **git 볼트**는 origin으로 자동 clone한 뒤 레지스트리에 등록합니다.
- **local 볼트**는 경로가 머신마다 달라 자동 등록하지 않고, 목록으로 알려줍니다(수동으로 `vault add`).
- 기존 스킬은 덮어쓰지 않고 건너뜁니다. 덮어쓰려면 `--force`.

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

CLI는 관리형 워크스페이스를 준비한 뒤 에이전트를 실행하므로, 현재 디렉터리와 관계없이 동일한 라우팅 지침으로 시작됩니다. 워크스페이스 동작 상세는 `WORKSPACE.md`를 참고하세요.

### 컨텍스트 로드

| 파일 | 위치 | 로드 시점 |
|------|------|-----------|
| **라우터** `CLAUDE.md` | 워크스페이스 | `llmwiki` 시작 시 |
| **볼트** `CLAUDE.md` | 각 볼트 | 해당 볼트로 라우팅된 뒤 |
| **템플릿** `CLAUDE.md` | `templates/vault/` | 런타임 미로드 (`vault scaffold` 원본) |

시작 시에는 라우터 `CLAUDE.md`만 로드되고, 대상 볼트가 정해진 뒤에 볼트 `CLAUDE.md`가 추가됩니다.

## 명령

### 셸 명령 (터미널에서 실행)

| 명령 | 설명 |
|------|------|
| `llmwiki setup` | 사용자 설정 초기화 |
| `llmwiki vault add/list/show/remove` | 볼트 등록 및 상태 관리 (`list --json` 지원) |
| `llmwiki vault lint [name]` | 볼트가 위키 스키마를 지키는지 검사 (`--json` 지원) |
| `llmwiki vault scaffold [name]` | 위키 스키마 구조를 생성·보완 (기존 파일은 덮어쓰지 않음) |
| `llmwiki vault sync [name]` | git 백엔드 볼트를 원격과 동기화 (pull→commit→push) |
| `llmwiki skill add/list/show/edit/remove` | 커스텀 스킬 관리 (`list --json` 지원) |
| `llmwiki skill templates` | 내장 스킬 템플릿 목록 |
| `llmwiki skill path [name]` | 스킬 원본 경로 출력 |
| `llmwiki doctor` | 설정·볼트·에이전트 진단 |
| `llmwiki config path/edit` | 설정 위치 확인 및 직접 편집 |
| `llmwiki config export/import` | 설정(볼트·스킬)을 JSON 번들로 내보내기/가져오기 |
| `llmwiki [claude\|codex]` | 통합 라우터 시작 |
| `llmwiki new <입력>` | 에이전트를 띄워 URL/파일/텍스트를 ingest |
| `llmwiki capture [options]` | 자유 텍스트 메모를 볼트 `raw/notes/`에 저장 |
| `llmwiki sync [vault] [--dry-run]` | 로컬 위키를 원격(provider)으로 단방향 push |
| `llmwiki inbox pull [vault] [--dry-run]` | 원격(provider) inbox의 새 항목을 가져옴 |

### 에이전트 내부 명령 (라우터 세션 안에서 실행)

터미널에서 직접 실행하는 명령이 아닙니다. `llmwiki`로 에이전트를 띄운 뒤 Claude Code에서는 슬래시 커맨드로, Codex에서는 태스크 이름을 그대로 말해서 호출합니다.

| 명령 | Claude Code | Codex | 설명 |
|------|-------------|-------|------|
| wiki-add | `/wiki-add <입력>` | `wiki-add <입력>` | 지식을 적절한 볼트에 추가(ingest) |
| wiki-search | `/wiki-search <질의>` | `wiki-search <질의>` | 모든 볼트를 가로질러 검색 |
| wiki-use | `/wiki-use <질문>` | `wiki-use <질문>` | 기존 지식으로 답하거나 새 분석 생성 |
| wiki-lint | `/wiki-lint [볼트]` | `wiki-lint [볼트]` | 스키마 적합성 평가 후 수정 권고·적용 |
| 커스텀 스킬 | `/<skill>` | `<skill>` | `llmwiki skill`로 등록한 사용자 정의 작업 |

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

## 커스텀 스킬

LinkedIn 프로필 초안처럼 사용자별로 다른 작업은 라우터에 내장하지 않고 직접 스킬로 등록해 사용합니다. 스킬은 하나의 `SKILL.md` 마크다운 파일이며, 등록하면 Claude Code 슬래시 명령과 Codex 태스크로 동시에 노출됩니다.

```bash
# 내장 템플릿에서 시작 (예: LinkedIn 초안 스킬)
llmwiki skill templates
llmwiki skill add linkedin-draft --template linkedin-draft

# 새 스킬을 만들고 $EDITOR로 편집
llmwiki skill add weekly-retro --description "주간 회고 생성. '주간 회고', '이번 주 정리' 요청에 사용"

# 기존 스킬 파일이나 디렉터리 가져오기
llmwiki skill add paper-review --from ~/skills/paper-review

llmwiki skill list
llmwiki skill show linkedin-draft
llmwiki skill edit linkedin-draft
llmwiki skill remove linkedin-draft
```

스킬 원본은 설정 디렉터리의 `skills/<name>/SKILL.md`에 보관되며(`llmwiki skill path`), 다음 실행 시 워크스페이스로 동기화됩니다.

| 생성 대상 | 용도 |
|-----------|------|
| `.claude/skills/<name>/` | Claude Code skill |
| `.claude/commands/<name>.md` | Claude Code 슬래시 명령 (`/<name>`) |
| `SKILLS.md` | Codex 스킬 카탈로그 |

`SKILL.md` 프론트매터에는 `name`과 `description`이 필요합니다. `description`에는 트리거 발화 예시를 넣는 것이 좋습니다. 스킬 이름은 내장 명령(`wiki-add`, `wiki-search`, `wiki-use`)과 중복할 수 없습니다.

## 입력 소스

새 정보를 볼트로 받아오는 창구입니다.

```bash
llmwiki new https://arxiv.org/abs/2501.12345   # 에이전트를 띄워 ingest 시작
echo "회의에서 나온 아이디어" | llmwiki capture --vault personal --title "아이디어"
llmwiki inbox pull personal --dry-run           # Notion inbox 새 항목 미리보기
```

- **`new`** 는 에이전트 세션을 열고 그 안에서 `wiki-add` 워크플로우를 시작하는 shortcut입니다. 분류·라우팅은 에이전트가 판단합니다.
- **`capture`** 는 결정론적으로 메모를 `raw/notes/`에 저장합니다(타임스탬프 파일명). TTY에서는 프롬프트로, 파이프에서는 stdin으로 본문을 받습니다. 저장 후 바로 ingest할지 물어봅니다.
- **`inbox pull`** 은 원격 inbox의 새 항목을 `raw/notes/`로 가져오고, 이미 가져온 항목은 `_meta/remote-inbox.json`으로 중복을 막습니다.

> `new`·`capture`는 로컬 전용이고, `inbox pull`은 원격 provider 설정이 필요합니다.

## 원격 발행/수집 (sync · inbox)

로컬에서 작업한 위키를 원격 저장소에 **단방향(local→원격)** 으로 push하고(`sync`), 원격 inbox에서 새 정보를 가져옵니다(`inbox pull`). 원격 대상은 **provider**로 추상화되어 있으며, 현재 Notion을 지원합니다.

```bash
export LLMWIKI_NOTION_TOKEN_PERSONAL=secret_xxx
llmwiki sync personal --dry-run   # diff 미리보기 (토큰 없이도 가능)
llmwiki sync personal             # 없는/바뀐 페이지만 push
```

- 볼트별 설정은 `<vault>/_meta/remote.json`에 둡니다(토큰 제외, git 커밋). `provider`가 원격 대상을 결정합니다:
  ```json
  {
    "version": 1,
    "provider": "notion",
    "sync": { "databaseId": "…", "syncedSubdirs": ["wiki/entities", "wiki/concepts", "wiki/sources", "wiki/analyses"] },
    "inbox": { "databaseId": "…" },
    "allowSync": false
  }
  ```
- **토큰은 환경 변수에만** 둡니다(파일·git 금지). 조회 순서: `remote.json`의 `tokenEnv` → `LLMWIKI_<PROVIDER>_TOKEN_<VAULT>` → `LLMWIKI_<PROVIDER>_TOKEN` (예: `LLMWIKI_NOTION_TOKEN_PERSONAL`).
- 동기화 상태는 `_meta/remote-map.json`에 슬러그별 `remoteId`·콘텐츠 해시로 기록합니다. 해시가 바뀐 페이지만 갱신하고, 원격→local 역방향이나 원격 페이지 삭제는 하지 않습니다.
- `kind: secure` 볼트는 `remote.json`에 `"allowSync": true`가 있어야 하고, push 전 확인·익명화 게이트를 거칩니다.
- Notion provider는 `@notionhq/client`가 필요합니다(선택 의존성): `npm i @notionhq/client`.

### 새 provider 추가

원격 대상을 늘리려면 `src/providers/<name>.js`에 provider 인터페이스(`createClient`, 출력용 `createRemotePage`/`updateRemotePage`, 입력용 `listInboxItems`/`itemId`/`fetchInboxNote`)를 구현하고 `src/providers/index.js` 레지스트리에 한 줄 등록합니다. `sync`/`inbox` 오케스트레이터와 diff·상태 로직은 provider-중립이라 그대로 재사용됩니다. 볼트는 `remote.json`의 `provider` 값만 바꾸면 됩니다.

## 설계 원칙

- **볼트가 정본**: 실제 ingest/query/lint/reflect/publish 흐름은 각 볼트의 `CLAUDE.md`가 정의합니다.
- **얇은 라우터**: 이 패키지는 사용자 요청을 볼트로 라우팅하고 해당 볼트의 규칙에 위임합니다.
- **설정과 패키지 분리**: 패키지를 재설치·업데이트해도 사용자 레지스트리가 삭제되거나 덮어써지지 않습니다.
- **보안 경계 유지**: `secure` 볼트 쓰기는 확인과 익명화 절차를 거칩니다.

## 볼트 요구사항

각 볼트는 최소한 자체 `CLAUDE.md`(위키 스키마와 워크플로우) 및 `index.md`를 가지는 것을 권장합니다. Codex 전용 지침이 필요하면 `AGENTS.md`를 추가할 수 있습니다. `secure` 볼트는 보안 원칙을 명시해야 합니다.

표준 위키 스키마(3계층 `raw/` → `wiki/{entities,concepts,sources,analyses}` → `_meta/`, frontmatter·태그통제·index/log 규약)의 정본은 `templates/vault/`에 있습니다. 새 볼트는 `llmwiki vault scaffold <name>`으로 이 골격을 생성하고, `llmwiki vault lint <name>`으로 적합성을 검사할 수 있습니다. 기계 검사 계약은 각 볼트의 `_meta/schema.md`에 명문화되어 있습니다.

### 스키마 정본을 어디서 고치나

- **표준 스키마 정본**은 설치된 CLI 패키지의 `templates/vault/`입니다. 스키마 규칙 자체(디렉터리 골격, `CLAUDE.md` 워크플로우, `_meta/schema.md` 검사 계약)를 바꾸려면 이 패키지 파일을 수정합니다. 볼트마다 복사된 사본을 고치는 것이 아닙니다.
- `_meta/schema.md`의 검사 계약과 결정론 린터(`src/lint.js`)는 같은 규칙을 담습니다. **규칙을 바꾸면 두 곳을 함께 수정**해야 드리프트가 나지 않습니다.
- `vault scaffold`는 템플릿을 볼트로 **복사**할 뿐이며, **이미 있는 파일은 절대 덮어쓰지 않습니다**. 따라서 템플릿을 수정해도 기존 볼트의 사본은 그대로 유지되고, 새로 만드는 볼트(또는 아직 없던 파일)에만 반영됩니다.
- 개별 볼트 안에서는 그 볼트의 `CLAUDE.md`가 정본입니다(`설계 원칙 · 볼트가 정본`). 특정 볼트만 규칙을 달리하려면 그 볼트의 파일을 직접 조정하고, 모든 볼트에 적용할 표준을 바꾸려면 패키지 템플릿을 고칩니다.

## 개발

```bash
npm test
npm pack --dry-run
```

## 라이선스

MIT
