# llm-wiki 통합 라우터 (Claude Code)

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하는 CLI다.

**시작하기**: `wikis.local.md`에서 등록된 볼트 목록을 읽는다. 없으면 사용자에게 `wikis.example.md`를 복사해 만들도록 안내한다.

**작업 방법**: 라우팅 규칙과 명령 카탈로그는 [`WIKI-CLI.md`](WIKI-CLI.md)를 따른다. 실제 워크플로우(Ingest/Query/Lint/Reflect/Publish)는 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`가 정본이다. 여기서 워크플로우를 재기술하지 않는다.

명령: `wiki-add`, `wiki-search`, `wiki-use`, `linkedin-draft` (슬래시 명령은 `.claude/commands/` 참조).

`kind: secure` 볼트로 쓰기가 해소되면 `WIKI-CLI.md`의 보안 경계 절차를 반드시 따른다.
