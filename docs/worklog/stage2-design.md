# Worklog · Stage 2 — 설계 (Design)

**목표:** Stage 1 정본(`docs/01-cli-features.md`)을 MCP 서버 구현 스펙으로 확정.
**산출물:** `docs/02-mcp-design.md` (정본 설계), 패널 초안 `docs/panel/stage2/agent{1,2,3}-design.md`.

## 방식
- 3에이전트 독립 설계(Sonnet/Opus/Codex-high) → 정본 합성 → 3에이전트 합의 게이트.
- **속도 개선:** Stage 1에서 codex high 추론이 번들 재정독으로 폭주(5분+ 무출력)했던 문제를 막기 위해, 이번엔 "정본 문서만 읽고 코드베이스/번들 탐색 금지 + 타임박스(300s/240s)" 제약. 결과: 전 에이전트 40~76초로 수렴, codex 타임박스 내 정상 완료.

## 합의된 설계 (패널 만장일치)
- **런타임:** Node ≥20 + TypeScript + 공식 `@modelcontextprotocol/sdk`, `tsc`→`dist/index.js`, `node dist/index.js` 실행.
- **전송:** stdio (Claude Code·Codex 공통).
- **HTTP:** 내장 `fetch` + 얇은 타입 래퍼.
- **툴 16개:** 정본 15 + `pmux_connection_info`(진단, 토큰 비노출).
- **스크린샷:** 기본 base64→MCP image content, `savePath` 시 서버가 raw PNG 받아 직접 파일 기록.
- **api-guide:** markdown text content.
- **에러매핑:** 400/403/404/405/409/500/503 + ECONNREFUSED, 서버 `error`/`validPanelTypes`/`suggestedCommand`/`Allow` 보존, 503 hard·409-attach transient.
- **`send`:** trailing `\n` 1개 제거, 절대 추가 안 함 (서버 auto-Enter).
- **레이아웃:** `src/{index,config,http,errors,schemas,tools}.ts` + `test/`.

## 유일 이견과 결론
- **config 캐싱 전략**: Sonnet(시작 시 캐시) vs Opus(~2s TTL) vs Codex(per-call 무캐시).
- **결론: per-call 무캐시.** MCP 서버는 장수명이라 purplemux 재시작/포트변경/토큰재생성을 재시작 없이 흡수해야 함. 파일 2개 읽기는 무시할 비용. (합의 게이트에서 Sonnet·Opus 모두 자기 원안보다 per-call이 낫다고 수용.)

## 합의 게이트 결과 — **3/3 APPROVE, 차단 0**
| 에이전트 | 판정 |
|---|---|
| Opus | APPROVE (per-call 정확, TTL 불필요→삭제 권고) |
| Sonnet | APPROVE (per-call이 자기 원안보다 낫다 수용) |
| Codex | APPROVE (타임박스 내) |

반영한 비차단 nit:
1. TTL 마이크로캐시 문구 완전 삭제 (의존 여지 제거).
2. 스크린샷 `savePath`= MCP 서버 자체 `fs.writeFile` (서버 저장 파라미터 아님) 명시 + base64 방어적 파싱.
3. 409의 provider/suggestedCommand는 `tab create` agent-not-installed 계열에만 존재, 타 409는 `error`만 → 방어적 파싱.
4. 400은 비-panelType 에러도 raw `error` 노출.
5. `pmux_connection_info`는 port/token 없을 때 부분 진단 반환(에러 아님).
6. 제외 목록(`help`/`memory`/`start`) 명시.

## 다음: Stage 3 · 구현
`docs/02-mcp-design.md` 스펙대로 MCP 서버 코드 작성. 구현자 1명 + 리뷰어 2명 교차평가 합의 방식으로 진행.
