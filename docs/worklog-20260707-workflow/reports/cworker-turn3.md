DONE

## Summary

Implemented the v2.1 agent-tool delta from `design-v2.md` in cworker-owned files.

## Files Changed This Turn

- `.gitignore`
- `src/agents.ts`
- `src/schemas.ts`
- `test/e2e.mjs`

`src/tools.ts` already registered `registerAgentTools(server)` from the earlier agent-tool work, so no turn-3 change was needed there. I did not modify `src/pane.ts`, `src/profiles.ts`, `src/paths.ts`, `test/unit.mjs`, or `package.json`.

## Implemented: `pmux_agent_send` v2.1

- Added `fileOutput?`, defaulting to `true`.
- Added requestId auto-generation when `fileOutput=true` and caller omits `requestId`.
- Generated request IDs are lowercase hex, 12 chars, and satisfy `ID_RE`.
- Resolves `workspaceDir` through `GET /api/cli/workspaces`, selecting the matching workspace's `directories[0]`.
- Throws `ToolError` if the workspace is missing or has no usable `directories[0]`.
- Uses `agentReportPath()` to compute and return `expectedReportFile`.
- Uses `makeFileFooter()` for `fileOutput=true`.
- Uses a local split-string pane fallback footer for `fileOutput=false`, avoiding complete BEGIN/END marker strings in the prompt text.
- Keeps readiness validation and busy/launch failure handling.
- `expectPrevTurnEnd` now accepts either a v2 DONE signal or the legacy END marker after `stripAnsi`.

## Implemented: `pmux_agent_capture` v2.1

- Uses `parseDoneSignal()` to detect the pane DONE signal.
- Uses `readReportFile()` only when `requestId` is supplied.
- Implements the v2.1 recovery ladder:
  - valid report file returns `{ status, content, source:"file", doneSignal }`
  - invalid report file returns `{ status:"working", reason:"file_invalid_or_midwrite" }`
  - req mismatch returns `{ status:"working", reason:"stale_file_req_mismatch" }`
  - DONE without a valid file returns `{ status:"inconsistent" }`
  - missing file falls back to pane BEGIN/END extraction
  - partial pane block returns `partial`
  - busy signal returns `working`
  - otherwise returns `missing`

## Implemented: `pmux_agent_status`

- Added a new tool registered inside `registerAgentTools`.
- Returns:
  - `alive`
  - `readiness`
  - `doneSignal`
  - optional `reportFile`
  - `tail`
- Uses provider-specific ready/error/busy pattern compilation.
- Uses `agentReportPath()` and `readReportFile()` when `agentId`, `turn`, and `requestId` are available.

## Schemas

- Added `fileOutput?` to `agentSendShape`.
- Added `agentStatusShape`.
- Kept `agentCaptureShape.requestId` optional.
- Kept ready/error/busy pattern overrides on wait/send/status.

## E2E Additions

Added live e2e cases for:

- fake v2.1 agent report file with status line + EOF marker + DONE signal, expecting capture `{ status:"complete", source:"file" }`
- stale request ID report file, expecting `working` with `stale_file_req_mismatch`
- missing EOF report file, expecting `working` with `file_invalid_or_midwrite`
- `pmux_agent_status` snapshot shape

## Gitignore

- Added `.pmux-agents/`.

## Verification

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run e2e`: TIMEOUT before any PASS/FAIL output, same class of live MCP initialize/runtime timeout previously observed in this workspace.

## Notes

- `src/paths.ts` was present by the time verification ran, and the build/typecheck passed against the v2.1 path contract.
- The status tool can fully populate report-file verification fields when `requestId` is provided. Without `requestId`, it returns the computed path but does not attempt file recovery, matching the requestId-gated file validation model.
