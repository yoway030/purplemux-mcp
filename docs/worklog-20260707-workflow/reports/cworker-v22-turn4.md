DONE

## cworker v22-turn4 report

- Scope kept to requested tool-layer file plus this report:
  - `src/agents.ts`
- Live first-send placeholder fix:
  - `pmux_agent_send` now treats pane fallback `agent_starting` with `reason:"input_queued"` as sendable only for `args.turn <= 1`.
  - Successful sends through this path include `validation.warning:"composer_placeholder_assumed"`.
  - `turn > 1` remains strict and returns the existing `sent:false, reason:"not_ready"` path.
  - Other not-ready classifications remain unchanged.
- Tool description updated:
  - `pmux_agent_send` now documents the `turn <= 1` composer-placeholder rule and strict later-turn behavior.

## Verification

- `npm run typecheck` passed.
