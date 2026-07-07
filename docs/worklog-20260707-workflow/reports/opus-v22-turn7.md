APPROVE — v2.2 최종 승인. 추가 변경 2건 정확 이행, 블로킹 0. R0~R6 전 스코프 + 게이트 G1~G8 + 턴5·6 권고 모두 반영, 3턴 라이브 합성 PASS(전부 file 회수)로 실증.

# opus v2.2-turn7 — 최종 게이트

## ① agent_turn pre-send 유계 대기 — 확인 OK
- **retryable/terminal 분기 (agents.ts:964-971)** 정확: `busy` OR (`not_ready` ∧ readinessState=`agent_starting` ∧ readinessReason≠`input_queued`)만 재시도, 그 외(launch_failed·blocked·missing_prev_turn_end·input_queued)는 즉시 `{status:"send_failed", phase:"pre_send", sendAttempts}`. **input_queued를 비재시도로 둔 것이 옳다** — 진짜 큐된 프롬프트는 대기로 안 풀림. 종단 즉시 실패로 무의미한 폴 낭비 차단.
- **재시도 필드 배선 확인**: sendAgentPrompt의 not_ready 반환이 `readinessState`·`readinessReason` 동봉(726-727), pane-classify 경로에서 세팅(663-664). agent_starting은 항상 pane 경로 산물이라 필드 보장 → 재시도 판정 실동작. busy는 `reason==="busy"`로 판정하므로 native 경로여도 무관.
- **pre-send timeout (977-985)**: 미전송 시 `{status:"timeout", phase:"pre_send", sendAttempts, ...lastSendFailure}` — 어느 단계 timeout인지 phase로 구분. 재개/재지시 판단에 유용.

## ② post-send blocked 조기 종단 + runtimeErrorPattern 배선 — 확인 OK
- **blocked_state 조기 종단 (1044-1055)**: `readiness.state==="agent_blocked"` → 즉시 `{status:"blocked_state", rawCliState, command, marker, tail, ...}`. 내 턴6 비블로킹#1(권한게이트 턴이 full timeout까지 블록) 해소. **순서 정확**: evidence 검사(1019)가 먼저라 파일 self-report `blocked`(status=blocked)가 cliState `blocked_state`(승인대기)를 이김 — 상태명도 분리("blocked" vs "blocked_state")해 의미 혼동 없음.
- **runtimeErrorPattern 배선 완결**: 스키마 3-shape(send:278·wait_ready:237·status:320) `userPattern`(≤200자·컴파일 가드 = 타 override 동일 보안자세)로 추가, `compileRuntimeErrorPattern`(461)로 컴파일, send/wait_ready/status/turn 전 호출부에 threading(runtimeErrorInTail(tail, pattern)→detectRuntimeError, g-플래그 방어 제거 유지). AgentTurn/Send/WaitReady Args 타입 일관. 정규식 컴파일 경로라 셸 인젝션 표면 없음.
- **agent_error AND 조건 불변 (1056-1067)**: 완료증거 우선(1019 조기반환) 유지 위에 override 패턴만 주입 — 턴6 검증한 견고성(완료가 오류신호 이김·busy 중 미발화) 그대로.

## 비블로킹 (사소, 이월 불요 수준)
- agents.ts:674 launch_failed 반환이 `readinessState:"agent_busy"`를 하드코딩 — 오라벨(launch_failed인데 busy 표기). retryable 판정은 reason 기반이라 무해하나 payload 가독성상 오해 소지. 사소한 정리 대상.

## v2.2 종합 판정
- **스코프 완주**: R0(네이티브 cliState 채널)·R1(pane 폴백 강등·시그니처 queued)·R2(마커 단축·wrap·장식 내성)·R3(agent_turn 유계·재개·완료증거AND)·R4(라우팅)·R5(USAGE)·R6(runtimeError 상태불변 직교노출) 전부 착지.
- **게이트 이력 청산**: G1(셸 보간 무·override는 regex 가드)·G2·G3(codex PoC)·G4(transitionSeen)·G5(툴별 shell 매핑)·G6(agent_blocked 일관+조기종단)·G7(실캡처 fixture·signalSource)·G8(timeout payload) + 턴3 B1(prev-turn 스캐너)·턴5 권고3·턴6 권고1 모두 반영.
- **실증**: 회고의 원 통증(Codex 다회차 합성 중단·structured capture 불안정)이 **3턴 라이브 합성 PASS·전부 file 회수**로 해소됨 — 설계 목표 달성 확인.

**v2.2 APPROVE — 병합/릴리스 가능.**
