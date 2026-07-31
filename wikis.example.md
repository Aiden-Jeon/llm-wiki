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
