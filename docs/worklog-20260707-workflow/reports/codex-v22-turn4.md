APPROVE

Blocking 없음.

확인 결과:
- C1: `src/pane.ts`의 `lastComposerLine(tail, glyph)`가 tail 30줄을 아래에서 위로 스캔하고, dirty composer를 `input_queued`로 먼저 반환한 뒤 bare composer만 ready로 인정합니다. 제가 낸 "composer text 아래 statusbar" 시나리오도 단위테스트로 고정됐습니다.
- C2: `hasPriorTurnCompletion`이 `pane.ts` 순수 함수로 이동했고, 구형 agent/turn marker와 R2 short req marker를 모두 인정합니다. `pmux_agent_send`는 `expectPrevRequestId`를 받아 `expectPrevTurnEnd` 검증에 넘기므로 short DONE/END 회귀가 닫혔습니다.
- C3: `pmux_agent_wait_ready`에 `requireBusyTransition`이 추가됐고, true일 때 native `agent_ready`와 pane fallback `agent_ready` 모두 `busySeen` 전에는 반환하지 않습니다. timeout payload도 `rawCliState`, `command`, `tail`을 유지합니다.

남은 사항은 blocking이 아니라 라운드 B 주의점입니다. `requireBusyTransition`은 post-send polling에서 호출자가 반드시 true로 써야 하므로, `pmux_agent_turn` 구현 때 기본적으로 이 경로를 사용해야 합니다.
