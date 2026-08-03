# 볼트 레지스트리 (예시)

설치 후 `llmwiki setup` 또는 `llmwiki vault add`로 사용자 레지스트리를 만든다. 이 파일은 형식을 보여주는 참고용 템플릿이다.

각 볼트는 아래 표에 한 행으로 등록한다.

- `name` — 볼트 식별자 (라우팅/명령에서 `--vault <name>`으로 지정)
- `path` — 볼트의 로컬 절대 경로 (`vault add` 사용 시 `~` 확장 및 절대 경로 변환)
- `kind` — `open`(일반) 또는 `secure`(보안 규칙 적용: 쓰기 전 확인·익명화)
- `signals` — 이 볼트로 라우팅할 내용 신호 (쉼표 구분)
- `notes` — 선택. Notion 대상, 특기사항

## 볼트

| name | path | kind | signals | notes |
|------|------|------|---------|-------|
| personal | /Users/you/wikis/personal | open | 커리어, resume, LinkedIn, 일반 AI/ML 학습, 논문, 공개 아티클 | 커리어 자료 보유 |
| work | /Users/you/wikis/work | secure | 고객명, 사내 제품/기능, Slack/회의/내부 출처, 프로젝트 코드, 내부 URL | private 유지, 사례 익명화 |

## 에이전트 실행 명령 (선택)

`claude`/`codex` 논리 이름을 다른 실행 명령으로 재정의한다. 미설정 시 이름 그대로 실행한다. `llmwiki agent set <name> [--add-dir] <cmd>`로 관리한다.

add-dir 열이 `yes`면 등록된 볼트를 `--add-dir <경로>`로 넘긴다(claude/codex 기본). vibe처럼 이 플래그를 받지 않는 wrapper는 `no`로 두며, 볼트는 워크스페이스의 `vaults/` 심볼릭 링크로 노출된다.

| agent | command | add-dir |
|-------|---------|---------|
| claude | vibe agent | no |
| codex | dbexec repo run isaac | no |
