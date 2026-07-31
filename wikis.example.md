# 볼트 레지스트리 (예시)

이 파일을 `wikis.local.md`로 복사한 뒤 자신의 볼트에 맞게 수정한다. `wikis.local.md`는 git에 커밋되지 않는다(`.gitignore`).

각 볼트는 아래 표에 한 행으로 등록한다.

- `name` — 볼트 식별자 (라우팅/명령에서 `--vault <name>`으로 지정)
- `path` — 로컬 경로 (절대 또는 이 CLI 기준 상대)
- `kind` — `open`(일반) 또는 `secure`(보안 규칙 적용: 쓰기 전 확인·익명화)
- `signals` — 이 볼트로 라우팅할 내용 신호 (쉼표 구분)
- `notes` — 선택. Notion 대상, 특기사항

## 볼트

| name | path | kind | signals | notes |
|------|------|------|---------|-------|
| personal | ../my-wiki | open | 커리어, resume, LinkedIn, 일반 AI/ML 학습, 논문, 공개 아티클 | 커리어 자료 보유 |
| work | ../work-wiki | secure | 고객명, 사내 제품/기능, Slack/회의/내부 출처, 프로젝트 코드, 내부 URL | private 유지, 사례 익명화 |
