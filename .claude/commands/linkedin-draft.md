---
description: 위키의 커리어 자료를 근거로 LinkedIn 프로필 섹션 초안을 생성한다
---

커리어 자료가 있는 볼트를 대상으로 `linkedin-draft` 스킬을 호출한다. 대상 볼트는 라우팅으로 해소(기본은 커리어 자료를 가진 `open` 볼트).

- 상세 워크플로우: `.claude/skills/linkedin-draft/SKILL.md`
- 텍스트 생성까지만 — 브라우저 자동화 없음, 수동 붙여넣기
- 고객명/민감정보 익명화 게이트 필수

요청: $ARGUMENTS (섹션: headline / about / experience / 전체)
