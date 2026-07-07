REJECT

src/pane.ts:280-292 — dirty composer 감지가 마지막 비공백 줄에만 적용되고, 그 뒤 `readyPattern.test(tail)`가 tail 안의 아무 `›`나 ready로 승격합니다. — Codex 화면은 `› Explain this codebase` 같은 composer 입력줄 아래에 statusbar가 올 수 있습니다. 이 경우 `lastLine`은 statusbar라 `input_queued`가 안 잡히고, tail의 `›` 때문에 `agent_ready`가 되어 pmux_agent_send가 추가 입력을 보내며 회고 #5 큐잉이 재발합니다.

src/agents.ts:399-413 — `expectPrevTurnEnd` 검증이 R2 short marker를 인식하지 못합니다. — 이전 턴이 새 형식 `<<<PMUX_DONE req=<rid> status=complete>>>` 또는 `<<<PMUX_END req=<rid>>>`로 끝난 뒤 다음 send에서 `expectPrevTurnEnd`를 지정하면, pane에는 정상 완료 신호가 있어도 legacy agent/turn 정규식만 보므로 `missing_prev_turn_end`로 막힙니다.

src/agents.ts:652-678 — `busySeen` guard가 native `agent_ready` 분기에만 적용되고 pane fallback ready에는 적용되지 않습니다. — send 직후 첫 poll에서 hook 갱신 전 `cliState`가 아직 ready/idle이고 pane도 이전 ready frame을 유지하면, busy를 한 번도 보지 않았는데 `classifyReadiness`의 pane ready가 즉시 반환되어 다음 턴을 너무 일찍 보내는 G4 stale-ready 레이스가 남습니다.
