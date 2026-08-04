// CLI 사용법 문자열과 옵션 키 상수. 순수 데이터만 두어 명령 핸들러가 공유한다.

export const VAULT_OPTION_KEYS = ['name', 'path', 'backend', 'origin', 'signals', 'notes'];
export const VAULT_BOOLEAN_KEYS = [];
export const VAULT_ADD_USAGE = 'llmwiki vault add --name <name> [--path <path>] [--backend local|git] [--origin <git-url>] [--signals <신호>] [--notes <메모>]';
export const VAULT_SYNC_USAGE = 'llmwiki vault sync [name] [--message <msg>] [--no-push] [--pull-only]';
export const CAPTURE_USAGE = 'llmwiki capture [--vault <name>] [--title <제목>] [--text <내용>]';
export const PUBLISH_USAGE = 'llmwiki publish [vault] [--dry-run] [--limit <n>]';
export const PUBLISH_ADD_USAGE = 'llmwiki publish add [vault] [--remote <provider>] [--connection <name>] [--remote-token <token>] [--publish-db <id>] [--inbox-db <id>] [--title-prop <name>]';
export const PUBLISH_REMOVE_USAGE = 'llmwiki publish remove [vault] [--purge-token | --keep-token]';
export const PUBLISH_LIST_USAGE = 'llmwiki publish list [--json]';
export const PUBLISH_VIEW_USAGE = 'llmwiki publish view [vault]';
export const CONNECTION_ADD_USAGE = 'llmwiki connection add [--remote <provider>] [--name <name>] [--remote-token <token>]';
export const CONNECTION_LIST_USAGE = 'llmwiki connection list [--json]';
export const CONNECTION_REMOVE_USAGE = 'llmwiki connection remove [name] [--remote <provider>] [--force]';
export const CONFIG_EXPORT_USAGE = 'llmwiki config export [--output <file>]';
export const CONFIG_IMPORT_USAGE = 'llmwiki config import <file> [--vaults-dir <dir>] [--force]';
export const INBOX_USAGE = 'llmwiki inbox pull [vault] [--dry-run] [--limit <n>]';
export const SKILL_ADD_USAGE = 'llmwiki skill add <name> [--description <설명>] [--from <경로>] [--template <name>] [--force] [--no-edit]';
export const RESET_USAGE = 'llmwiki reset [--purge-vaults] [--force]';

export const HELP = `llmwiki — 여러 LLM Markdown 위키를 한 곳에서 운영합니다.

사용법:
  llmwiki                         설정된 에이전트로 시작
  llmwiki start [claude|codex] [-- <agent args>]
  llmwiki claude [agent args]     Claude Code로 바로 시작
  llmwiki codex [agent args]      Codex로 바로 시작
  llmwiki new <url|경로|텍스트>    에이전트를 띄워 입력을 ingest
  llmwiki capture [options]       자유 텍스트 메모를 볼트 raw/notes/에 저장
  llmwiki publish [vault] [--dry-run] [--limit <n>]   로컬 위키를 원격에 발행 (view, 단방향)
  llmwiki publish add [vault] [options]  볼트에 원격 provider를 연결 (발행 설정)
  llmwiki publish list [--json]   등록된 발행 설정 목록
  llmwiki publish remove [vault]  발행 설정 삭제(고아가 된 연결이면 토큰 삭제 여부를 물어봄)
  llmwiki connection add [options]  원격 provider 토큰을 이름 붙여 저장 (워크스페이스별 연결)
  llmwiki connection list [--json]  저장된 연결 목록
  llmwiki connection remove [name]  저장된 연결(토큰) 삭제 (생략 시 목록에서 선택)
  llmwiki inbox pull [vault] [--dry-run] [--limit <n>]  원격 inbox의 새 항목을 가져옴
  llmwiki setup                   초기 설정 및 볼트 등록
  llmwiki vault add [options]     볼트 추가/수정
  llmwiki vault list [--json]     등록된 볼트 목록
  llmwiki vault show [name]       볼트 상세 정보 및 상태 (생략 시 목록에서 선택)
  llmwiki vault remove [name]     볼트 제거 (생략 시 목록에서 선택)
  llmwiki vault lint [name] [--json]  볼트가 위키 스키마를 지키는지 검사
  llmwiki vault scaffold [name]   누락된 스키마 구조를 생성 (기존 파일 보존)
  llmwiki vault sync [name] [--message <msg>] [--no-push] [--pull-only]  git 백엔드 볼트 동기화
  llmwiki agent list [--json]     에이전트 실행 명령 매핑 확인
  llmwiki agent set [name] [--add-dir] <cmd> [-- <명령 인자>]  claude/codex를 다른 명령으로 실행
  llmwiki agent reset [name]      실행 명령을 기본값(claude/codex)으로 복원 (생략 시 목록에서 선택)
  llmwiki skill list [--json]     등록된 커스텀 스킬 목록
  llmwiki skill add <name>        커스텀 스킬 생성/가져오기
  llmwiki skill show [name]       스킬 상세 정보 (생략 시 목록에서 선택)
  llmwiki skill edit [name]       $EDITOR로 SKILL.md 편집 (생략 시 목록에서 선택)
  llmwiki skill remove [name]     스킬 삭제 (생략 시 목록에서 선택)
  llmwiki skill templates         내장 스킬 템플릿 목록
  llmwiki skill path [name]       스킬 디렉터리 경로 출력
  llmwiki doctor                  설정·볼트·스킬·에이전트 상태 진단
  llmwiki reset [--purge-vaults] [--force]   모든 사용자 설정을 지워 setup 이전 상태로 초기화
  llmwiki config path             설정 파일 경로 출력
  llmwiki config edit             $EDITOR로 설정 편집
  llmwiki config export [--output <file>]        설정(볼트·스킬)을 JSON 번들로 내보내기
  llmwiki config import <file> [--vaults-dir <dir>] [--force]  다른 머신의 설정 가져오기

vault add 옵션:
  --name <name> [--path <path>]
  [--backend local|git] [--origin <git-url>]
  [--signals <쉼표 구분 신호>] [--notes <메모>]
  원격 발행 연결은 볼트와 분리돼 있습니다 → llmwiki publish add <vault> 참고.

볼트 백엔드:
  local  이 머신의 폴더 (기본값)
  git    git repo. --origin으로 clone하고(path 생략 시 ~/llmwiki-vaults/<name>),
         llmwiki vault sync로 pull→commit→push해 여러 머신에서 같은 위키를 작업

skill add 옵션:
  --description <설명>   에이전트가 언제 이 스킬을 쓸지 판단할 기준
  --from <경로>          기존 SKILL.md 파일이나 스킬 디렉터리를 가져옴
  --template <name>      내장 템플릿에서 생성 (llmwiki skill templates)
  --force                같은 이름의 스킬을 덮어씀
  --no-edit              생성 후 편집기를 열지 않음

추가 정보:
  signals 요청을 이 볼트로 자동 연결할 주제·키워드 (예: 커리어, 이력서, 논문)
  notes   에이전트가 알아야 할 볼트의 용도·특이사항 (예: 커리어 자료 보유)

에이전트 실행 명령:
  claude/codex는 논리 이름이며, 실제 실행 명령을 재정의할 수 있습니다.
  예) claude가 vibe를, codex가 isaac을 실행하도록:
    llmwiki agent set claude vibe agent
    llmwiki agent set codex dbexec repo run isaac
  기본적으로 커스텀 명령에는 볼트 --add-dir 인자를 붙이지 않습니다(vibe 등은 이 플래그를
  받지 않음). claude/codex 원본처럼 --add-dir를 붙이려면 --add-dir 플래그를 추가하세요.
  실행 명령 자체가 --add-dir 같은 대시 옵션을 받아야 하면 -- 뒤에 두세요:
    llmwiki agent set codex mycli -- --add-dir .   (-- 뒤는 그대로 명령 인자로 보존)
  --add-dir를 안 붙이는 경우에도 등록된 볼트는 워크스페이스의 vaults/ 심볼릭 링크로 노출됩니다.
  매핑은 설정 파일(llmwiki config path)에 저장됩니다.

capture 옵션:
  --vault <name>   대상 볼트 (미지정 시 단일 볼트면 자동, 여러 개면 선택/에러)
  --title <제목>   메모 제목 (파일명 slug·frontmatter에 사용)
  --text <내용>    메모 본문 (미지정 시 TTY 프롬프트, 파이프면 stdin)

원격 연동 (publish/inbox):
  발행 설정은 볼트와 분리돼 전역 config의 publish.json에 볼트 이름으로 둡니다 (토큰 제외).
    { "version": 1, "vaults": { "personal": { "provider": "notion",
        "publish": { "databaseId": "…" }, "inbox": { "databaseId": "…" } } } }
  llmwiki publish add <vault>로 이 엔트리를 생성하고 토큰을 secrets.json(0600)에 저장합니다.
  대화형(TTY)이면 대상 데이터베이스를 새로 만들거나 기존 목록에서 고를 수 있어(DB id 직접 입력 불필요),
  비대화형은 --publish-db/--inbox-db로 id를 직접 지정합니다.
  provider가 원격 대상을 결정합니다(현재 지원: notion). publish는 wiki/** 페이지를
  단방향 push해 view를 발행하고, 발행 상태는 <vault>/_meta/remote-map.json에 기록합니다
  (설정=전역, 상태=볼트: 상태는 git 볼트와 함께 이동해 여러 머신에서 중복 발행을 막습니다).
  Notion provider는 @notionhq/client가 필요합니다:
  npm i @notionhq/client

토큰 저장·해소 순서 (앞이 우선):
  1. publish.json 엔트리의 tokenEnv가 가리키는 환경 변수
  2. LLMWIKI_<PROVIDER>_TOKEN_<VAULT>  (환경 변수)
  3. LLMWIKI_<PROVIDER>_TOKEN          (환경 변수)
  4. 설정 디렉터리 secrets.json         (0600, git·config export 제외)
  환경 변수가 secrets.json보다 우선합니다(CI·스크립트가 저장 토큰을 덮어쓸 수 있게).

환경 변수:
  LLM_WIKI_AGENT       기본 에이전트 (claude 또는 codex)
  LLM_WIKI_CONFIG_HOME 설정 디렉터리 재정의
  LLM_WIKI_DATA_HOME   런타임 데이터 디렉터리 재정의
  LLMWIKI_<PROVIDER>_TOKEN          원격 토큰 (모든 볼트 공통 폴백, 예: LLMWIKI_NOTION_TOKEN)
  LLMWIKI_<PROVIDER>_TOKEN_<VAULT>  볼트별 원격 토큰 (예: LLMWIKI_NOTION_TOKEN_PERSONAL)`;
