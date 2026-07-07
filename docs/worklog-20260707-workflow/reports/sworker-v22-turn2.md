DONE

## sworker v22-turn2 report

Scope kept to pure-layer files only: `src/profiles.ts`, `src/pane.ts`, `test/unit.mjs`, plus this report. Did not touch `src/agents.ts`/`src/schemas.ts`/`test/e2e.mjs` (cworker's parallel territory — confirmed via `git status`, left untouched).

### 1) `hasPriorTurnCompletion` (Opus B1 blocking fix)

Added to `src/pane.ts`: `hasPriorTurnCompletion(o: { pane; agentId; turn; requestId? }): boolean`. Recognizes:
- ① the pre-R2 legacy DONE/END form (`agent=<id> turn=<n>`, with an **optional/wildcarded** `req=...` field — a caller checking an older turn generally doesn't know that turn's historical requestId, so any-or-no-req counts, matching the original `hasPriorTurnEnd`/`hasPriorDoneSignal` semantics in `agents.ts`).
- ② when `requestId` is supplied, **also** the R2 short form (`req=<rid>` only, no agent/turn) for exactly that requestId.

Derivation is 100% from `makeMarkers`/`makeDoneMarker` — never a hand-typed marker literal (the exact bug class that made the old `agents.ts` regexes miss R2's short form, since they required `agent=`/`turn=` unconditionally). The "wildcard req" regex is built by diffing a no-req marker against a legacy-form marker generated with a throwaway probe token (`legacyMarkers`/`legacyDoneMarker` called with `requestId: "X7QDIFFPROBE9K2"`) — the common prefix/suffix of the two strings bracket exactly the differing req segment, so the optional group is derived, not retyped. **Bug found and fixed during this**: the naive prefix/suffix diff overlapped by one character for the DONE marker specifically, because the space before `status=` is the last char of the common prefix scan AND (independently) the first char of the common suffix scan — both scans "claimed" it, corrupting the derived middle segment. Fixed by clamping `suffixLen` to `min(rawSuffixLen, noReq.length - prefixLen, withProbeReq.length - prefixLen)`. Caught by my own `requestId 미지정 시 구형만` test before I'd have shipped it broken.

Matching is standalone-line-or-wrap-tolerant (same wrap-tolerant approach as `parseDoneSignal`/`extractMarkerBlock` — join up to 4 consecutive physical lines, trim only the outer edges).

### 2) `test/unit.mjs`: `hasPriorTurnCompletion` regression suite

Short-form DONE (req given), requestId-omitted-only-recognizes-legacy (plus a companion assertion that the legacy no-req form is still recognized), legacy-form-with-arbitrary-req (wildcard), short-form END (fileOutput=false path), legacy END, wrap-tolerant split marker, and three contamination guards (wrong requestId, wrong turn, wrong agentId all correctly rejected).

### 3) `BUSY_RE` narrowed (Opus 관찰1, non-blocking)

`\bworking\b` and the braille-spinner block no longer match independently anywhere in tail(30). Narrowed to require adjacency: `\bworking\b` immediately followed by `...`/`…`/`(`/a braille glyph, or a braille glyph immediately followed by `\bworking\b`. `esc to interrupt` unchanged. Rationale: an unqualified `\bworking\b` anywhere in a multi-turn response body ("the script is working correctly") or a bare braille glyph anywhere in tail is too broad for a pane-fallback busy signal; requiring status-bar-style adjacency ties it back to an actual spinner context. Existing `Working (3s · ...)` synthetic test still passes (paren immediately follows).

### 4) Codex review C1 (queued detection scanned the wrong line) — scope added mid-turn

Bug: `classifyReadiness`'s queued/bare-composer check only looked at the pane's last non-blank line. In `--no-alt-screen` scrolling output, a status-bar redraw can land *below* a dirty/queued composer, so the last non-blank line is the status bar, not the composer — the queued check then missed entirely, and the old fast glyph path (`readyPattern.test(tail)`, "is `›`/`❯` anywhere in tail") still saw the glyph and wrongly promoted to `agent_ready`. This reintroduces the exact "queued input read as ready" failure R1 was meant to close.

Fix: added `lastComposerLine(tail, glyph)` — scans tail(30) bottom-up for the last line that *starts* with the composer glyph, regardless of what non-composer content (status bar, blank lines) sits below it — and both the queued check and the bare-composer ready check now inspect that line instead of the pane's last non-blank line. `frameSeen`'s "not queued" condition is unaffected (queued is checked before frameSeen's ready branch, so it still gates it).

New tests: SYNTHETIC REJECT case (composer with dirty text, blank line, then a status bar below it → must stay `agent_starting`/`input_queued`, not promoted to ready) and its companion positive case (bare composer + blank + status bar below it → still `agent_ready`/`bare composer`, proving the fix doesn't regress the true-ready shape).

**⚠️ Behavior change worth the design owner's attention — both turn1 real fixtures flipped from `agent_ready` to `agent_starting`/`input_queued`.** `claude-idle-real.txt` and `codex-idle-real.txt` both happen to show the composer glyph followed by trailing text (`"Explain this codebase"` / the echoed `"REPORT_READY ..."` message) with only a blank line + status bar after it — structurally **identical** to the new REJECT regression case. Pane text alone cannot distinguish "an already-submitted history bubble" from "an unsent queued draft" in this shape; C1's fix conservatively treats it as not-verifiably-ready, which I believe is the right call for a *fallback* heuristic (a false `agent_ready` risks double-send/corrupting a real queued draft; a false `agent_starting` just costs a re-poll). I updated both fixture tests to assert the new outcome rather than silently keep the turn1 expectation or silently drop the C1 fix. If the design owner disagrees with this read of the two real captures, the fix and the two fixture tests are both in `src/pane.ts`/`test/unit.mjs` at the "R1 real-capture fixtures" section — flagging here per the design's own note that pane-only disambiguation of this shape is inherently unreliable and the native `cliState` channel (R0) is what should resolve it in practice.

### Verification

- `npm run typecheck`: clean, 0 errors.
- `npm run build`: clean.
- `node test/unit.mjs`: all tests pass (81 checks, 0 failures).
