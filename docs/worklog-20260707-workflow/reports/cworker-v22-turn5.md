DONE

## cworker v22-turn5 report

- Scope kept to requested tool-layer file plus this report:
  - `src/agents.ts`
- Live post-send wait fix:
  - `pmux_agent_wait_ready` now uses `transitionSeen` instead of a busy-only `busySeen` gate.
  - `transitionSeen` becomes true when:
    - native/pane busy is observed, or
    - the first recorded baseline state was non-ready and a later native/pane state becomes `agent_ready`.
  - If the baseline is ready from the first poll, `requireBusyTransition:true` keeps waiting and can still timeout, preserving the stale-ready G4 guard.
  - Timeout responses now include `baseline` and `transitionSeen` for diagnosis.
- Tool description updated:
  - `requireBusyTransition` now documents "busy observed or initial non-ready baseline later changes to ready".

## Verification

- `npm run typecheck` passed.
