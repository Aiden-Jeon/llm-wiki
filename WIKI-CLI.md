# llm-wiki — 통합 위키 CLI

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하기 위한 **라우팅 규칙**과 **명령 카탈로그**다. Claude Code와 Codex 양쪽에서 공유한다.

**핵심 원칙**: 이 문서는 라우팅만 정의한다. 실제 위키 워크플로우(Ingest / Query Filing / Lint / Reflect / Publish 등)는 **각 볼트의 `CLAUDE.md`가 정본**이다. 여기서 워크플로우 스텝을 재기술하지 않는다. 항상 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`를 따른다.

## 볼트 레지스트리

CLI는 볼트 목록을 **레지스트리 파일**에서 읽는다. 경로를 이 문서에 하드코딩하지 않는다.

- **사용자 설정 원본** — `llmwiki setup`이 OS 표준 설정 디렉터리에 생성한다. 경로는 `llmwiki config path`로 확인한다.
- **`wikis.local.md`** — CLI가 실행 워크스페이스에 사용자 설정 원본을 동기화한 레지스트리다.
- **`wikis.example.md`** — 레지스트리 형식의 참고 템플릿이다.

작업 시작 시 워크스페이스의 `wikis.local.md`를 읽어 등록된 볼트(name / path / kind / 라우팅 신호)를 파악한다. 파일이 없으면 사용자에게 `llmwiki setup`을 실행하도록 안내한다.

레지스트리는 워크스페이스에서 직접 편집하지 않는다. 워크스페이스의 `wikis.local.md`는 매 실행마다 사용자 설정 원본으로 덮어써지는 사본이므로, 볼트를 추가·수정·삭제하려면 `llmwiki vault add|remove` 또는 `llmwiki config edit`를 안내한다. 표에 읽을 수 없는 행이 있으면 `llmwiki doctor`가 줄 번호와 함께 보고한다.

각 볼트 항목의 필드:

| 필드 | 의미 |
|------|------|
| `name` | 볼트 식별자 (예: `personal`, `work`) |
| `path` | 로컬 절대/상대 경로 |
| `kind` | `open` (일반) 또는 `secure` (보안 규칙 적용 — 쓰기 전 확인·익명화) |
| `backend` | `local` (그냥 폴더) 또는 `git` (git repo, `llmwiki vault sync`로 머신 간 동기화) |
| `origin` | git backend의 원격 URL (local이면 빈 값) |
| `signals` | 이 볼트로 라우팅할 내용 신호 (쉼표 구분) |
| `notes` | 선택. 원격 발행 대상, 특기사항 등 |

`backend`는 **마크다운 파일 저장·동기화** 계층이고, `§ 원격 발행`의 원격 provider(Notion 등)는 **위키 view 발행** 계층이다. 두 축은 독립적이다(git backend 볼트를 Notion에도 발행 가능). 레지스트리는 하위호환을 위해 레거시 5컬럼 표(backend/origin 없음)도 읽으며, 이 경우 `backend=local`로 승격한다.

## 라우팅 결정 절차

순서대로 적용한다. 결정론 우선, 애매하면 질문.

1. **명시적 지정 우선.** 사용자가 볼트를 지정하면(`--vault <name>`, "work 위키에", "personal에") 그대로 사용한다. 추측하지 않는다.
2. **내용 신호 (휴리스틱).** `wikis.local.md`의 각 볼트 `signals`와 대조해 추정한다.
3. **애매하면 질문.** 신호가 상충하거나 부족하면 멈추고 어느 볼트인지 묻는다. 동전던지기로 자동 파일링하지 않는다. (볼트 `CLAUDE.md`의 "가정하지 않는다" 원칙과 일치)
4. **검색/읽기는 기본 모든 볼트**, 쓰기는 정확히 한 볼트로 해소한다.

## 원격 연동 경계

금지: 볼트 간 raw 내용 이동. 한 볼트의 원격 토큰/대상을 다른 볼트 내용에 사용. 단일 호출로 여러 볼트에 동시 원격 쓰기(토큰·API 버전이 다를 수 있음).

원격 연동(`llmwiki publish`, `llmwiki inbox pull`)에서 **반드시 지킬 규칙**:

- **호출당 정확히 한 볼트.** `publish`/`inbox`는 대상 볼트를 하나로 해소하고 그 볼트의 토큰·대상만 쓴다("publish all" 없음).
- **토큰은 코드/git 밖에만.** 토큰은 env 또는 설정 디렉터리의 `secrets.json`(`0600`, `.gitignore`·`config export`에서 제외)에만 둔다. 마크다운 레지스트리·git·`publish.json`에는 절대 저장하지 않는다.

`설정=전역, 상태=볼트` 원칙: 어디로·무엇을 발행할지(설정)는 전역 `publish.json`에 볼트 이름을 키로 두고, 발행 상태(`_meta/remote-map.json`, `_meta/remote-inbox.json`)만 볼트에 남겨 git 볼트와 함께 이동하게 한다(여러 머신에서 중복 발행 방지).

토큰 조회 순서 — 먼저 맞는 것에서 멈춘다. env가 저장소보다 항상 우선:

```text
1. publish.json 엔트리의 tokenEnv 가 가리키는 env
2. env  LLMWIKI_<PROVIDER>_TOKEN_<VAULT>
3. env  LLMWIKI_<PROVIDER>_TOKEN
4. secrets.json 의 연결 (엔트리의 connection 이름, 없으면 볼트 이름)
```

발행 설정·연결 관리·provider 확장·DB 매핑 등 운영 상세는 [원격 발행 가이드](docs/publishing.md)와 [아키텍처 § Provider 확장](docs/architecture.md)에 위임한다.

## 명령 카탈로그

각 명령은 얇은 shim이다: 라우팅 → `cd <vault>` → 그 볼트 `CLAUDE.md`의 워크플로우 실행. 워크플로우 스텝은 볼트 `CLAUDE.md` 참조.

### wiki-add — 지식 추가 (ingest)

1. 라우팅 절차로 대상 볼트 해소. (URL/파일/Notion URL/텍스트 모두 입력 가능)
2. `cd <vault>`.
3. 그 볼트 `CLAUDE.md`의 **Ingest** 워크플로우를 그대로 실행.
4. 커밋은 각 볼트의 git 접두사 규칙을 따른다.

### wiki-search — 크로스볼트 검색

검색 인프라 없이 index 중심으로 운영한다 (과도한 도구화 금지). 신규 툴링 없음:

1. 각 볼트의 `index.md`(있으면)를 1차 검색면으로 읽는다.
2. 부족하면 각 볼트 `wiki/**/*.md`의 frontmatter(title/tags/summary)·헤딩을 read-only `grep`/`find`로 검색한다. 임베딩·DB 없음.
3. 결과를 병합하고 각 히트에 볼트 `name` 라벨을 붙이고 주제별 중복을 제거한다.

### wiki-use — 기존 지식 활용

1. `wiki-search`로 관련 페이지를 찾는다.
2. 해소된 볼트의 **Query Filing** 워크플로우를 적용한다: 일회성이면 채팅으로만 답하고, 재사용 가치가 있으면 그 볼트 `wiki/analyses/`(또는 해당 볼트 규칙의 위치)에 파일링하고 index·log를 갱신한다.
3. 크로스볼트 종합 답변은 기본적으로 일반 지식을 담는 볼트에 파일링한다.

### wiki-lint — 스키마 적합성 평가·수정

볼트가 위키 스키마(구조·frontmatter·태그·index/log·링크)를 지키는지 평가하고, 수정 사항을
권고한 뒤 확인을 받아 적용한다. 결정론 검사와 LLM 내용 판단을 계층으로 결합한다.

1. `llmwiki vault lint [name] [--json]` — 결정론 검사 도구. 라우터가 각 볼트를
   `_meta/schema.md` 계약에 대해 검사한다(구조 누락은 `error`, 태그 drift·고아·형식은 `warn`).
   워크플로우가 아니라 `llmwiki doctor`와 같은 진단 도구다.
2. 도구가 못 잡는 내용 품질(중복 페이지, 오래된 요약, synthesis 미표기 등)은 대상 볼트로
   `cd`한 뒤 그 볼트 `CLAUDE.md`의 **Lint** 워크플로우로 판단한다.
3. 구조 누락 교정은 `llmwiki vault scaffold [name]`로 한다(템플릿 스켈레톤을 가산적으로 생성,
   기존 파일은 절대 덮어쓰지 않음). 신규 볼트 부트스트랩도 이 명령을 쓴다.

## 입력 소스 (지식이 들어오는 창구)

지식이 볼트로 들어오는 창구들이다. 서로 독립적이며, "어디에 착지하는지"로 성격이 갈린다.

| 창구 | 무엇을 | 어디에 착지 | 언제 쓰나 |
|------|--------|-------------|-----------|
| `wiki-add` (Ingest) | URL·파일·텍스트·Notion URL | 정식 ingest → `wiki/**` | 세션 안에서 정제된 지식으로 편입할 때 |
| `llmwiki new <입력>` | URL·파일·자유 텍스트 | (에이전트를 띄워 `wiki-add`로) | 터미널에서 바로 ingest를 시작하는 shortcut |
| `llmwiki capture` | 자유 텍스트 메모 | `raw/notes/` (결정론) | 나중에 정제할 메모를 빠르게 던져둘 때 |
| `llmwiki inbox pull [vault]` | 원격 inbox 항목 | `raw/notes/` (결정론) | 원격(현재 Notion)에 모인 항목을 회수할 때 |

착지 규칙: `new`는 `wiki-add`의 shortcut이라 정식 ingest로 이어지고, `capture`·`inbox pull`은 **`raw/notes/`에 원본으로만** 착지한 뒤(저장 후 곧바로 ingest할지 물어봄) 나중에 `wiki-add`로 정제된다.

- `capture` 대상은 `--vault`로 지정하거나 단일 볼트면 자동, 여러 개면 선택/에러. `inbox pull`은 이미 가져온 항목을 `_meta/remote-inbox.json`으로 중복 방지한다.
- `inbox pull`의 원격 설정·토큰은 [`§ 원격 연동 경계`](#원격-연동-경계)를 따른다.

## 나가는 계층 — 동기화와 발행

볼트 밖으로 나가는 두 계층은 **독립적**이다. 헷갈리지 않게 축으로 구분한다.

| 계층 | 명령 | 무엇이 오가나 | 방향 |
|------|------|----------------|------|
| **Git backend 동기화** | `llmwiki vault sync` | 마크다운 **원본 파일** | 양방향 (git pull/push) |
| **원격 view 발행** | `llmwiki publish` | 위키 **view** (Notion 등) | 단방향 (local→원격) |

한 볼트가 두 계층을 동시에 쓸 수 있다(git 볼트를 Notion에도 발행). 라우팅 관점에서 기억할 것은 이 경계뿐이고, 각 명령의 플래그·상태 파일·DB 매핑·view 탭 등 운영 상세는 정본 문서에 위임한다.

- **동기화**: git backend 볼트만 대상. `pull --rebase --autostash` → commit → push. 상세는 [설정 가이드 § Local과 Git backend](docs/configuration.md).
- **발행**: `wiki/**`를 원격으로 단방향 push(생성·갱신만, 삭제·역동기화 없음). 설정·토큰·연결·view 상세는 [원격 발행 가이드](docs/publishing.md)와 위 [`§ 원격 연동 경계`](#원격-연동-경계).

## 설정 export / import (터미널 명령)

- **`llmwiki config export [--output <file>]`** / **`llmwiki config import <file> [--vaults-dir <dir>] [--force]`** — 볼트 레지스트리 + 커스텀 스킬을 JSON 번들로 옮긴다(머신 이관용). 환경 변수와 `secrets.json`에 있는 토큰, 에이전트 오버라이드(머신별)는 제외한다. import 시 git backend 볼트는 origin으로 자동 clone해 등록하고, local 볼트는 경로를 알 수 없어 등록하지 않고 목록으로 안내한다.

## 커스텀 스킬

사용자마다 다른 작업(예: LinkedIn 프로필 초안, 주간 회고)은 라우터에 내장하지 않고 **커스텀 스킬**로 등록한다. 스킬 원본은 사용자 설정 디렉터리(`llmwiki skill path`)에 있고, 매 실행마다 이 워크스페이스의 `.claude/skills/`로 동기화된다.

- **목록**: 자동 생성되는 [`SKILLS.md`](SKILLS.md) 카탈로그가 등록된 스킬·호출명·설명을 모아 준다. 직접 편집하지 않는다.
- **정본**: 개별 스킬의 워크플로우는 `.claude/skills/<name>/SKILL.md`다.
- **라우팅**: 스킬도 이 문서의 라우팅 절차를 그대로 따른다. 대상 볼트를 해소한 뒤 `cd <vault>`한다.
- **관리**: 사용자가 스킬 추가·수정·삭제를 원하면 워크스페이스 파일을 직접 고치지 않고 `llmwiki skill add|edit|remove`를 안내한다(워크스페이스 사본은 매 실행 덮어써진다).
- 내장 템플릿은 `llmwiki skill templates`로 확인한다 (예: `linkedin-draft`).

스킬 이름은 내장 명령(`wiki-add`, `wiki-search`, `wiki-use`, `wiki-lint`)과 중복할 수 없다.

## 듀얼 에이전트

- **Claude Code**: 내장 명령과 커스텀 스킬이 모두 `.claude/commands/*.md` 슬래시 명령으로 노출된다(스킬 명령 파일은 CLI가 생성한다).
- **Codex**: 내장 명령은 `AGENTS.md` 태스크 목록, 커스텀 스킬은 `SKILLS.md` 카탈로그로 노출된다. 두 표면 모두 이 문서로 라우팅하고 볼트 `CLAUDE.md`로 위임한다.

내장 슬래시 명령은 `AGENTS.md`에 대응 태스크가 있어야 한다(패리티). 커스텀 스킬의 패리티는 `SKILLS.md`가 담당한다.
