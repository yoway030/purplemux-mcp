DONE

## sworker v22-turn3 report

Scope kept to pure-layer files only: `src/pane.ts`, `src/profiles.ts` (untouched this turn, no changes needed), `test/unit.mjs`, plus this report. Did not touch `src/agents.ts`/`src/schemas.ts`/`test/e2e.mjs` (cworker's parallel territory — confirmed via `git status`, left untouched).

(Note: the run was interrupted by a 529 mid-turn after the implementation and tests were already in place; resumed and completed verification + this report without redoing the fix.)

### Fix: decoration-prefix tolerance on marker lines

Live capture showed codex's TUI prefixing each printed agent-output line with a decorative bullet, so a marker that's the sole content of an agent-printed line arrives as `• <<<PMUX_DONE req=... status=complete>>>` rather than the bare marker — every exact standalone-line comparison in `src/pane.ts` required nothing-but-the-marker on the line, so this broke `doneSignal:false` on `parseDoneSignal`/`extractMarkerBlock` and false negatives on `hasPriorTurnCompletion`.

Added a single new helper, `normalizeMarkerCandidate(s)`: `s.trim().replace(/^[•●◦▪∙*-]\s+/, "")` — trims, then strips **at most one** leading decoration prefix (the regex is anchored and non-global, so it can only ever strip once regardless). The trailing side is untouched and stays strict — nothing is allowed after the marker, same as before.

This one function is now the single source for every standalone-line marker check in the file:
- `matchWrappedMarker` (the shared wrap-tolerant span-matcher used by both `parseDoneSignal` and `extractMarkerBlock`) — normalizes the joined multi-line span before comparing, so a decoration on the first physical line of a wrapped marker is also tolerated.
- `extractMarkerBlock`'s per-line exact check (BEGIN/END, both short and legacy long form).
- `parseDoneSignal`'s per-line exact check (DONE, both forms).
- `hasPriorTurnCompletion`'s combined-span loop (both the wildcard-legacy and exact-short-form regex paths test against the normalized candidate).

Echo-safety is unaffected: the split-string footer (`paths.ts` §3.4) never contains a complete marker substring in the first place, decorated or not, so there's nothing for a decoration prefix to accidentally complete — verified explicitly with a new test that decorates every line of an echoed footer and confirms it still doesn't match.

### test/unit.mjs additions

- Parametrized test over all seven decoration chars in the class (`•●◦▪∙*-`) — each confirmed tolerated on a short-form DONE line via `parseDoneSignal`.
- `extractMarkerBlock`: decoration-prefixed short-form BEGIN/END still extracts the body; decoration-prefixed **legacy long-form** BEGIN/END (different bullet on BEGIN vs END) still extracts too.
- `hasPriorTurnCompletion`: decoration-prefixed short-form DONE and decoration-prefixed legacy END both still recognized.
- Wrap + decoration combination: a bullet-prefixed marker split across two physical lines is still recognized by `parseDoneSignal`.
- Two negative/strictness guards: trailing junk after a decorated marker still fails to match (trailing side unaffected), and a **doubled** bullet (`• • <marker>`) still fails to match (confirms "at most one" prefix strip, not repeated stripping).
- Echo-safety re-verified under decoration: every line of an echoed split-string footer prefixed with a bullet still produces no match.

### Verification

- `npm run typecheck`: clean, 0 errors.
- `npm run build`: clean.
- `node test/unit.mjs`: all tests pass (96 checks, 0 failures).
