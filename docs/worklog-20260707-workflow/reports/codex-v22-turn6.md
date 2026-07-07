REJECT

## Blocking Findings

1. `src/agents.ts:868` / `src/agents.ts:962` - `pmux_agent_turn`이 post-send blocked 상태를 종단 상태로 표면하지 못합니다.
   - `classifyTurnReadiness()`는 native `agent_blocked`를 `ready:false`로만 접고, polling loop는 `ready && runtimeError`만 조기 반환합니다. 따라서 prompt 전송 뒤 Codex/Claude가 권한 요청, ready-for-review, needs-input 같은 blocked 상태로 멈추면 완료 증거가 없는 한 `timeout`까지 대기합니다.
   - 시나리오: `pmux_agent_turn` 전송 후 Codex가 승인 필요 상태(`cliState=notification` 계열)로 전환되고 보고 파일/마커를 쓰지 않음. 기대 동작은 blocked 계열 종단 반환이지만 실제 동작은 `pollTimeoutMs` 경과 후 `{status:"timeout", rawCliState, command, tail}`입니다.
   - R6 구현 자체의 runtimeError 우선순위는 "완료증거 우선 -> ready+runtimeError agent_error"로 맞지만, blocked는 readiness 사다리에서 별도 사실로 보존되어야 합니다. `wait_ready/status/send`에서 표면하는 blocked와 `turn`의 반환 의미가 불일치합니다.

2. `src/schemas.ts:217` / `src/agents.ts:372` - R6 runtime error override가 공개 툴 입력과 가드로 연결되지 않았습니다.
   - `detectRuntimeError(tail, pattern?)` 순수 함수는 override를 받을 수 있지만, `wait_ready`, `send`, `agent_turn`, `status` 스키마에는 `runtimeErrorPattern`류 입력이 없습니다. `runtimeErrorInTail()`도 항상 기본 패턴만 사용합니다.
   - 설계 R6의 "override 가능, <=200" 조건과 이번 리뷰 포인트인 "패턴 길이·컴파일 가드"가 MCP surface에서 충족되지 않습니다. 기존 `compileOptionalPattern()` 경로도 runtimeError에는 적용되지 않습니다.
   - 시나리오: 특정 provider/CLI가 `Server unavailable` 같은 기본 패턴 밖의 조용한 실패를 출력함. 호출자는 override로 조기 `agent_error`를 유도할 수 없어 `agent_turn`이 정상 ready 또는 timeout으로 오판할 수 있습니다.

## Non-Blocking Notes

- `captureAgentEvidence()`가 runtime error 검사보다 먼저 실행되어 완료 파일/마커가 우선되는 구조는 턴5 권고와 R6 설계에 부합합니다.
- timeout payload는 `marker`, `expectedReportFile`, `rawCliState`, `command`, `tail`을 포함해 재개/진단에 필요한 핵심 필드를 제공합니다.
- `detectRuntimeError()`는 ANSI 제거, global flag 제거, line 추출이 되어 있어 순수 함수 자체는 적절합니다. 문제는 공개 override/guard wiring입니다.

## Verification

- `npm run build` 통과.
- `node test/unit.mjs` 통과.
- `npm test`는 package script가 없어 실행되지 않았습니다.
