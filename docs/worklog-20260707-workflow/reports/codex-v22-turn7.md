APPROVE

## Final Gate Review

턴6 blocking 2건은 병합 가능한 수준으로 해소됐습니다.

1. `agent_turn` post-send blocked 조기 종단
   - `src/agents.ts:1011-1029`에서 완료 증거(file/pane complete 또는 blocked)를 먼저 확인하고 반환합니다.
   - 그 다음 `src/agents.ts:1033-1055`에서 readiness를 재분류한 뒤 `agent_blocked`를 `{status:"blocked_state", rawCliState, command, marker, tail, attempts, sendAttempts, elapsedMs}`로 조기 반환합니다.
   - 따라서 완료 증거 우선순위는 유지되고, 턴6의 문제였던 "blocked 상태가 timeout까지 흘러감"은 닫혔습니다.

2. `runtimeErrorPattern` override와 가드
   - `src/schemas.ts:237`, `src/schemas.ts:278`, `src/schemas.ts:320`에 `runtimeErrorPattern: userPattern("runtimeErrorPattern")`가 배선됐고, `agentTurnShape`는 `agentSendShape`를 상속하므로 turn에도 적용됩니다.
   - `src/agents.ts:461-464`의 `compileRuntimeErrorPattern()`이 `compileUserPattern(src, "runtimeErrorPattern")`를 경유하므로 200자 제한과 regex compile error 래핑이 기존 override들과 동일하게 적용됩니다.
   - `wait_ready/send/turn/status` 모두 해당 pattern을 `runtimeErrorInTail()`에 전달합니다.

3. pre-send 유계 대기 보정
   - `src/agents.ts:956-985`에서 `pollTimeoutMs` 단일 예산 안에서 pre-send retry를 수행하고, retry 대상은 `busy` 또는 `not_ready + agent_starting + reason != input_queued`로 제한됩니다.
   - blocked/launch_failed/진짜 queued input은 즉시 `send_failed`로 종단되므로 큐잉 방어를 무너뜨리지 않습니다.

## Residual Risk

- `blocked_state`는 새 status 값이라 호출자가 R3 초기 enum만 하드코딩했다면 갱신이 필요합니다. 다만 이번 턴의 명시 요청이 "blocked_state 계열"이었고, timeout보다 훨씬 나은 종단 신호이므로 비차단입니다.
- runtime error 탐지는 tail 기반 best-effort입니다. 설계 R6의 "상태 불변·별도 사실" 원칙에는 부합합니다.

## Verification

- `npm run typecheck` 통과.
- `node test/unit.mjs` 통과.
- `npm run build` 통과.
- `node test/e2e.mjs`는 이 로컬 세션에서 45초 `TIMEOUT`으로 종료되어 직접 재현은 못 했습니다. 구현 diff와 사용자가 제공한 통합 결과(typecheck·unit·e2e 33/33·smoke 22툴)를 함께 근거로 최종 승인합니다.
