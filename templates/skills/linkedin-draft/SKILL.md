---
name: linkedin-draft
description: 위키의 커리어·resume 자료를 근거로 LinkedIn 프로필 섹션(Headline/About/Experience) 초안을 생성하는 skill. 사용자가 "링크드인 프로필", "LinkedIn 업데이트", "헤드라인 만들어", "About 섹션", "경력 섹션 초안", "linkedin draft" 같이 말할 때 사용한다. 텍스트 생성까지만 — 실제 붙여넣기는 수동.
---

# LinkedIn Draft

대상 위키 볼트에 이미 정리된 커리어·resume 자료를 근거로 LinkedIn 프로필 섹션의 paste-ready 초안을 생성한다. **텍스트 생성까지만** 담당한다 — 브라우저 자동화나 실제 LinkedIn 반영은 하지 않는다. 사용자가 결과를 직접 붙여넣는다.

대상 볼트는 라우팅으로 해소한다(`WIKI-CLI.md`). 기본은 커리어 자료를 가진 볼트다.

## 디스패처

사용자 발화에서 어느 섹션을 원하는지 판별한다. 모호하면 아래를 제시하고 질문한다. **임의로 고르지 않는다.**

- **Headline** — 한 줄 직함/포지셔닝
- **About** — 1인칭 요약 서사
- **Experience** — 회사·역할별 경력 불릿
- **전체** — 위 세 가지 모두

섹션과 함께 **타겟 프레이밍**을 확인한다(가정 금지). 예: "field leadership 지향" vs "applied engineer 지향" vs "현 role 그대로". 프레이밍에 따라 강조점이 달라진다.

## 근거 소스

대상 볼트에서 커리어 관련 페이지를 찾아 근거로 삼는다. 생성 전 볼트의 `index.md`로 위치를 확인하고 필요한 것만 읽는다.

전형적인 소스 유형 (볼트마다 파일명은 다를 수 있음):

| 용도 | 소스 유형 |
|------|-----------|
| Experience (주 소스) | 회사별 경력 정리 엔티티 (`linkedin` 태그, `[Project — Customer]` 형식, 고객 익명화된 페이지) |
| Headline / About 포지셔닝 | 커리어 방향/north-star, career-fit 분석 |
| 역량·요약 표현 | 1-page resume 분석 페이지 |

> 볼트에 따라 위치는 다르다. 예: Experience는 `wiki/entities/*-career.md`, 포지셔닝은 `wiki/analyses/career-*.md`, resume 표현은 `wiki/analyses/*resume*.md`. 실제 경로는 볼트 `index.md`로 확인한다.

## 워크플로우

1. **섹션·프레이밍 확인** (디스패처). 모호하면 질문.
2. **근거 읽기.** 대상 볼트 `index.md`로 위치를 확인하고 해당 섹션에 필요한 소스만 읽는다.
3. **초안 생성.**
   - **Headline**: 커리어 방향 포지셔닝 + 현재 role을 한 줄로.
   - **About**: north-star 서사 + resume 요약을 1인칭으로 종합.
   - **Experience**: 커리어 엔티티의 기존 paste-ready 불릿을 LinkedIn의 회사·역할별 구조에 맞게 재구성. 불릿 내용을 새로 지어내지 않는다 — 근거 페이지에 있는 사실만 사용한다.
4. **익명화 게이트** (커리어 엔티티의 기존 규칙 재사용):
   - 고객명 노출 금지. 산업 + 규모 descriptor만 사용(예: "Global gaming publisher").
   - 자격증명·내부 URL 금지.
   - 본인 public artifact(발표명, GitHub repo, 논문)는 노출 가능.
   - 출력 전 이 게이트를 한 번 검토한다.
5. **출력.** 채팅에 paste-ready 블록으로 낸다. LinkedIn은 마크다운 렌더링이 제한적이므로 굵게/헤딩 대신 줄바꿈·불릿(•) 위주의 평문으로 낸다.
6. **파일링은 opt-in.** 기본은 채팅 전용(read-only, git 변경 없음). 사용자가 보관을 원하면 대상 볼트 `CLAUDE.md`의 **Query Filing** 워크플로우로 `wiki/analyses/linkedin-<section>-draft.md`에 저장하고 frontmatter·`index.md`·`log.md`를 갱신한다.

## 주의

- 근거에 없는 성과·수치를 만들지 않는다. 부족하면 어떤 소스가 더 필요한지 사용자에게 말한다.
- 회사 프로젝트를 언급하려면 커리어 엔티티에 이미 익명화된 형태만 쓴다.
- 실제 LinkedIn 페이지 조작(로그인, 필드 입력)은 이 skill의 범위 밖이다.
