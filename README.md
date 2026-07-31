# llm-wiki

여러 개의 LLM 운영 마크다운 위키(볼트)를 **하나의 진입점**에서 운영하는 경량 CLI. Claude Code와 Codex 양쪽에서 동작한다.

지식 추가·검색·활용을 볼트마다 따로 오가지 않고 한 곳에서 하되, 각 볼트의 git 저장소·운영 규칙·보안 경계는 분리해서 유지한다.

## 철학

- **볼트가 정본.** 실제 위키 워크플로우(ingest / query / lint / reflect / publish)는 각 볼트의 `CLAUDE.md`가 정의한다. 이 CLI는 그 위에 얇은 **라우팅 계층**만 얹는다. 워크플로우 로직을 복제하지 않는다.
- **마크다운 우선, 빌드 없음.** 실행 바이너리·의존성 설치가 없다. 에이전트(Claude Code/Codex)가 이 저장소의 지침을 읽고 동작한다.
- **에이전트 중립.** 같은 명령이 Claude Code 슬래시 명령(`.claude/commands/`)과 Codex 태스크(`AGENTS.md`)로 노출된다.

## 구성

```
llm-wiki/                     이 CLI (public)
├── WIKI-CLI.md               라우팅 규칙 + 명령 카탈로그 (정본)
├── CLAUDE.md / AGENTS.md     에이전트별 라우터 진입점
├── wikis.example.md          볼트 레지스트리 템플릿
├── wikis.local.md            실제 볼트 목록 (gitignore, 사용자가 생성)
└── .claude/
    ├── commands/             슬래시 명령 (wiki-add / wiki-search / wiki-use / linkedin-draft)
    └── skills/linkedin-draft LinkedIn 프로필 초안 생성 스킬
```

## 시작하기

1. 이 저장소를 클론한다.
2. `wikis.example.md`를 `wikis.local.md`로 복사하고 자신의 볼트 경로를 등록한다.
   ```bash
   cp wikis.example.md wikis.local.md
   # wikis.local.md 편집: name / path / kind / signals
   ```
3. 이 디렉토리에서 Claude Code 또는 Codex를 연다.
   ```bash
   cd llm-wiki
   claude    # 또는 codex
   ```

## 볼트 레지스트리

`wikis.local.md`에 볼트를 한 행씩 등록한다:

| 필드 | 의미 |
|------|------|
| `name` | 볼트 식별자 (`--vault <name>`으로 지정) |
| `path` | 로컬 경로 |
| `kind` | `open`(일반) 또는 `secure`(쓰기 전 확인·익명화) |
| `signals` | 이 볼트로 라우팅할 내용 신호 |
| `notes` | 선택 |

## 명령

| 명령 | 설명 |
|------|------|
| `wiki-add` | 지식을 적절한 볼트에 추가(ingest) |
| `wiki-search` | 모든 볼트를 가로질러 검색 |
| `wiki-use` | 기존 지식으로 답하거나 새 분석 생성 |
| `linkedin-draft` | 커리어 자료 기반 LinkedIn 프로필 섹션 초안(텍스트만) |

라우팅·보안 경계 규칙은 [`WIKI-CLI.md`](WIKI-CLI.md) 참조.

## 볼트가 되려면

각 볼트는 자체 저장소로, 최소한 `CLAUDE.md`(위키 스키마·워크플로우)와 `index.md`를 가지면 된다. `secure` 볼트는 `CLAUDE.md`에 보안 원칙을 정의한다. 이 CLI는 그 규칙을 대신 정의하지 않고 위임할 뿐이다.

## 라이선스

MIT
