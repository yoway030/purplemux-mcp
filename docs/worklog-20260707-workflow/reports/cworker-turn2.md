DONE

## Summary

Turn 2 review regressions were addressed in the cworker-owned files.

## Files Changed

- `src/agents.ts`
- `src/schemas.ts`

## Details

- Removed the hardcoded `provider: "codex"` path in `pmux_agent_send`.
- Made `provider` required in `agentSendShape`, using the existing `codex | claude` enum.
- Passed `args.provider` into `defaultReadyPattern`, `defaultErrorPattern`, and `classifyReadiness`.
- Added `busyPattern?` support to `pmux_agent_wait_ready` and `pmux_agent_send`.
- Imported and used `defaultBusyPattern(provider)` for default busy detection.
- `pmux_agent_wait_ready` now treats `agent_busy` as a non-terminal state and continues polling.
- `pmux_agent_send` now returns `{ sent:false, reason:"busy", tail }` when readiness classification reports `agent_busy`.
- Updated tool descriptions to mention busy handling and provider-specific readiness checks.
- Updated `hasPriorTurnEnd` to apply `stripAnsi(pane)` before line splitting and END marker matching, matching the marker extraction path.

## E2E Note

- `test/e2e.mjs` currently has no `pmux_agent_send` calls, so there was no callsite requiring provider insertion.

## Verification

- `npm run typecheck` passed.

## Notes

- `permissionMode` enum was rechecked against the updated `design-v1.md` §2.1 and remains consistent with the accepted claude 2.1.201 values: `plan | manual | acceptEdits | dontAsk | auto`.
