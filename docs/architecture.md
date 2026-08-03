# 아키텍처

llm-wiki는 여러 Markdown 위키를 하나의 에이전트 진입점에서 운영하기 위한 얇은 라우터입니다. 라우터는 대상 볼트를 결정하고, 실제 지식 워크플로우는 각 볼트의 규칙에 위임합니다.

## 구성 요소

### 사용자 설정

볼트 레지스트리, 커스텀 스킬, 발행 설정과 비밀 값은 설치된 패키지와 분리된 사용자 설정 디렉터리에 보관합니다. 패키지를 다시 설치하거나 업데이트해도 사용자 데이터는 유지됩니다.

### 관리형 워크스페이스

`llmwiki`를 실행하면 CLI가 에이전트용 워크스페이스를 준비합니다. 사용자 레지스트리는 `wikis.local.md`로 동기화되고 등록된 볼트는 `vaults/` 아래 심볼릭 링크로 노출됩니다. 관리 범위와 실제 경로는 생성된 `WORKSPACE.md`에서 확인할 수 있습니다.

### 볼트

각 볼트의 Markdown이 지식의 정본입니다. 볼트의 `CLAUDE.md`가 스키마와 ingest/query/lint/reflect 워크플로우를 정의하며, Codex 전용 규칙이 필요하면 `AGENTS.md`를 추가할 수 있습니다.

## 라우팅과 컨텍스트

시작 시에는 라우터 지침만 로드합니다. 사용자 요청과 레지스트리의 `signals`로 대상 볼트를 결정한 뒤 해당 볼트로 이동하여 그 볼트의 지침을 추가로 적용합니다.

| 파일 | 로드 시점 |
|---|---|
| 워크스페이스 `CLAUDE.md` 또는 `AGENTS.md` | 라우터 시작 시 |
| 볼트 `CLAUDE.md`와 선택적 `AGENTS.md` | 대상 볼트가 정해진 뒤 |
| `templates/vault/CLAUDE.md` | 런타임에 로드하지 않음. scaffold 원본으로만 사용 |

라우팅과 보안 경계의 상세한 런타임 규칙은 [`WIKI-CLI.md`](../WIKI-CLI.md)가 정본입니다.

## 표준 볼트 스키마

표준 스키마는 다음 세 계층으로 구성됩니다.

```text
raw/                           원본과 수집 메모
wiki/entities/                 개체
wiki/concepts/                 개념
wiki/sources/                  출처
wiki/analyses/                 분석
_meta/                         스키마, 로그, 원격 상태
```

표준 스키마의 정본은 `templates/vault/`입니다. 신규 볼트와 누락된 구조는 `llmwiki vault scaffold`로 생성하며 기존 파일은 덮어쓰지 않습니다. 결정론 검사는 `llmwiki vault lint`가 담당합니다.

스키마 규칙을 변경할 때는 다음을 함께 유지해야 합니다.

- `templates/vault/`의 디렉터리와 지침
- `_meta/schema.md`의 검사 계약
- `src/lint.js`의 결정론 검사

템플릿 변경은 기존 볼트 파일을 자동 갱신하지 않습니다. 특정 볼트만 다르게 운영하려면 해당 볼트의 지침을 수정합니다.

## 원본 동기화와 원격 발행

두 기능은 독립된 계층입니다.

- **Git backend** — Markdown 원본을 저장하고 여러 머신에 동기화
- **Remote provider** — 로컬 위키를 원격 view로 발행하고 inbox를 수집

발행 설정은 전역으로 관리하고 페이지 매핑과 수집 상태는 볼트에 둡니다. 자세한 내용은 [원격 발행 가이드](publishing.md)를 참고하세요.

## Provider 확장

새 원격 대상을 추가하려면 `src/providers/<name>.js`에서 provider 인터페이스를 구현하고 `src/providers/index.js`에 등록합니다.

출력 provider는 `createClient`, `createRemotePage`, `updateRemotePage`를 제공하고, 입력 provider는 `listInboxItems`, `itemId`, `fetchInboxNote`를 제공합니다. 데이터베이스 선택·생성이나 view를 지원하려면 provider의 선택적 메서드를 구현할 수 있습니다.

동기화 및 inbox 오케스트레이터, diff, 상태 저장과 보안 규칙은 provider와 분리되어 재사용됩니다.

## 개발과 검증

```bash
npm test
npm pack --dry-run
```

흐름 이미지는 `docs/flow.mmd`가 정본입니다. 변경 후 Mermaid CLI로 다시 생성합니다.

```bash
npx -p @mermaid-js/mermaid-cli mmdc \
  -i docs/flow.mmd \
  -o docs/flow.png \
  -t neutral \
  -b white \
  --scale 3
```
