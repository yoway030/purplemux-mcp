verdict: APPROVE — 라운드B(R3~R6) 병합 가능(블로킹 0). agent_turn 유계·재개·완료증거AND·R6 상태불변 전부 정확 이행. 비블로킹 3건(경미).

# opus v2.2-turn6 — 라운드B 구현 리뷰

## R3 `pmux_agent_turn` (22번째 툴) — APPROVE
- **완료증거 AND 조건 (agents.ts:941-985)** ✅ 정확: 폴 루프가 매 회 ①`captureAgentEvidence`로 완료증거를 **먼저** 검사(951) — complete/blocked면 즉시 반환. ②그 다음에만 readiness+runtimeError 검사. 따라서 `agent_error`는 "완료증거 없음(control-flow 보장) ∧ readiness.ready ∧ runtimeError"일 때만 발화 → design line115·내 턴5 권고와 정합. `captureAgentEvidence`(791)가 capture 사다리(유효파일 EOF+req 게이트 → invalid→working → doneSignal-only→inconsistent → pane블록 → busy→working → missing)를 그대로 미러하므로 완료 판정이 권위 있음.
- **AND 조건 견고성(3개 실패모드 검증)**:
  - 529 후 ready 복귀·파일 없음 → evidence:missing→ready:true→runtimeError → `agent_error` ✓ (설계 의도 정확 재현).
  - 성공 완료 + 본문이 "rate limit" 인용 → 유효파일→`complete` **먼저** 반환(951), agent_error 도달 안 함 ✓ (완료가 오류신호 이김).
  - busy 중 "connection error" 순간 점멸 → readiness.ready=false → agent_error 미발화, 계속 폴링 ✓ (settled 상태에서만 오류판정).
- **유계·재개 계약 (992-1001)** ✅: timeout 시 `{status:"timeout", marker, expectedReportFile, attempts, elapsedMs, rawCliState, command, tail}` — 동일 marker로 `pmux_agent_capture` 재개(무상태 자연성립) + G8(rawCliState·command·tail) 동봉. send 실패는 `{status:"send_failed", ...sent}`(marker 없음 — 미전송이라 재개 불요)로 올바르게 구분.
- **스키마 경계 (schemas.ts:279-294)** ✅: pollTimeoutMs 기본120000·max300000, pollMs 기본2000·min500 — 설계와 일치. agentSendShape 상속으로 expectPrevRequestId 등 승계.

## R6 detectRuntimeError — APPROVE (턴5 권고 3건 전부 반영)
- **tail 전용 계약 (pane.ts:656)** ✅: `tail` 인자만 받고 "full scrollback 금지" 주석 — errorPattern이 겪던 영구 오탐(과거 본문 인용이 found 고정)을 tail-스코프로 차단(권고 a).
- **분류 비피드백 (634-641 주석)** ✅: classifyReadiness/launch_failed에 **절대 미피드백** 명시 — ready 세션은 529여도 실제 ready(재지시 가능). 상태모델 불변 원칙 준수(내 턴5 핵심 지적). `withRuntimeError`(382)로 readiness state와 **병렬** 노출, wait_ready/status/send/turn 전 경로 배선 확인(573~1441).
- **오탐 명시 (647-654)** ✅: 본문이 "API Error"/이 설계문서의 "API Error: 529"를 인용하면 false found — errorPattern 동급 알려진 한계로 문서화, `{match,line}` 반환해 LLM 문맥판단 위임(권고 a·c). 보너스: `g` 플래그 방어적 제거(662-666)로 lastIndex 상태오염 차단 — 무상태 계약 견고.

## R4 라우팅 — APPROVE
- start `next`/`fallback` 정적 필드(1043·1060), start/turn/status description "Primary agent orchestration tool" + 저수준 폴백 명시. create_tab(tools.ts:97) "claude-code/codex-cli panelType은 UI 부착 전 빈 셸일 수 있음 — 오케스트레이션은 pmux_agent_start 권장" ✓ (회고 #3 대응). send_input/capture_pane도 "low-level fallback…prefer pmux_agent_*" ✓. 부수확: send_input이 **AUTO-SUBMIT(bracketed paste+Enter)** 명시 — 내 턴5 비블로킹#1(멀티라인 queued false-ready)이 우리 send 경로에선 미제출 잔존 자체가 불가함을 확증(리스크 추가 소멸).

## R5 USAGE.md cookbook — APPROVE
- §6에 권장 워크플로·훅/비훅 `signalSource`·fileOutput 라우팅(`recommendedFileOutput`)·폴백·runtimeError 재지시 패턴(R6) 전부 수록(설계 line107 충족).

## 비블로킹 (경미, 후속 선택)
1. **agent_turn이 agent_blocked에 조기반환 안 함**: 턴 중 권한/리뷰 게이트(cliState notification/ready-for-review) 발생 시 `isReadyStateForTurn`=false라 full pollTimeout(기본120s)까지 폴링 후 timeout 반환. 부정확은 아니며(timeout payload에 rawCliState=notification 노출→복구 가능) 설계 R3 status enum도 blocked 조기반환 미강제. 단 오케스트레이터가 120s 블록됨 → 응답성 위해 blocked 조기반환(status:"blocked" 또는 신규) 추가 검토. 적정 start 설정(sandbox/permissionMode)으로 프롬프트 회피되면 희소.
2. **폴당 중복 캡처**: runAgentTurn이 evidence용(captureAgentEvidence 내부 794)과 readiness용(962) pane 캡처를 각각 수행 + tabStatus 2회(943 경로/classifyTurnReadiness). 정확하나 evidence의 pane/tail 재사용으로 폴당 HTTP 절감 가능. 경미.
3. **USAGE §1 "16개 툴" 표기**: 현행 22툴(agent_* 6종은 §6 cookbook에 별도 기술)과 어긋나는 스테일 카운트 가능성 — 문서 정합 위해 "16 base + agent_* 6" 정도로 명확화 권고. 사소.

## 결론
R3~R6이 설계와 내 턴5 권고에 충실히 구현됐고, agent_turn의 완료증거-우선 AND 조건과 R6의 상태-불변 직교노출이 정확하다. 블로킹 없음 — **라운드B 병합 가능.** 비블로킹 3건은 후속 폴리시. 라이브 다회차 도그푸드(회고 Codex 3턴 합성 재현)로 agent_turn·runtimeError 실증을 최종 확인 권고.
