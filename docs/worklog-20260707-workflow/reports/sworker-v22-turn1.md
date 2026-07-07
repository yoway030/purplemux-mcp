DONE

## sworker v22-turn1 report

Scope kept to pure-layer files only: `src/profiles.ts`, `src/pane.ts`, `test/unit.mjs`, plus this report. Did not touch `src/agents.ts`, `src/schemas.ts`, `test/e2e.mjs`, `src/paths.ts`, or `package.json` (those show as concurrently modified by another worker in `git status`; left untouched).

### src/profiles.ts

- `SHELL_NAMES` exported: `["bash", "zsh", "fish", "sh", "dash"]`.
- `mapCliState(provider, cliState): ReadinessState | null` added, per R0.1b live-PoC table exactly:
  - common: `busy` → `agent_busy`, `notification` → `agent_blocked`
  - `needs-input` → `agent_ready` for both providers
  - `ready-for-review` → `agent_ready` (codex) / `agent_blocked` (claude) — provider-specific, no blanket mapping
  - everything else (`idle`, `unknown`, future/unrecognized values) → `null` (pane fallback, open-set per G7)
- `frameSignaturePatterns(provider)` exported — codex: `Read Only|Workspace|gpt-|·`; claude: input-box border (`─{3,}`) + status-line tells (`shift+tab`, `for agents`, `⏵⏵`).
- `defaultBusyPattern` extended: added `\bworking\b` (word-boundary, so it doesn't false-positive on "Worked"/"workspace") and the braille-spinner block, alongside the existing `esc to interrupt`.
- `ReadinessState` is imported as a type-only import from `./pane.js` (erased at compile time — no runtime cycle with pane.ts's value import of profiles.ts).

### src/pane.ts

- `ReadinessState` gains `"agent_blocked"`.
- `classifyReadiness` (R1, additive): tail widened 15→30; `frameSeen` = 2+ status-bar signature hits in tail; shell-prompt-return now gated on `!frameSeen`; busy check unchanged priority; new queued/composer-dirty check (`›`/`❯` glyph followed by non-blank text on the pane's last non-blank line, not busy) → `agent_starting` reason `"input_queued"`; ready := bare composer (last non-blank line is exactly the glyph) OR existing readyPattern fast path OR frameSeen — old glyph fast path is untouched (not inverted).
- `makeMarkers`/`makeDoneMarker` (R2 §1): when `requestId` is given, output is shortened to `<<<PMUX_BEGIN req=<rid>>>>`/`<<<PMUX_END req=<rid>>>>`/`<<<PMUX_DONE req=<rid> status=<s>>>>` (agent/turn dropped — req alone is the unique key). When `requestId` is omitted, the original agent/turn form is unchanged (only identifier available on that path).
- `extractMarkerBlock`/`parseDoneSignal` (R2 §1/§2): parse both the new short form and the pre-R2 long form (agent+turn+req together) when `requestId` is given — generation stays single-source (`makeMarkers`/`makeDoneMarker`), a private `legacyMarkers`/`legacyDoneMarker` pair exists only for backward-compat recognition, never for generation. Both also gained wrap-tolerant matching: a marker split across up to 4 consecutive physical lines (narrow pane) is recognized by joining the raw lines and trimming only the outer edges (not per-line — per-line trim would eat a real space that happens to land exactly at the wrap boundary; caught by my own first draft of the BEGIN/END wrap test, fixed).

### test/unit.mjs

- `mapCliState`: all combinations (common busy/notification, needs-input, provider-specific ready-for-review, open-set fallback for idle/unknown/future values).
- `SHELL_NAMES` sanity check.
- Fixture-based readiness tests against the real captures you prepared, `test/fixtures/claude-idle-real.txt` and `codex-idle-real.txt` — both assert `agent_ready` (via `checkAsync`, not synchronous `check`, since they read files).
- New R1 cases explicitly marked `SYNTHETIC` (G7): fresh bare composer, response-complete-with-glyph-scrolled-out (exercises the frameSeen path specifically, independent of the old glyph fast path — neither real fixture actually exercises frameSeen since both still contain the glyph within tail(30)), `Working` busy variant, y/n approval prompt (→ `agent_starting`, not ready/busy — `agent_blocked` is native-channel-only per design, not a pane-heuristic output), queued/input-not-yet-submitted text, and two `$`-ending body/status-line cases (codex + claude) proving `frameSeen` suppresses the old shell-return false positive.
- Existing `errorPattern is tail-scoped` regression test's filler bumped 20→40 lines so it still exceeds the widened tail(30) window (unavoidable consequence of the tail widening; behavior/intent unchanged).
- Marker old/new format + roundtrip: short-form generation, legacy long-form backward-compat recognition (both DONE and BEGIN/END), a mixed-pane "legacy earlier, short-form later → last wins" case, and wrap-tolerant matching for both DONE and BEGIN/END (plus an echo-safety check that a narrowly-rewrapped footer still never assembles into a real marker).

### Verification

- `npm run typecheck`: clean, 0 errors (including `src/agents.ts` — no ignorable/stale-contract errors to report; the other worker's `agents.ts` changes already call `mapCliState`/`SHELL_NAMES` with the signatures implemented here).
- `npm run build`: clean.
- `node test/unit.mjs`: all tests pass (69 checks, 0 failures).
