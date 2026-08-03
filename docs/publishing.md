# 원격 발행 가이드

llm-wiki는 로컬 Markdown 위키를 원격 저장소에 단방향으로 발행하고, 원격 inbox의 새 항목을 로컬로 가져올 수 있습니다. 원격 대상은 provider로 추상화되어 있으며 현재 Notion을 지원합니다.

Git backend의 `vault sync`는 Markdown 파일 자체를 머신 사이에 공유합니다. `publish`는 읽기 좋은 위키 view를 원격 서비스에 만드는 별도 기능입니다.

## 시작하기

볼트를 먼저 등록한 뒤 발행 설정을 연결합니다.

```bash
llmwiki vault add --name personal --path ~/wikis/personal
llmwiki publish add personal
```

대화형 설정에서는 저장된 연결을 선택하거나 새 토큰을 추가한 뒤, 새 데이터베이스를 만들거나 기존 데이터베이스를 고를 수 있습니다. 저장 전에 토큰과 대상 접근 권한을 검증합니다.

```bash
llmwiki publish list
llmwiki publish personal --dry-run
llmwiki publish personal
llmwiki inbox pull personal --dry-run
llmwiki inbox pull personal
```

`publish`는 새 페이지와 내용이 변경된 페이지만 생성·갱신합니다. 원격 페이지를 로컬로 역동기화하거나 삭제하지 않습니다.

## 연결과 토큰

토큰은 이름 붙인 연결로 관리할 수 있습니다. 동일한 provider의 여러 워크스페이스를 서로 다른 이름으로 저장하고 여러 볼트에서 공유할 수 있습니다.

```bash
llmwiki connection add --remote notion --name personal --remote-token secret_xxx
llmwiki connection list
llmwiki connection remove personal
```

토큰은 설정 디렉터리의 `secrets.json`에 `0600` 권한으로 저장되며 Git과 `config export`에서 제외됩니다. 발행 대상과 연결 이름은 토큰이 없는 `publish.json`에 저장됩니다.

토큰 탐색 우선순위는 다음과 같습니다.

1. `publish.json`의 `tokenEnv`가 가리키는 환경 변수
2. `LLMWIKI_<PROVIDER>_TOKEN_<VAULT>`
3. `LLMWIKI_<PROVIDER>_TOKEN`
4. `secrets.json`에서 발행 설정이 지정한 연결

환경 변수가 저장된 토큰보다 우선하므로 CI나 스크립트에서 안전하게 덮어쓸 수 있습니다.

`publish remove <vault>`는 발행 설정을 제거합니다. 해당 연결이 고아가 된 경우에만 토큰 삭제 여부를 묻고, 다른 볼트가 공유하는 연결은 삭제하지 않습니다. 공유 연결을 명시적으로 지우려면 `connection remove`를 사용합니다.

## 비대화형 설정

CI에서는 연결과 데이터베이스 ID를 플래그로 지정할 수 있습니다.

```bash
llmwiki publish add personal \
  --remote notion \
  --connection personal \
  --remote-token secret_xxx \
  --publish-db <db-id> \
  --inbox-db <inbox-db-id>
```

저장된 연결을 재사용할 때는 `--remote-token`을 생략합니다.

## 설정과 상태

발행 설정은 전역 `publish.json`에서 볼트 이름별로 관리합니다.

```json
{
  "version": 1,
  "vaults": {
    "personal": {
      "provider": "notion",
      "connection": "personal",
      "publish": {
        "databaseId": "…",
        "syncedSubdirs": ["wiki/entities", "wiki/concepts", "wiki/sources", "wiki/analyses"]
      },
      "inbox": { "databaseId": "…" },
      "allowPublish": false
    }
  }
}
```

어디로 발행할지는 전역 설정에, 발행 상태는 볼트에 저장합니다.

- `_meta/remote-map.json` — 데이터베이스별 원격 페이지 ID와 콘텐츠 해시
- `_meta/remote-inbox.json` — 이미 가져온 inbox 항목 ID

상태 파일은 Git 볼트와 함께 이동하므로 여러 머신에서 중복 발행·수집하는 것을 방지합니다.

이전 버전의 `notion:<VAULT>`와 `notion:*` 토큰 키는 처음 읽을 때 named connection으로 자동 마이그레이션됩니다. 연결 이름이 없는 기존 발행 설정도 같은 규칙으로 해소됩니다.

## Notion 데이터베이스

Notion 연동에는 선택 의존성 `@notionhq/client`가 필요합니다. 설치 환경에서 빠져 있다면 다음 명령으로 추가합니다.

```bash
npm install @notionhq/client
```

각 Markdown 페이지는 데이터베이스의 한 행으로 발행됩니다.

| frontmatter | Notion 속성 | 타입 |
|---|---|---|
| `title` | `Name` 또는 지정된 title 속성 | Title |
| `type` | `Type` | Select |
| `status` | `Status` | Select |
| `tags` | `Tags` | Multi-select |
| `summary` | `Summary` | Text |
| `confidence` | `Confidence` | Select |
| `created` / `updated` | `Created` / `Updated` | Date |
| `source_url` | `Source URL` | URL |

새 데이터베이스를 선택하면 필요한 스키마를 생성합니다. 기존 데이터베이스에서는 누락된 속성을 추가할지 확인하며, 존재하지 않는 선택 속성은 발행 시 무시합니다.

첫 발행 때 다음 view를 자동 생성합니다.

- **All** — Updated 내림차순 Table
- **By Type** — Type으로 그룹화한 Board
- **Gallery** — 아이콘 중심 Gallery
- **Recent** — Updated 최신순 List

생성 여부는 데이터베이스별 `viewsCreated` 상태로 추적합니다. view를 다시 만들려면 다음 명령을 사용합니다.

```bash
llmwiki publish view personal
```

강제 재생성은 중복을 방지하지 않으므로 필요한 경우에만 실행합니다.

## Secure 볼트

`secure` 볼트는 발행 설정에 `allowPublish: true`가 있어야 하며 외부 전송 전에 확인과 익명화 절차를 거칩니다. 대화형 설정 또는 `publish add --allow-publish`로 명시적으로 허용해야 합니다.
