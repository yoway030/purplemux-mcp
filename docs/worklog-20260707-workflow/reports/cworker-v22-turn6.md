DONE

## cworker v22-turn6 report

- Scope:
  - `src/agents.ts`
  - `src/schemas.ts`
  - `src/tools.ts`
  - `test/e2e.mjs`
- R3 `pmux_agent_turn` implemented:
  - Added `agentTurnShape` as send input + `pollTimeoutMs` (default 120000, max 300000) + `pollMs` (default 2000).
  - Registered new `pmux_agent_turn`.
  - Reuses the same send validation/transmission logic as `pmux_agent_send`.
  - Polling checks completion evidence first through the same capture ladder: valid report file or pane block evidence wins.
  - Without completion evidence, `ready + runtimeError` returns `status:"agent_error"` with `runtimeError`, `marker`, and `tail`.
  - Timeout returns `status:"timeout"`, `marker`, `expectedReportFile`, `rawCliState`, `command`, and `tail` so the caller can resume via `pmux_agent_capture`.
- R6 runtime error exposure:
  - Imported pending/parallel `detectRuntimeError` from `pane.ts`.
  - Added `runtimeError?: { match, line }` to wait_ready/status/send returns when detected in tail.
  - Detection is diagnostic only; it does not alter wait/status/send readiness state.
- R4 routing hints:
  - `pmux_agent_start` returns static `next` and `fallback` hints.
  - Agent tool descriptions now identify `pmux_agent_*` as primary orchestration and `pmux_send_input` / `pmux_capture_pane` as low-level fallbacks.
  - `pmux_create_tab` description now warns that `claude-code`/`codex-cli` panelType tabs may be empty shells before UI attaches and recommends `pmux_agent_start`.
- `test/e2e.mjs` updated:
  - `pmux_agent_turn` injected `agentId` is schema-rejected.
  - `pmux_agent_turn` against a shell tab returns `status:"send_failed"`.
  - `pollTimeoutMs`/`pollMs` are exercised.
  - Normal `pmux_agent_status` snapshot asserts `runtimeError` is absent.

## Verification

- `npm run typecheck` passed.
