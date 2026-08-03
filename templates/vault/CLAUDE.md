# LLM Wiki Schema

이 문서는 LLM이 이 저장소를 knowledge base(볼트)로 운영할 때 따라야 할 규칙과 워크플로우의
정본이다. 볼트별로 필요한 규칙(보안 원칙, Notion 대상, 태그 어휘 등)을 이 파일에 덧붙여 조정한다.
기계로 검사하는 스키마 계약은 [`_meta/schema.md`](_meta/schema.md)에 있고, `llmwiki vault lint`가
그 규칙으로 이 볼트를 검사한다.

## 목표

- `raw/`에는 원본 자료를 보존한다.
- `wiki/`에는 LLM이 읽기 쉬운 구조화된 파생 지식을 축적한다.
- 질문 결과 중 재사용 가치가 있는 내용은 위키에 다시 편입한다.
- 모든 의미 있는 변경은 Git 히스토리와 `log.md`에 남긴다.

## 운영 원칙

1. `raw/`는 불변이다. 오탈자 수정, 정리, 요약은 `wiki/`에서만 한다.
2. 위키는 누적 자산이다. 새 소스가 오면 새 페이지만 만들지 말고 기존 페이지도 갱신한다.
3. 사실, 해석, 추정을 구분한다. 추론이 들어가면 문장 안에서 명시한다.
4. 링크를 우선한다. 새 페이지를 만들 때는 반드시 관련 기존 페이지와 연결한다.
5. 한 번의 작업은 하나의 목적을 갖는다. ingest, query filing, lint, schema update를 섞지 않는다.

## 행동 가이드라인

속도보다 정확성을 우선한다. 사소한 작업에는 판단에 따라 유연하게 적용한다.

### 1. 먼저 생각하기

가정하지 않는다. 혼란을 숨기지 않는다. 트레이드오프를 드러낸다.

- 작업 전 가정을 명시한다. 불확실하면 질문한다.
- 해석이 여러 가지 가능하면 제시하고 선택을 구한다. 임의로 고르지 않는다.
- 더 단순한 방법이 있으면 말한다. 필요하면 반론을 제기한다.
- 불명확한 점이 있으면 멈추고, 무엇이 불명확한지 명시하고, 질문한다.

### 2. 단순성 우선

문제를 해결하는 최소한의 내용만 작성한다. 추측성 확장은 하지 않는다.

- 요청된 범위 밖의 페이지를 만들지 않는다.
- 한 번만 쓰일 내용에 과도한 구조를 부여하지 않는다.
- 요청되지 않은 "유연성"이나 "확장성"을 위한 구조를 만들지 않는다.

기준: "시니어 엔지니어가 보고 과도하다고 할 것인가?" 그렇다면 단순화한다.

### 3. 최소 변경

건드려야 할 것만 건드린다. 정리는 자기가 만든 혼란에 대해서만 한다.

- 기존 페이지를 수정할 때 인접한 문단, 서식, 표현을 "개선"하지 않는다.
- 기존 스타일에 맞춘다. 본인이 다르게 하고 싶어도.
- 관련 없는 문제를 발견하면 언급만 하고 수정하지 않는다.
- 본인의 변경으로 발생한 고아 링크나 미사용 항목은 정리한다.

기준: 변경된 모든 줄이 사용자의 요청으로 직접 추적 가능해야 한다.

### 4. 목표 중심 실행

성공 기준을 정의하고, 검증될 때까지 반복한다. 작업을 검증 가능한 목표로 변환한다:
- "페이지 추가" → "source 페이지 작성 → entity/concept 갱신 → index 반영 → log 기록"

명확한 성공 기준이 있으면 자율적으로 진행한다. 모호하면 먼저 명확화한다.

## 디렉토리 구조

```text
raw/                 # 원본 소스, 읽기 전용
  articles/          # 웹 아티클, 블로그, 문서
  papers/            # 논문, PDF
  notes/             # 수기 노트, 회의 메모, 가져온 메모
  assets/            # 이미지, 첨부파일
wiki/                # LLM이 생성/관리하는 파생 지식
  entities/          # 사람, 조직, 제품, 프로젝트, 도구
  concepts/          # 개념, 기술, 방법론, 패턴
  sources/           # raw 소스별 요약 및 핵심 포인트
  analyses/          # 비교, 질의 결과, 합성 노트, 의사결정 메모
_meta/               # 위키 운영 메타데이터
  taxonomy.md        # 태그 통제 어휘
  schema.md          # 기계 검사 스키마 계약 (llmwiki vault lint 기준)
index.md             # 위키 전체 인덱스
log.md               # 작업 로그
AGENTS.md            # Codex 운영 스키마
CLAUDE.md            # Claude 운영 스키마
```

## 페이지 타입과 파일명

- 파일명은 영어 slug(kebab-case)를 사용한다. 예: `retrieval-augmented-generation.md`
- 페이지 제목은 사람이 읽기 쉬운 언어를 사용한다.
- 타입은 `entity`, `concept`, `source`, `analysis` 중 하나만 사용하며, 파일이 놓인 디렉터리와
  일치시킨다(`wiki/entities/`의 페이지는 `type: entity`).
- 같은 주제의 페이지를 중복 생성하지 않는다. 기존 페이지를 확장하거나 통합한다.

## Frontmatter

모든 `wiki/` 페이지는 아래 frontmatter를 포함한다.

```yaml
---
title: 사람에게 보이는 제목
type: entity | concept | source | analysis
status: active | draft | archived
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - tag1
  - tag2
sources:
  - raw/articles/example.md
---
```

Obsidian properties UI와 호환되도록 `tags`, `aliases`, `sources` 등 리스트 필드는 인라인(`[a, b]`)
대신 멀티라인 형태로 작성한다.

추가 필드가 필요한 경우에만 아래를 사용한다.

- `aliases`: 다른 표기 (리스트)
- `summary`: 한 줄 요약
- `source_url`: 원문 URL
- `confidence`: low | medium | high

모든 `tags`는 사용 전 `_meta/taxonomy.md`에 등록한다(태그 drift 방지).

## 작성 규칙

- 링크는 Obsidian wikilink를 사용한다. 예: `[[transformer]]` 또는 `[[transformer|Transformer]]`
- raw 소스 참조는 상대 경로 링크를 사용한다.
- source 페이지는 "무엇을 말했는지"를 요약한다.
- entity/concept 페이지는 여러 source를 통합한 현재 이해를 담는다.
- analysis 페이지는 질문, 비교, 판단, 열린 이슈를 담는다.
- 문단은 짧게 유지하고, 긴 페이지는 `핵심 요약`, `세부 내용`, `열린 질문` 정도로 구분한다.

### 페이지 구조 가이드

엄격한 규칙이 아닌 권장 구조. 내용에 맞게 조정한다.

- **entity**: 개요 → 주요 사실 → 관련 개념 → 출처
- **concept**: 정의 → 작동 방식 → 유형/변형 → 관련 개념 → 열린 질문
- **source**: 메타데이터(저자, 일자) → 핵심 요약 → 주요 주장 → 기존 위키와의 연결
- **analysis**: 질문 → 방법 → 발견 → 시사점 → 관련 페이지

## 인용과 추론

- 소스에 직접 근거가 있는 내용은 해당 source 페이지 또는 raw 파일로 연결한다.
- 여러 소스를 종합한 판단은 "종합하면", "추론하면" 같은 표현으로 표시한다.
- 모순이 있으면 삭제하지 말고 차이를 적는다.

## 작업 유형

### Ingest

1. 새 소스를 `raw/`에 저장한다.
2. `wiki/sources/`에 소스 요약 페이지를 만든다.
3. 관련 `entity` 또는 `concept` 페이지를 생성 또는 갱신한다.
4. 필요하면 `wiki/analyses/`에 비교/정리 문서를 만든다.
5. `index.md`를 동기화한다.
6. `log.md` 맨 위에 작업 엔트리를 추가한다.

### Query Filing

1. 질문에 답하기 전 `index.md`와 관련 페이지를 먼저 읽는다.
2. 일회성 답변이면 채팅으로만 답한다.
3. 재사용 가치가 있으면 `wiki/analyses/`에 저장한다.
4. 저장했다면 `index.md`와 `log.md`도 함께 갱신한다.

### Lint

먼저 `llmwiki vault lint`로 결정론 검사(구조·frontmatter·파일명·태그·index/log 형식·깨진 링크)를
돌린다. 그다음 도구로 못 잡는 내용 품질을 사람 판단으로 점검한다.

- 고아 페이지 (index·다른 페이지에서 도달 불가)
- 중복 페이지 (같은 주제 분산)
- 오래된 요약 (source는 늘었는데 요약 미갱신)
- source는 늘었는데 entity/concept가 반영되지 않은 경우
- 열린 질문이 오래 방치된 경우
- 위키 페이지명과 일치하는 텍스트가 wikilink 되지 않은 곳 (cross-linker)
- 종합 판단인데 synthesis로 표시되지 않은 문장

문제는 심각도별로 정리해 권고하고, 사용자 확인을 받은 뒤 수정한다. 결정론 검사로 잡히는 구조
누락은 `llmwiki vault scaffold`로 가산적으로 보완한다(기존 파일은 덮어쓰지 않는다).

### Reflect

위키가 일정 규모에 도달하면 주기적으로 합성 성찰을 수행한다.

1. `index.md`와 `log.md`를 읽고 현재 위키 상태를 파악한다.
2. 3개 이상 페이지에 걸치지만 전용 페이지가 없는 교차 주제를 식별한다.
3. 태그 그래프에서 암묵적 클러스터를 탐색한다.
4. `wiki/analyses/`에 새 합성 페이지를 제안하거나 생성한다.
5. draft 페이지 중 active로 승격할 수 있는 것을 제안한다.
6. `index.md`와 `log.md`를 갱신한다 (action: `reflect`).

## index.md 규칙

- 카테고리별(Entities/Concepts/Sources/Analyses)로 정리한다.
- 항목 형식은 `- [[페이지-slug]] — 한 줄 요약`을 사용한다.
- 새 페이지 생성, 삭제, 제목 변경 시 즉시 반영한다.

## log.md 규칙

- 최신 엔트리가 맨 위에 온다.
- 형식은 `## [YYYY-MM-DD] action | 제목`을 사용한다.
- action은 `init`, `ingest`, `query`, `lint`, `reflect`, `update`, `schema`, `publish` 중 하나를 쓴다.
- 각 엔트리에는 수정된 주요 파일과 작업 의도를 짧게 남긴다.

## Git 운영 규칙

- 한 커밋은 한 작업 단위로 묶는다.
- schema 변경은 지식 페이지 변경과 분리해서 커밋한다.
- 커밋 전에 `index.md`, `log.md`, 관련 위키 페이지가 함께 갱신됐는지 확인한다.
- 커밋 메시지 접두사: `ingest:`, `query:`, `lint:`, `reflect:`, `schema:`, `publish:`, `init:`, `update:`
