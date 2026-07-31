---
description: 기존 위키 지식을 활용해 질문에 답하거나 새 분석을 만든다
---

`WIKI-CLI.md § wiki-use`의 절차를 따른다.

1. `wiki-search`로 관련 페이지를 찾는다.
2. 해소된 볼트의 **Query Filing** 워크플로우 적용: 일회성이면 채팅 답변, 재사용 가치 있으면 그 볼트 `wiki/analyses/`에 파일링 + index·log 갱신.
3. 크로스볼트 종합 답변은 기본 `open` 볼트에.

워크플로우 스텝은 대상 볼트 `CLAUDE.md`가 정본. 요청: $ARGUMENTS
