DONE

## Summary

Fixed the live-test blocking issue where `pmux_agent_start` gave up after a single early capture before the new terminal shell prompt had rendered.

## Files Changed This Turn

- `src/agents.ts`
- `src/schemas.ts`
- `test/e2e.mjs`
- `docs/worklog-20260707-workflow/reports/cworker-turn5.md`

## Implementation

### `pmux_agent_start`

- Added `shellTimeoutMs?` to `AgentStartArgs`.
- Added bounded shell readiness polling:
  - default timeout: `5000ms`
  - schema max: `30000ms`
  - poll interval: `300ms`
- `capturePane` 409 during tab initialization is now treated as a retryable polling condition.
- The command is sent as soon as a shell prompt is detected.
- `not_shell_ready` is returned only after the timeout expires.
- `not_shell_ready` now includes:
  - `command`
  - `bootstrapHint`
  - `tail`
  so callers can resume manually with `pmux_send_input`.

### Tool Description

- Updated `pmux_agent_start` description to state that `pmux_agent_wait_ready`'s `launch_failed` interpretation is meaningful only after `pmux_agent_start` has successfully sent the command.

### Schema

- Added `shellTimeoutMs?` to `agentStartShape`.
- Enforced integer range `1..30000`.

### E2E

- Added a live `pmux_agent_start` case using:
  - `provider:"codex"`
  - `sandbox:"read-only"`
  - `shellTimeoutMs:10000`
- The case checks that start returns a command and does not return `not_shell_ready`.
- It then calls `pmux_agent_wait_ready` and closes the created tab.

## Verification

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run e2e`: TIMEOUT before any PASS/FAIL output, matching the prior live MCP initialize/runtime timeout observed in this workspace.

## Notes

- No changes were made to `profiles.ts`, `pane.ts`, `paths.ts`, `unit.mjs`, or `package.json`.
