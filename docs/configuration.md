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

```bash
# 내장 템플릿에서 생성
llmwiki skill templates
llmwiki skill add linkedin-draft --template linkedin-draft

# 새 스킬을 만들고 편집기로 열기
llmwiki skill add weekly-retro \
  --description "주간 회고 생성. '주간 회고', '이번 주 정리' 요청에 사용"

# 기존 파일이나 디렉터리 가져오기
llmwiki skill add paper-review --from ~/skills/paper-review

llmwiki skill list
llmwiki skill show weekly-retro
llmwiki skill edit weekly-retro
llmwiki skill remove weekly-retro
```

스킬 원본 위치는 `llmwiki skill path [name]`으로 확인할 수 있습니다. `SKILL.md`에는 `name`과 `description` frontmatter가 필요하며, 이름은 `wiki-add`, `wiki-search`, `wiki-use`, `wiki-lint`와 중복할 수 없습니다.

## 주요 환경 변수

| 변수 | 용도 |
|---|---|
| `LLM_WIKI_AGENT` | 기본 에이전트 (`claude` 또는 `codex`) |
| `LLM_WIKI_CONFIG_HOME` | 사용자 설정 디렉터리 재정의 |
| `LLM_WIKI_DATA_HOME` | 실행 워크스페이스 데이터 디렉터리 재정의 |

원격 provider 환경 변수는 [원격 발행 가이드](publishing.md)를 참고하세요.
