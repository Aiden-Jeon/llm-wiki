# llm-wiki 통합 라우터 (Claude Code)

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하는 CLI다.

**시작하기**: `wikis.local.md`에서 등록된 볼트 목록을 읽는다. 설치형 CLI가 생성한 실행 워크스페이스에는 사용자 설정이 이 이름으로 동기화된다. 파일이 없으면 사용자에게 `llmwiki setup`을 실행하도록 안내한다.

**작업 방법**: 라우팅 규칙과 명령 카탈로그는 [`WIKI-CLI.md`](WIKI-CLI.md)를 따른다. 실제 워크플로우(Ingest/Query/Lint/Reflect/Publish)는 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`가 정본이다. 여기서 워크플로우를 재기술하지 않는다.

명령: `wiki-add`, `wiki-search`, `wiki-use` (슬래시 명령은 `.claude/commands/` 참조).

커스텀 스킬: 사용자가 `llmwiki skill`로 등록한 스킬 목록은 [`SKILLS.md`](SKILLS.md)에 있다. 정본은 `.claude/skills/<name>/SKILL.md`고, 스킬 추가·수정·삭제는 워킬스페이스 파일을 직접 고치지 않고 `llmwiki skill add|edit|remove`로 안내한다.

`kind: secure` 볼트로 쓰기가 해소되면 `WIKI-CLI.md`의 보안 경계 절차를 반드시 따른다.
