BLOCKED

## cworker v22-turn2 report

- Scope kept to requested tool-layer files plus this report:
  - `src/schemas.ts`
  - `src/agents.ts`
  - `test/e2e.mjs`
- Opus B1 fix wired:
  - Added `expectPrevRequestId?: string` to `agentSendShape` using the same requestId regex schema.
  - Added `expectPrevRequestId?: string` to `AgentSendArgs`.
  - Removed the local `hasPriorDoneSignal` / `hasPriorTurnEnd` / `hasPriorTurnCompletion` scanner from `agents.ts`.
  - `pmux_agent_send` now imports and calls the pending pane-layer `hasPriorTurnCompletion({ pane, agentId, turn, requestId })`.
  - `pmux_agent_send` validates `expectPrevRequestId` and passes it as the previous-turn `requestId`.
  - Send tool description now states that fileOutput prior-turn validation should pair `expectPrevTurnEnd` with `expectPrevRequestId`.
- Busy transition guard fix wired:
  - Added `requireBusyTransition?: boolean` to `agentWaitReadyShape`.
  - Added `requireBusyTransition?: boolean` to `AgentWaitReadyArgs`.
  - `pmux_agent_wait_ready` keeps default boot behavior (`false`).
  - When true, native `agent_ready` and pane fallback `agent_ready` only return after `busySeen`; otherwise polling continues.
  - Wait-ready description now recommends true for post-send completion waits and default false for boot readiness.
- `test/e2e.mjs` updated:
  - Added shortened DONE marker previous-turn gate case using `expectPrevTurnEnd + expectPrevRequestId`.
  - Added `requireBusyTransition: true` to an existing wait_ready launch-failure path to verify parameter acceptance without changing ready semantics.

## Verification

- `npm run typecheck` attempted.
- Current blocker: sworker-side `src/pane.ts` export is still absent:
  - `src/agents.ts`: Module `"./pane.js"` has no exported member `hasPriorTurnCompletion`.
- A follow-up check after a short wait still found no `hasPriorTurnCompletion` symbol in `src/pane.ts` / `test/unit.mjs`.
- No edits were made to `src/pane.ts`, `src/profiles.ts`, unit tests, fixtures, or `package.json`.
