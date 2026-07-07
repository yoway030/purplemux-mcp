DONE

## cworker v22-turn8 report

- Scope:
  - `src/agents.ts`
  - `src/schemas.ts`
- Blocking fix 1: `agent_turn` post-send blocked state
  - `classifyTurnReadiness` now returns the observed readiness `state` in addition to ready/raw cli fields.
  - `pmux_agent_turn` now checks completion evidence first, then treats observed `agent_blocked` as terminal:
    - returns `status:"blocked_state"`
    - includes `rawCliState`, `command`, `marker`, `tail`, `attempts`, `sendAttempts`, and `elapsedMs`
  - Valid file/pane completion evidence still wins over blocked/runtime-error state.
- Blocking fix 2: runtime error override wiring
  - Added `runtimeErrorPattern?` to wait_ready/send/turn/status schemas using the existing userPattern guard (max 200 chars).
  - Added `runtimeErrorPattern?` to tool arg types.
  - Runtime error detection now compiles this override through `compileUserPattern`.
  - `wait_ready`, `send`, `turn`, and `status` pass the override into `detectRuntimeError`.

## Verification

- `npm run typecheck` passed.
