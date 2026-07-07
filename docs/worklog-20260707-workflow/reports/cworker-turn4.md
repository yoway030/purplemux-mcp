DONE

## Summary

Applied the turn 4 non-blocking diagnostic improvement in `src/agents.ts`.

## Files Changed This Turn

- `src/agents.ts`
- `docs/worklog-20260707-workflow/reports/cworker-turn4.md`

## Change

`reportFileStatus()` now preserves more report-file diagnostic information for invalid files, without changing `readReportFile()`'s return type.

Before this change, `eof_missing` returned:

- `statusLine: undefined`
- `reqMatch: undefined`
- `eofPresent: false`

That lost useful status snapshot information. In the `eof_missing` path, `readReportFile()` has already successfully parsed the status line and matched the request ID before failing the EOF gate, so `reqMatch` can be reported as true and the status line can be recovered for diagnostics.

## Implementation Details

- Added a small `readReportStatusLine(path, requestId)` helper in `src/agents.ts`.
- It reads only the first line of the already-checked report file path and parses `status=complete|blocked req=<requestId>`.
- `reportFileStatus()` is now async and receives `path` plus `requestId`.
- Invalid reason mapping now fills the maximum available fields:
  - `status_line`: `statusLine:"invalid"` when parsing fails
  - `req_mismatch`: status line is recovered when parseable, `reqMatch:false`
  - `eof_missing`: status line is recovered when parseable, `reqMatch:true`, `eofPresent:false`

## Verification

- `npm run typecheck`: PASS
- `npm run build`: PASS

## Notes

- `readReportFile()` return type was not changed.
- No `paths.ts` changes were made.
