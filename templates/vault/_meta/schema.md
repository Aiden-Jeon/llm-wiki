# Schema Contract

`llmwiki vault lint`가 이 볼트를 검사할 때 쓰는 기계 검사 계약이다. 사람이 읽는 워크플로우 정본은
[`../CLAUDE.md`](../CLAUDE.md)에 있고, 이 문서는 그중 **결정론적으로 검사 가능한 규칙만** 추린다.
린터 규칙과 이 문서는 같은 내용을 담는다(드리프트 방지). 규칙을 바꾸면 둘 다 함께 고친다.

심각도: **error** = 명확한 위반(스키마 위배). **warn** = 휴리스틱·품질 신호(거짓양성 가능).

## 구조 (error)

아래 경로가 반드시 존재한다. 누락은 `llmwiki vault scaffold`로 보완한다.

- `raw/`
- `wiki/entities/`, `wiki/concepts/`, `wiki/sources/`, `wiki/analyses/`
- `_meta/taxonomy.md`
- `index.md`, `log.md`, `CLAUDE.md`

## Frontmatter (error)

`wiki/**/*.md` 각 페이지는 YAML frontmatter를 가지며 다음 필수 필드를 모두 포함한다.

- `title`, `type`, `status`, `created`, `updated`, `tags`, `sources`

값 제약:

- `type` ∈ `entity | concept | source | analysis`
- `status` ∈ `active | draft | archived`
- `type`은 페이지가 놓인 디렉터리와 일치한다 (`wiki/entities/` → `entity` 등)
- `created` / `updated` 는 `YYYY-MM-DD` 형식

## 파일명 (error)

- `wiki/**/*.md` 파일명(확장자 제외)은 kebab-case slug: `^[a-z0-9][a-z0-9-]*$`

## 태그 통제 (warn)

- 모든 페이지의 `tags` 값은 `_meta/taxonomy.md`에 등록된 어휘여야 한다. 미등록 태그는 태그 drift.

## index.md 커버리지 (warn)

- 모든 `wiki/**/*.md` 페이지는 `index.md`에 `[[slug]]`로 등재된다. 미등재는 고아 후보.

## log.md 형식 (warn)

- 엔트리 헤더는 `## [YYYY-MM-DD] action | 제목` 형식.
- `action` ∈ `init | ingest | query | lint | reflect | update | schema | publish`

## 깨진 wikilink (warn)

- `wiki/**` 본문의 `[[target]]` 및 `[[target|표시]]`는 알려진 페이지 slug 또는 `raw/` 파일명으로
  해소되어야 한다. 경로형 링크(`[[../raw/...]]`)는 검사에서 제외한다(거짓양성 방지).
