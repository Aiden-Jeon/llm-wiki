# llm-wiki 통합 라우터 (Codex)

여러 개의 LLM 운영 마크다운 위키(볼트)를 하나의 진입점에서 운영하는 CLI다.

**시작하기**: `wikis.local.md`에서 등록된 볼트 목록을 읽는다. 없으면 사용자에게 `wikis.example.md`를 복사해 만들도록 안내한다.

**작업 방법**: 라우팅 규칙과 명령 카탈로그는 [`WIKI-CLI.md`](WIKI-CLI.md)를 따른다. 실제 워크플로우는 대상 볼트로 `cd`한 뒤 그 볼트의 `CLAUDE.md`(및 `AGENTS.md`가 있으면 그것)가 정본이다. 여기서 워크플로우를 재기술하지 않는다.

## 태스크

Codex가 이 CLI에서 직접 실행될 때 다음 태스크를 지원한다. 각 태스크는 `WIKI-CLI.md`의 해당 섹션으로 라우팅하고 대상 볼트로 핸드오프한다.

- **wiki-add** — 지식 추가(ingest). `WIKI-CLI.md § wiki-add`.
- **wiki-search** — 크로스볼트 검색. `WIKI-CLI.md § wiki-search`.
- **wiki-use** — 기존 지식 활용. `WIKI-CLI.md § wiki-use`.
- **linkedin-draft** — LinkedIn 프로필 초안(텍스트만). `WIKI-CLI.md § linkedin-draft`.

`kind: secure` 볼트로 쓰기가 해소되면 `WIKI-CLI.md`의 보안 경계 절차를 반드시 따른다. 볼트로 `cd`한 뒤에는 그 볼트의 `AGENTS.md`(있으면)가 Codex 운영 규칙을 이어받는다.
