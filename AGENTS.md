# llm-wiki 통합 라우터 (Codex)

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하는 CLI다.

**시작하기**: `wikis.local.md`에서 등록된 볼트 목록을 읽는다. 설치형 CLI가 생성한 실행 워크스페이스에는 사용자 설정이 이 이름으로 동기화된다. 파일이 없으면 사용자에게 `llmwiki setup`을 실행하도록 안내한다.

**작업 방법**: 라우팅 규칙과 명령 카탈로그는 [`WIKI-CLI.md`](WIKI-CLI.md)를 따른다. 실제 워크플로우는 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`(및 `AGENTS.md`가 있으면 그것)가 정본이다. 여기서 워크플로우를 재기술하지 않는다.

## 태스크

Codex가 이 CLI에서 직접 실행될 때 다음 태스크를 지원한다. 각 태스크는 `WIKI-CLI.md`의 해당 섹션으로 라우팅하고 대상 볼트로 핸드오프한다.

- **wiki-add** — 지식 추가(ingest). `WIKI-CLI.md § wiki-add`.
- **wiki-search** — 크로스볼트 검색. `WIKI-CLI.md § wiki-search`.
- **wiki-use** — 기존 지식 활용. `WIKI-CLI.md § wiki-use`.
- **wiki-lint** — 스키마 적합성 평가·수정. `WIKI-CLI.md § wiki-lint` (`llmwiki vault lint`/`scaffold` 활용).

사용자가 등록한 **커스텀 스킬**은 `SKILLS.md` 카탈로그에 있다. 그 이름으로 호출되면 `.claude/skills/<name>/SKILL.md`를 정본으로 삼아 실행하고, 생성·수정·삭제 요청은 `llmwiki skill add|edit|remove`로 안내한다. 상세는 `WIKI-CLI.md § 커스텀 스킬`.

`kind: secure` 볼트로 쓰기가 해소되면 `WIKI-CLI.md`의 보안 경계 절차를 반드시 따른다. 볼트로 `cd`한 뒤에는 그 볼트의 `AGENTS.md`(있으면)가 Codex 운영 규칙을 이어받는다.
