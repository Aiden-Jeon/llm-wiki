---
description: 등록된 모든 위키 볼트를 가로질러 지식을 검색한다
---

`wikis.local.md`의 볼트 목록을 읽고 `WIKI-CLI.md § wiki-search`의 절차를 따른다.

1. 각 볼트의 `index.md`를 1차 검색면으로 읽는다.
2. 부족하면 각 볼트 `wiki/**/*.md`의 frontmatter·헤딩을 read-only `grep`/`find`.
3. 결과 병합, 볼트 `name` 라벨, 중복 제거.
4. `kind: secure` 볼트 히트는 제목/요약만 — raw 민감 정보 인라인 노출 금지.

읽기 전용. 신규 툴링 없음. 쿼리: $ARGUMENTS
