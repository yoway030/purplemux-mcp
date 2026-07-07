DONE

## sworker v22-turn4 report

Scope kept to pure-layer files only: `src/pane.ts`, `test/unit.mjs`, plus this report. `src/profiles.ts` needed no changes this turn. Did not touch `src/agents.ts`/`src/schemas.ts`/`test/e2e.mjs` (cworker's parallel territory).

### Fix: placeholder composer text is not reliably "queued"

Live discovery: codex redisplays a placeholder ghost text in the composer whenever it's empty — not only at boot, but after **every** turn completes too (e.g. `› Implement {feature}`). Turn2's queued-detection (C1) treated any non-blank composer line as queued, so this placeholder made every `turn > 1` `send` misfire as `not_ready`/queued.

Fix in `classifyReadiness` (`src/pane.ts`): added `hasProtocolSignature(line)` — `/PMUX_|응답 규약/.test(line)`. The composer's non-blank case now branches:
- if the last composer line carries our own protocol signature (a `<<<PMUX_...>>>` marker fragment or the `[응답 규약]` file-output instruction) → `agent_starting`/`"input_queued"` (unchanged from turn2/C1).
- otherwise (placeholder ghost text, or any other unrelated text) → treated as a ready candidate, same as a bare composer, with reason `"placeholder composer"`.

Rationale (matches the task's own framing): `pmux_agent_send` always injects a footer containing one of those two substrings into anything it genuinely sends, so a truly unsubmitted-by-us prompt is guaranteed to carry the signature. Composer text without it cannot be a queued send from this system, so it's safe — and, given the placeholder-after-every-turn behavior, necessary — to treat it as ready.

Bare-composer check still runs first (unchanged), so it's unaffected by this branch.

### Side effect worth noting: this resolves the turn2 tension

Both real fixtures (`claude-idle-real.txt`, `codex-idle-real.txt`) flip back from `agent_starting`/`input_queued` (turn2) to `agent_ready` (turn1's original expectation), because neither fixture's trailing composer text ("Explain this codebase" / the echoed "REPORT_READY ..." message) carries our protocol signature. I'd flagged this exact ambiguity as unresolved in `sworker-v22-turn2.md` — turn4's signature check turns out to be the missing piece that resolves it correctly: composer text that isn't ours to begin with should never have been treated as "our queued input" in the first place. Updated both fixture tests accordingly (with a comment linking back to the turn2/turn4 history for anyone reading the diff later).

### test/unit.mjs changes

- Rewrote the turn1 "queued/composer-dirty text" test and the turn2 C1 "REJECT" test to use signature-bearing composer text (`"still typing PMUX_ draft..."` / `"draft mentioning PMUX_ marker..."`) — these are the only shape genuinely-queued input from this system can take, per the new rule; both still assert `input_queued`.
- Added the three cases requested this turn:
  - placeholder text (`"› Implement {feature}"`) → `agent_ready`/`"placeholder composer"`.
  - composer text containing a `PMUX_` marker fragment → `agent_starting`/`"input_queued"`.
  - composer text containing `[응답 규약]` → `agent_starting`/`"input_queued"`.
- Updated the two real-fixture tests to `agent_ready` with an explanatory comment (see above).

### Verification

- `npm run typecheck`: clean, 0 errors.
- `npm run build`: clean.
- `node test/unit.mjs`: all tests pass (99 checks, 0 failures).
