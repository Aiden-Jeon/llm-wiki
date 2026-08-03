// 원격 provider 레지스트리. 새 대상(Confluence, Obsidian Publish 등)을 붙이려면
// src/providers/<name>.js를 만들어 아래 인터페이스를 구현하고 이 표에 한 줄 등록한다.
//
// provider 인터페이스:
//   name        provider 식별자(publish.json의 provider 값과 일치)
//   tokenPrefix 토큰 환경 변수 접두사 (LLMWIKI_<PREFIX>_TOKEN[_<VAULT>])
//   tokenHelp   (선택) 토큰 발급 안내 { url, lines[] }. CLI가 토큰 프롬프트 앞에 표시.
//   connectHelp (선택) 접근 가능한 대상이 없을 때 보여줄 연결 안내 문자열.
//   createClient(token) → client        지연 로딩. 미설치 SDK는 친절한 에러.
//   검증(선택 — typeof로 존재 확인):
//     validateToken(client) → { ok, account? }        토큰 실호출 검증. 실패 시 throw.
//     verifyDatabase(client, { databaseId }) → { ok, title? }  대상 DB 존재 확인. 실패 시 throw.
//   대상 선택/생성(선택 — 대화형 setup에서 씀. 없으면 CLI가 id 직접 입력으로 폴백):
//     listDatabases(client, { query }) → [{ id, title }]      기존 DB 목록(선택지).
//     listPages(client, { query }) → [{ id, title }]          새 DB 부모 페이지 후보.
//     createDatabase(client, { parentPageId, title }) → { databaseId, titleProperty }
//     inspectDatabase(client, { databaseId }) → { title, titleProperty, missing[], conflicts[], ok }
//     applySchema(client, { databaseId, missing }) → 추가한 속성 이름[]   누락 속성만 추가.
//     createViews(client, { databaseId }) → 만든 뷰 이름[]   대상 DB에 뷰 탭을 자동 생성(초기 1회).
//   출력(sync):
//     defaultSyncSubdirs                 config에 없을 때 동기화할 wiki 서브디렉터리
//     createRemotePage(client, ctx, page) → remoteId   신규 페이지 발행
//     updateRemotePage(client, ctx, remoteId, page)    기존 페이지 갱신
//   입력(inbox):
//     listInboxItems(client, ctx) → items[]            원격 인박스 항목 목록
//     itemId(item) → string                            dedup용 안정 id
//     fetchInboxNote(client, item) → { title, markdown, createdAt }
//
// ctx는 provider별 대상 정보(databaseId 등)를 담아 orchestrator가 넘긴다.

import * as notion from './notion.js';

const PROVIDERS = {
  [notion.name]: notion,
};

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`알 수 없는 원격 provider입니다: ${name} (지원: ${known})`);
  }
  return provider;
}

export function listProviders() {
  return Object.keys(PROVIDERS);
}
