DONE

## Summary

Applied the turn 6 live-test fix for the default `fileOutput:true` × read-only/plan-agent deadlock.

## Files Changed This Turn

- `src/agents.ts`
- `docs/worklog-20260707-workflow/reports/cworker-turn6.md`

## Implementation

- Added `recommendedFileOutput(args)` in `src/agents.ts`.
- `pmux_agent_start` now returns `recommendedFileOutput` on success.
- `pmux_agent_start` also returns `recommendedFileOutput` in `not_shell_ready`.
- Decision rules:
  - codex: `recommendedFileOutput = sandbox !== "read-only"`; omitted sandbox defaults to `read-only`, so default codex returns `false`.
  - claude: `recommendedFileOutput = permissionMode !== "plan"`; omitted permissionMode defaults to `plan`, so default claude returns `false`.
- Kept existing `command` in `not_shell_ready`.
- Updated `pmux_agent_start` description to document the returned hint.
- Updated `pmux_agent_send` description to state that callers should use `fileOutput:false` when start returned `recommendedFileOutput:false`, because read-only/plan agents cannot write report files.

## Verification

- `npm run typecheck`: PASS
- `npm run build`: PASS

## Notes

- No schema change was needed because this is an output-field addition only.
