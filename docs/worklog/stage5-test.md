# Worklog · Stage 5 — 테스트 & 등록 (Test & Register)

**목표:** 라이브 e2e 검증 + Claude Code / Codex 등록 + 최종 합의.

## 테스트 (`test/e2e.mjs`, 실행 중 purplemux 서버 대상)
MCP 서버(`dist/index.js`)를 stdio로 띄우고 실제 툴을 호출하는 라이브 e2e. 스크래치 탭 생성 후 정리.
**결과: 12 passed, 0 failed.**
- list_workspaces / connection_info(토큰 비노출) / api_guide(markdown)
- 에러경로: invalid panelType → Zod 스키마 거부(-32602), bogus tabId → 404 매핑
- 라운드트립: create(terminal) → **send(개행 없이) → capture에서 mark 2회 = 서버 자동 제출 확인** → status(alive) → get → list(포함) → **close {ok:true} 실바디**
- 별도 보안 회귀: 악성 `PMUX_PORT` → 오프호스트 요청 전 차단(Stage 4).

브라우저 툴(url/screenshot/console/network/network_body/eval)은 Electron 필요 — 이 호스트 purplemux는 headless라 503/미검증이 정상(설계 §2). 라이브 미검증은 수용됨.

## 등록 (실동작 확인)
- **Claude Code:** `claude mcp add purplemux -s user -- node …/dist/index.js` → `claude mcp get purplemux` = **Status: ✔ Connected** (User scope, 전 프로젝트). 헬스체크가 서버를 실제 기동해 handshake 성공.
- **Codex:** `codex mcp add purplemux -- node …/dist/index.js` → `~/.codex/config.toml`에 `[mcp_servers.purplemux]`(command=node, dist/index.js) 기록, `codex mcp list` = enabled.

## 최종 합의 게이트 — **3/3 APPROVE, 차단 0**
| 에이전트 | 검증 방식 | 판정 |
|---|---|---|
| Sonnet | e2e 독립 재실행(12/12) + 등록 상태 확인 | APPROVE |
| Opus | 등록/config.toml/README/worklogs + 커버리지 대조 | APPROVE |
| Codex | e2e 커버리지 완결성 정적 검토 | APPROVE |

## 남은 nice-to-have (비차단, 향후)
- Electron 환경에서 브라우저 툴 6종 라이브 패스(특히 screenshot image vs savePath).
- 설계 §6 체크리스트 자동화 확대(config 우선순위/per-call 재읽기/전 HTTP 상태 매핑 단위테스트).

## 결론
**purplemux MCP 서버(16툴) 완성 — Claude Code·Codex 양쪽에서 연결·사용 가능.** 5단계(추출/설계/작업/리뷰/테스트) 모두 3에이전트 합의로 통과.
