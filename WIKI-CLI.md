# llm-wiki — 통합 위키 CLI

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하기 위한 **라우팅 규칙**과 **명령 카탈로그**다. Claude Code와 Codex 양쪽에서 공유한다.

**핵심 원칙**: 이 문서는 라우팅만 정의한다. 실제 위키 워크플로우(Ingest / Query Filing / Lint / Reflect / Publish 등)는 **각 볼트의 `CLAUDE.md`가 정본**이다. 여기서 워크플로우 스텝을 재기술하지 않는다. 항상 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`를 따른다.

## 볼트 레지스트리

CLI는 볼트 목록을 **레지스트리 파일**에서 읽는다. 경로를 이 문서에 하드코딩하지 않는다.

- **사용자 설정 원본** — `llmwiki setup`이 OS 표준 설정 디렉터리에 생성한다. 경로는 `llmwiki config path`로 확인한다.
- **`wikis.local.md`** — CLI가 실행 워크스페이스에 사용자 설정 원본을 동기화한 레지스트리다.
- **`wikis.example.md`** — 레지스트리 형식의 참고 템플릿이다.

작업 시작 시 워크스페이스의 `wikis.local.md`를 읽어 등록된 볼트(name / path / 라우팅 신호)를 파악한다. 파일이 없으면 사용자에게 `llmwiki setup`을 실행하도록 안내한다.

레지스트리는 워크스페이스에서 직접 편집하지 않는다. 워크스페이스의 `wikis.local.md`는 매 실행마다 사용자 설정 원본으로 덮어써지는 사본이므로, 볼트를 추가·수정·삭제하려면 `llmwiki vault add|remove` 또는 `llmwiki config edit`를 안내한다. 표에 읽을 수 없는 행이 있으면 `llmwiki doctor`가 줄 번호와 함께 보고한다.

각 볼트 항목의 필드:

| 필드 | 의미 |
|------|------|
| `name` | 볼트 식별자 (예: `personal`, `work`) |
| `path` | 로컬 절대/상대 경로 |
| `backend` | `local` (그냥 폴더) 또는 `git` (git repo, `llmwiki vault sync`로 머신 간 동기화) |
| `origin` | git backend의 원격 URL (local이면 빈 값) |
| `signals` | 이 볼트로 라우팅할 내용 신호 (쉼표 구분) |
| `notes` | 선택. 원격 발행 대상, 특기사항 등 |

`backend`는 **마크다운 파일 저장·동기화** 계층이고, `§ 원격 발행`의 원격 provider(Notion 등)는 **위키 view 발행** 계층이다. 두 축은 독립적이다(git backend 볼트를 Notion에도 발행 가능). 레지스트리는 하위호환을 위해 레거시 4컬럼 표(backend/origin 없음)도 읽으며, 이 경우 `backend=local`로 승격한다.

## 라우팅 결정 절차

순서대로 적용한다. 결정론 우선, 애매하면 질문.

1. **명시적 지정 우선.** 사용자가 볼트를 지정하면(`--vault <name>`, "work 위키에", "personal에") 그대로 사용한다. 추측하지 않는다.
2. **내용 신호 (휴리스틱).** `wikis.local.md`의 각 볼트 `signals`와 대조해 추정한다.
3. **애매하면 질문.** 신호가 상충하거나 부족하면 멈추고 어느 볼트인지 묻는다. 동전던지기로 자동 파일링하지 않는다. (볼트 `CLAUDE.md`의 "가정하지 않는다" 원칙과 일치)
4. **검색/읽기는 기본 모든 볼트**, 쓰기는 정확히 한 볼트로 해소한다.

## 원격 연동 경계

금지: 볼트 간 raw 내용 이동. 한 볼트의 원격 토큰/대상을 다른 볼트 내용에 사용. 단일 호출로 여러 볼트에 동시 원격 쓰기(토큰·API 버전이 다를 수 있음).

원격 연동(`llmwiki publish`, `llmwiki inbox pull`)의 결정론 규칙:

- **발행 설정은 볼트와 분리 — 전역 config에.** 발행 설정(provider·대상 DB 등)은 볼트가 아니라 전역 config의 `publish.json`에 볼트 이름을 키로 둔다. 볼트는 이름으로 자기 엔트리를 참조만 한다. `설정=전역, 상태=볼트`: 발행 상태(`_meta/remote-map.json`, `_meta/remote-inbox.json`)만 볼트에 남겨 git 볼트와 함께 이동하게 하고(여러 머신에서 중복 발행 방지), 어디로·무엇을 발행할지는 볼트 밖에서 관리한다.
- **provider로 추상화.** 원격 대상은 `publish.json` 엔트리의 `provider` 값으로 결정한다(현재 지원: `notion`). 새 대상은 `src/providers/<name>.js` 구현 + 레지스트리 등록으로 붙고, orchestrator·diff 규칙은 provider-중립으로 공유된다. 발행 설정과 토큰은 `llmwiki publish add <vault>`로 설정하며(`vault add`와 분리), 저장 전 provider API(토큰 유효성 + 대상 DB 존재)로 검증한다. 대화형(TTY)이면 provider의 선택 메서드(`listDatabases`/`listPages`/`createDatabase`/`inspectDatabase`/`applySchema`)로 대상 DB를 새로 만들거나 기존 것을 고르게 하고(id 직접 입력 불필요), 그 메서드가 없거나 비-TTY면 `--publish-db`/`--inbox-db` 플래그로 폴백한다.
- **호출당 정확히 한 볼트.** `publish`/`inbox`는 대상 볼트를 하나로 해소하고 그 볼트의 토큰·대상만 쓴다("publish all" 없음).
- **토큰은 env 또는 설정 디렉터리 `secrets.json`의 named connection에만.** 마크다운 레지스트리·git·`publish.json`에는 저장하지 않는다. `secrets.json`은 config 디렉터리에 `0600`으로 두고 `.gitignore`·`config export` 번들에서 제외한다. 조회 순서: `publish.json` 엔트리의 `tokenEnv`(env) → `LLMWIKI_<PROVIDER>_TOKEN_<VAULT>`(env) → `LLMWIKI_<PROVIDER>_TOKEN`(env) → `secrets.json`의 연결(`publish.json` 엔트리의 `connection` 이름, 없으면 볼트 이름 기반 레거시 규칙). env가 store보다 우선이다. 하나의 연결을 여러 볼트가 공유할 수 있어 `publish remove`는 고아가 된 연결일 때만 토큰 삭제를 물어보고, 다른 볼트가 쓰는 공유 연결은 지우지 않는다(그런 토큰 삭제는 `connection remove`).

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

## 입력 소스 (터미널 명령)

에이전트 세션 밖, 터미널에서 직접 실행하는 진입 창구다. 세 창구는 서로 독립적이다.

- **`llmwiki new <입력>`** — 에이전트를 띄우고 그 세션에서 ingest(`wiki-add`) 워크플로우를 시작하는 shortcut이다. 입력은 URL/파일 경로/자유 텍스트. 라우팅·분류는 에이전트가 판단한다. 기본 `claude`/`codex`에는 초기 프롬프트를 주입하고, 커스텀 오버라이드 명령은 붙여넣을 프롬프트를 안내만 한다.
- **`llmwiki capture`** — 자유 텍스트 메모를 결정론적으로 대상 볼트의 `raw/notes/`에 저장한다(타임스탬프 파일명 + 최소 frontmatter). 저장 후 곧바로 ingest할지 물어본다. 대상은 `--vault`로 지정하거나 단일 볼트면 자동, 여러 개면 선택/에러.
- **`llmwiki inbox pull [vault]`** — 원격 inbox의 새 항목을 결정론적으로 `raw/notes/`로 가져온다. 이미 가져온 항목은 `_meta/remote-inbox.json`으로 중복을 막는다. 원격 대상은 provider로 추상화되며(현재 Notion), 설정·토큰은 `§ 원격 연동 경계`의 규칙을 따른다. 입력 창구는 앞으로 더 늘어날 수 있다.

## 볼트 백엔드 동기화 (터미널 명령)

- **`llmwiki vault sync [name] [--message <msg>] [--no-push] [--pull-only]`** — git backend 볼트의 **마크다운 파일 자체**를 원격 git repo와 동기화한다: `pull --rebase --autostash` → 변경 있으면 `commit` → `push`. local backend 볼트는 대상이 아니다(안내 후 건너뜀). "주기적" 실행은 사용자가 cron/launchd로 예약한다(데몬 없음). 이건 아래 원격 발행(view)과 다른 계층이다.

## 원격 발행 — 위키 view publish (터미널 명령)

- **`llmwiki publish [vault] [--dry-run] [--limit <n>]`** — 로컬 위키(`wiki/**`)를 원격 대상으로 **단방향(local→원격)** push해 view를 발행한다. diff를 떠 매핑에 없는 페이지는 생성, 콘텐츠 해시가 바뀐 페이지는 갱신하며, 원격→local이나 원격 페이지 삭제는 하지 않는다. 상태는 `_meta/remote-map.json`의 `databases[databaseId].pages[slug]`에 `remoteId`·`hash`로 기록한다. `--dry-run`은 토큰 없이 diff 요약만 낸다. 발행 설정은 전역 `publish.json` 엔트리로 관리하며(`llmwiki publish add`), 원격 대상은 그 엔트리의 `provider`, 쓸 토큰은 `connection`(named connection)으로 결정한다(현재 Notion). 설정·토큰은 `§ 원격 연동 경계`의 규칙을 따른다.
- **`llmwiki publish add [vault]` / `list` / `remove`** — 발행 설정을 관리하는 독립 명령군(`vault add`와 분리). `add`는 쓸 연결(named connection)과 대상 DB를 정해 provider API로 검증한 뒤 전역 `publish.json`에 엔트리(연결 이름 포함)를 저장한다. TTY에서는 저장된 연결 중 고르거나 새로 추가하고, 비대화형은 `--connection <name>`으로 재사용하거나 `--remote-token`으로 새로 저장한다(`--connection` 생략 시 연결 이름은 볼트 이름). `list`는 등록된 설정을(연결 이름과 함께) 보여준다. `remove`는 엔트리를 지우고, 그 볼트를 지운 뒤 해당 연결을 쓰는 볼트가 하나도 남지 않으면(고아 연결) 토큰도 지울지 물어본다(`--purge-token`/`--keep-token`으로 강제, 비대화형은 유지). 다른 볼트가 아직 쓰는 공유 연결은 절대 건드리지 않는다(그런 토큰 삭제는 `connection remove`).
- **`llmwiki connection add` / `list` / `remove`** — 원격 provider 토큰을 이름 붙여 관리하는 명령군. 같은 provider의 워크스페이스(계정)가 여럿일 때 각각 연결로 저장해 볼트마다 골라 쓴다. `add`는 이름·토큰을 받아 provider API로 검증한 뒤(검증에서 얻은 account를 함께) `secrets.json`에 저장한다(비대화형은 `--name`·`--remote-token` 필수). `list`는 저장된 연결과 그를 참조하는 볼트를 보여준다(토큰은 출력하지 않음). `remove <name>`은 토큰을 지우되, 그 연결을 쓰는 볼트가 있으면 경고하고 TTY에서는 확인을 받는다(비대화형은 `--force` 필요). 키 형식은 `<provider>:<connection>`이며, v1 볼트 토큰(`notion:<VAULT>` / `notion:*`)은 처음 로드 시 자동 마이그레이션된다.
- **뷰 탭 자동 생성** — 첫 `publish`에서 대상 DB에 뷰 탭(All/By Type/Gallery/Recent)을 자동 생성한다. `_meta/remote-map.json`의 DB별 `databases[databaseId].viewsCreated` 플래그로 idempotent하게 관리해 탭 중복을 막고, 생성 실패는 발행을 깨뜨리지 않는다(경고만). provider의 `createViews`에 위임하며 Notion은 Views API가 필요해 `@notionhq/client` 5.x에서만 동작한다. **`llmwiki publish view [vault]`** 는 이 뷰를 강제 재생성하는 명령이다(중복 방지 없음, 필요할 때만). 발행되는 각 행에는 `type`별 아이콘이 자동으로 붙는다.

> `vault sync`(git backend)는 마크다운 원본 파일을 머신 간에 공유하고, `publish`(provider)는 위키 view를 Notion 등에 발행한다. 서로 다른 계층이다.

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
