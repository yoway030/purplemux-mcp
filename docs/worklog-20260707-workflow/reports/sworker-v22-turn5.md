DONE

## sworker v22-turn5 report

Scope: `src/pane.ts` (new function), `test/unit.mjs`, `docs/USAGE.md` (new section), plus this report. `src/profiles.ts` needed no changes this turn. Did not touch `src/agents.ts`/`src/schemas.ts`/`test/e2e.mjs` (cworker's territory — confirmed already wired against my new export, see below).

### 1) `detectRuntimeError` (design R6)

Added to `src/pane.ts`: `detectRuntimeError(tail: string, pattern?: RegExp): { found: boolean; match?: string; line?: string }`.

- Default pattern: `/API Error|Overloaded|rate limit|usage limit|stream disconnected|connection error/i`, override accepted as an already-compiled `RegExp`.
- **Tail-scoped only** — takes `tail`, not `pane`, by design; the docstring states plainly that callers must pre-slice and this must never see the full scrollback (same rationale as `classifyReadiness`'s tail-scoped `errorPattern`: a stale quoted error string must be able to scroll out of view).
- **Fully decoupled from readiness** — does not touch `classifyReadiness`, does not produce `launch_failed`, mutates no state. Docstring calls this out explicitly as a hard constraint, not just a convention, since folding it into launch_failed would corrupt the readiness model for a condition (mid-turn runtime failure) that has nothing to do with launch/busy-ness.
- Defensively strips a `g` flag from any caller-supplied pattern before `.exec` (a global regex's `lastIndex` would otherwise make repeated calls with the same RegExp object silently skip matches — caught by a dedicated test).
- Known limitation documented in the function's own docstring (per task instruction): a response body merely *quoting* one of these phrases (error-handling code review, or a design doc discussing this feature) also reports `found:true`. This is accepted as the same class of limitation as `errorPattern`, resolved by handing `{match, line}` back for the LLM consumer to judge in context.

I found `src/agents.ts` already imports and calls `detectRuntimeError(tail)` with exactly this shape (cworker had already wired the round-B consumer side — `pmux_agent_turn`'s `agent_error` early-return, and `runtimeError` fields on `wait_ready`/`status`/`send`/`turn`) — my implementation slots in without any signature mismatch; `npm run typecheck` is fully clean (0 errors, including agents.ts).

### 2) `test/unit.mjs`

- Default-pattern keyword coverage (all six documented phrases).
- No-match case on an ordinary completed-turn tail → `found:false`, `match`/`line` both `undefined`.
- **Citation case** (as requested): a response body that quotes `"API Error: 529 Overloaded"` while discussing a retry handler still reports `found:true` — asserted explicitly, with a comment noting this is the known limitation and the consumer's job to judge from `{match,line}`.
- Override-pattern test (custom pattern replaces, not supplements, the default vocabulary).
- Statelessness test: two calls with the same global-flag (`/Overloaded/g`) pattern object both find the match (guards the `lastIndex`-creep fix).
- **Real fixture**: `test/fixtures/claude-529-observed.txt` (real observed transcript, prepared by the task author) → `found:true` with populated `match`/`line`, **and** — in the same check — `classifyReadiness` on that identical capture still reports `agent_ready` (bare `❯` composer, full status frame). This directly demonstrates the R6 motivating scenario: a task can die mid-turn while every readiness signal still says the session is genuinely ready, and the two facts must coexist rather than one overriding the other.

### 3) `docs/USAGE.md` — R5 cookbook

Added `## 6. 에이전트 오케스트레이션 cookbook (pmux_agent_*)`, 36 lines (well under the ~80-line budget), covering exactly what was asked:
- Recommended workflow: `list_workspaces` → `agent_start` (check `hooksWired`/`recommendedFileOutput`) → `wait_ready` → `agent_turn` (or `send`+`capture`) → `close_tab`.
- Hooked vs non-hooked session difference via `signalSource` (`"cliState"` vs `"pane"`).
- `fileOutput` routing off `recommendedFileOutput`.
- Fallback when stuck: `pmux_capture_pane` directly, or `pmux_send_input` for an `agent_blocked` approval prompt.
- `runtimeError` re-prompt pattern, including `pmux_agent_turn`'s early `agent_error` return and the citation-false-positive caveat.

Verified `pmux_agent_turn` is now actually registered (`src/agents.ts:1315`) before writing the cookbook around it, rather than assuming it from the design doc alone.

### Verification

- `npm run typecheck`: clean, 0 errors (across the whole project, including agents.ts).
- `npm run build`: clean.
- `node test/unit.mjs`: all tests pass (105 checks, 0 failures).
