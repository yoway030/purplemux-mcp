DONE

## cworker v22-turn3 report

- Scope kept to requested tool-layer file plus this report:
  - `src/agents.ts`
- Live boot failure fix:
  - `pmux_agent_wait_ready` now treats pane fallback `agent_starting` with `reason:"input_queued"` as `agent_ready` only when `requireBusyTransition` is false.
  - The promoted return includes `reason:"composer_placeholder_assumed"` so callers can see the boot-mode assumption.
  - `requireBusyTransition:true` remains strict: pane fallback ready still requires prior busy observation, and `input_queued` is not promoted.
  - `classifyReadiness` in `src/pane.ts` was not changed, so `pmux_agent_send` readiness validation keeps the strict queued/composer-dirty behavior.
- Tool description updated:
  - `pmux_agent_wait_ready` now documents that this placeholder promotion is boot-mode only and send validation remains strict.

## Verification

- `npm run typecheck` passed.
