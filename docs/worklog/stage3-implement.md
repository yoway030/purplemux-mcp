# Worklog · Stage 3 — 작업 (Implementation)

**목표:** `docs/02-mcp-design.md` 스펙대로 purplemux MCP 서버 구현.
**산출물:** `src/{index,config,http,errors,schemas,tools}.ts`, `package.json`, `tsconfig.json`, `README.md`, `test/smoke.mjs`, 빌드 산출물 `dist/`.

## 방식 (구현 단계의 3에이전트 합의 매핑)
- 병렬 3구현은 파일 충돌 → **Opus = 주 구현자**, **Sonnet·Codex = 교차 적합성 리뷰어**, **오케스트레이터 = 라이브 e2e 실측**.
- 즉 "3에이전트가 서로의 작업을 평가·합의": 구현자의 산출물(코드) vs 리뷰어들의 평가(적합성·차단버그) 교차 → 합의.

## 구현 결과 (Opus)
- MCP SDK 1.29.0, `McpServer` + `StdioServerTransport`, `registerTool` + Zod raw shape.
- 16툴 전부, config per-call 무캐시, `send` trailing `\n` 1개 제거, screenshot base64→image/`savePath` raw 기록, `connection_info` 토큰 비노출, errors 400/403/404/405/409/500/503+ECONNREFUSED 매핑.
- 설계 이탈 없음. 구현 선택 1건: 툴 실패를 JSON-RPC error가 아니라 `isError:true` 결과로 반환해 모델이 `validPanelTypes`/`suggestedCommand`/`retryable`을 인라인으로 보게 함(합리적).

## 오케스트레이터 실측 검증 (결정적)
- `npm install`(0 vuln) / `npm run build` / `npm run typecheck` 전부 클린, `dist/` 생성.
- **라이브 stdio e2e** (`test/smoke.mjs`, 실행 중 purplemux 서버 대상):
  - initialize handshake OK, `tools/list` = **16툴**.
  - `pmux_list_workspaces` → 실제 워크스페이스 2개 반환, `isError:false`.
  - `pmux_connection_info` → `{baseUrl:http://localhost:16500, portSource:file, tokenSource:file, hasToken:true}`, **토큰 문자열 미노출**.

## 합의 게이트 — **3/3 APPROVE, 차단 0**
| 에이전트 | 판정 | 근거 |
|---|---|---|
| Opus(구현자) | 자체검증 통과 | install/build/typecheck/handshake |
| Sonnet | APPROVE | 16툴·config·http·errors·send·screenshot·connection_info 각 파일:라인 대조 |
| Codex | APPROVE | 동일 축 확인 (타임박스 내) |

## Stage 4로 이월된 비차단 nit
1. `http.ts` content-type `includes("json")` 대소문자 방어(lowercase 후 비교).
2. `errors.ts` 409 provider 메타 키 화이트리스트 → 실제(headless 미검증) 키 누락 가능. 미지 키 보존 방식 검토.
3. `errors.ts` 503 `retryable:false`를 `details`에도 넣어 409와 일관성.
4. `schemas.ts` `content`/`expression` 빈 문자열 검증 — **단 `send`는 "Enter만 제출" 유즈케이스가 있어 `.min(1)` 강제 시 `\n` 단독 입력이 막힘**. Stage 4에서 신중히 결정.
5. `tools.ts` `pmux_browser_eval` 설명에 409 transient attach 언급 추가(타 브라우저 툴과 일관).

## 다음: Stage 4 · 리뷰
3에이전트 독립 심층 리뷰(버그/견고성) → 지적 교차검증·합의 → 수정 반영 → 재빌드·재스모크.
