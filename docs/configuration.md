# 설정 가이드

llm-wiki의 사용자 설정은 패키지와 분리된 OS 표준 설정 디렉터리에 저장됩니다. 정확한 위치는 다음 명령으로 확인하거나 편집할 수 있습니다.

```bash
llmwiki config path
llmwiki config edit
```

기본 경로는 `${XDG_CONFIG_HOME:-~/.config}/llm-wiki/`이며 `LLM_WIKI_CONFIG_HOME`으로 재정의할 수 있습니다.

## 볼트 등록

`llmwiki setup`으로 초기 설정과 첫 볼트 등록을 함께 진행할 수 있습니다. 이후에는 `vault` 명령으로 관리합니다.

```bash
llmwiki vault add \
  --name personal \
  --path ~/wikis/personal \
  --signals "커리어,AI,논문" \
  --notes "개인 학습 자료"

llmwiki vault list
llmwiki vault show personal
llmwiki vault remove personal
llmwiki doctor
```

### 볼트 설정 항목

| 항목 | 필수 여부 | 설명 |
|---|---|---|
| `name` | 필수 | CLI에서 사용하는 고유 식별자 |
| `path` | local에서 필수 | 볼트의 로컬 경로. 절대 경로로 저장됨 |
| `backend` | 선택 | `local` 또는 `git`. 기본값은 `local` |
| `origin` | git에서 필수 | Git 원격 저장소 URL |
| `signals` | 선택 | 자동 라우팅에 사용할 쉼표 구분 주제·키워드 |
| `notes` | 선택 | 라우팅 시 참고할 용도와 특이사항 |

레지스트리는 하위호환을 위해 과거 `kind` 열이 포함된 표(7열/5열)도 읽으며, 이 경우 `kind` 값은 무시하고 재저장 시 현재 형식으로 정리합니다.

## Local과 Git backend

`local` backend는 현재 머신의 폴더를 그대로 사용합니다. `git` backend는 원격 저장소를 clone하고 `vault sync`로 여러 머신 사이에서 Markdown 원본을 동기화합니다.

```bash
llmwiki vault add \
  --name work \
  --backend git \
  --origin git@github.com:me/work-wiki.git
```

`path`를 생략하면 `~/llmwiki-vaults/<name>`에 clone합니다.

```bash
llmwiki vault sync work
llmwiki vault sync work --message "회의 노트 정리"
llmwiki vault sync work --pull-only
llmwiki vault sync work --no-push
```

동기화는 `pull --rebase --autostash` 후 변경 사항을 commit하고 push합니다. 시스템 Git의 SSH 키와 credential helper를 그대로 사용하며, llm-wiki 자체 데몬은 실행하지 않습니다.

## 볼트 스키마

```bash
llmwiki vault lint personal
llmwiki vault lint personal --json
llmwiki vault scaffold personal
```

`lint`는 볼트 구조와 스키마를 검사합니다. `scaffold`는 누락된 표준 구조를 생성하지만 기존 파일은 덮어쓰지 않습니다.

## 에이전트 선택

기본 에이전트는 자동으로 선택되며 환경 변수로 고정할 수 있습니다.

```bash
export LLM_WIKI_AGENT=claude   # 또는 codex
```

에이전트 옵션은 그대로 전달할 수 있습니다.

```bash
llmwiki claude --model sonnet
llmwiki start codex -- --model gpt-5
```

실행 명령을 다른 호환 CLI로 매핑하려면 `agent set`을 사용합니다. 현재 매핑과 정확한 옵션은 `llmwiki agent list`와 `llmwiki --help`에서 확인할 수 있습니다.

## 설정 export와 import

볼트 레지스트리와 커스텀 스킬을 다른 머신으로 옮길 수 있습니다.

```bash
# 기존 머신
llmwiki config export --output ~/llmwiki-settings.json

# 새 머신
llmwiki config import ~/llmwiki-settings.json --vaults-dir ~/llmwiki-vaults
```

- 원격 provider 토큰과 에이전트 실행 명령은 export하지 않습니다.
- Git 볼트는 origin에서 자동으로 clone합니다.
- Local 볼트는 머신마다 경로가 다를 수 있어 목록만 안내하며 수동 등록해야 합니다.
- 기존 스킬은 기본적으로 유지합니다. 덮어쓰려면 `--force`를 사용합니다.

## 커스텀 스킬

반복하는 사용자별 작업은 `SKILL.md`로 등록할 수 있습니다. 등록된 스킬은 Claude Code 슬래시 명령과 Codex 태스크로 함께 노출됩니다.

만드는 경로는 두 가지입니다. 쓸 만한 스킬은 "무엇을 자동화할지"와 "볼트에 근거가 실제로 있는지"에 달려 있어서, 보통은 에이전트와 함께 만드는 쪽을 권합니다.

### 에이전트와 함께 작성 (권장)

```bash
llmwiki skill new                 # 무엇을 만들지부터 인터뷰
llmwiki skill new weekly-retro    # 이름을 미리 정한 경우
llmwiki skill new "주간 회고를 만들어줘"
```

에이전트를 띄우고 `skill-author` 워크플로우를 시작합니다. 세션 안에서는 `/skill-author`로 직접 부를 수도 있습니다. 워크플로우는 이렇게 진행됩니다:

1. **인터뷰** — 반복 작업의 구체 사례, 트리거 발화, 입출력, 경계(하지 않을 일), 쓰기 여부를 확인합니다.
2. **근거 소스 실사** — 대상 볼트를 라우팅으로 해소하고 `index.md`로 필요한 자료가 실제로 있는지 확인합니다. 없으면 스킬을 쓰기 전에 알려 줍니다.
3. **초안 작성** — `llmwiki skill path <name>` 아래에 `SKILL.md`를 씁니다.
4. **검증** — `llmwiki skill lint`로 계약을 통과시킨 뒤, 1단계의 사례로 워크플로우를 그대로 실행해 봅니다(read-only dry-run). 빈틈이 나오면 고치고 다시 돌립니다.

### 결정론 스캐폴딩·가져오기

```bash
# 내장 템플릿에서 생성
llmwiki skill templates
llmwiki skill add linkedin-draft --template linkedin-draft

# 스켈레톤 생성 후 편집기로 열기
llmwiki skill add weekly-retro \
  --description "주간 회고 생성. '주간 회고', '이번 주 정리' 요청에 사용"

# 기존 파일이나 디렉터리 가져오기
llmwiki skill add paper-review --from ~/skills/paper-review
```

스켈레톤은 모든 지시문을 줄머리 `TODO:`로 남겨 두므로, 채우기 전까지 `llmwiki skill lint`가 `error`를 보고합니다. 생성 직후에도 미충족 항목 수를 함께 안내합니다. 검사는 이 표기 형태만 잡으므로, TODO 정리가 *주제*인 스킬은 본문에서 TODO를 자유롭게 언급할 수 있습니다.

### 검사와 관리

```bash
llmwiki skill list
llmwiki skill lint                # 전체 스킬 계약 검사
llmwiki skill lint weekly-retro --json
llmwiki skill show weekly-retro
llmwiki skill edit weekly-retro
llmwiki skill remove weekly-retro
```

`llmwiki skill lint`는 `llmwiki vault lint`와 같은 계층의 결정론 도구입니다. `error`가 있으면 종료 코드 1을 반환합니다. `llmwiki doctor`도 같은 검사 결과를 개수로 요약하지만, 계약을 덜 채운 스킬이 실행을 막는 것은 아니므로 `warn`까지만 올리고 종료 코드를 바꾸지 않습니다(실행 준비 점검과 계약 검사를 분리).

| 수준 | 검사 항목 |
|---|---|
| `error` | frontmatter `name`(디렉터리명과 일치)·`description`, `## 근거 소스`·`## 워크플로우` 섹션, 남아 있는 `TODO:`/`FIXME:` 표기, 예약된 이름 |
| `warn` | 너무 짧은 `description`, 트리거 발화 예시 없음, `## 입력`·`## 주의` 누락, 머신 의존 절대 경로, 볼트 라우팅 언급 없음 |

스킬 원본 위치는 `llmwiki skill path [name]`으로 확인할 수 있습니다. 이름은 `wiki-add`, `wiki-search`, `wiki-use`, `wiki-lint`, `skill-author`와 중복할 수 없습니다.

## 주요 환경 변수

| 변수 | 용도 |
|---|---|
| `LLM_WIKI_AGENT` | 기본 에이전트 (`claude` 또는 `codex`) |
| `LLM_WIKI_CONFIG_HOME` | 사용자 설정 디렉터리 재정의 |
| `LLM_WIKI_DATA_HOME` | 실행 워크스페이스 데이터 디렉터리 재정의 |

원격 provider 환경 변수는 [원격 발행 가이드](publishing.md)를 참고하세요.
