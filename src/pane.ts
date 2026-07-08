import {
  defaultBusyPattern,
  defaultErrorPattern,
  defaultReadyPattern,
  frameSignaturePatterns,
  type Provider,
} from "./profiles.js";

// Matches CSI/OSC ANSI escape sequences emitted by tmux capture-pane.
// Built from character codes (rather than \x/\u literals) so ESC (27) and
// BEL (7) land as plain source text, not raw control bytes.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  ESC +
    "[[\\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?" +
    BEL +
    ")|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]))",
  "g",
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Last `n` lines of `s` (raw split on \n / \r\n), joined with \n. */
/**
 * Standard tail width for agent-tool responses/validation (the `tail` field
 * and readiness checks). Distinct from TAIL_WIDTH (30) used by pane
 * classification internals.
 */
export const TAIL_LINES = 15;

export function tailLines(s: string, n: number): string {
  if (n <= 0) return "";
  return s.split(/\r?\n/).slice(-n).join("\n");
}

// codex's TUI prefixes each printed agent-output line with a decorative
// bullet/dash (design v22 턴3 라이브 발견) — one such prefix, stripped once.
const DECORATION_PREFIX_RE = /^[•●◦▪∙*-]\s+/;

/**
 * Single source for the "standalone marker line" rule shared by
 * `parseDoneSignal`, `extractMarkerBlock`, `hasPriorTurnCompletion`, and
 * their wrap-tolerant paths (design v22 턴3): a live capture showed codex
 * printing agent output with a leading decoration ("• <<<PMUX_DONE ...
 * >>>"), which broke every exact standalone-line comparison in this file
 * (`doneSignal:false`, `hasPriorTurnCompletion` false negatives) since none
 * of them tolerated anything before the marker. Trim, then strip ONE
 * leading decoration prefix — the trailing side stays strict (nothing is
 * ever allowed after the marker; that's still what keeps a prompt-echoed
 * instruction line or a body line that merely quotes a marker from
 * matching). Echo-safety is unaffected by this loosening: the split-string
 * footer (paths.ts §3.4) never contains a complete marker substring in the
 * first place, decorated or not, so there is nothing for a decoration
 * prefix to accidentally complete.
 */
function normalizeMarkerCandidate(s: string): string {
  return s.trim().replace(DECORATION_PREFIX_RE, "");
}

/**
 * Single source of truth for the BEGIN/END pane-fallback markers (design R2
 * §1). A pane signal is already uniquely identified by `requestId`, so
 * agent/turn are redundant on that path — shortened to `<<<PMUX_BEGIN
 * req=<rid>>>>`/`<<<PMUX_END req=<rid>>>>`. When requestId is omitted
 * (fileOutput=false with no req assigned), agent/turn remain the only
 * identifier and the original long form is kept.
 */
export function makeMarkers(o: {
  agentId: string;
  turn: number;
  requestId?: string;
}): { begin: string; end: string } {
  if (o.requestId !== undefined) {
    return {
      begin: `<<<PMUX_BEGIN req=${o.requestId}>>>`,
      end: `<<<PMUX_END req=${o.requestId}>>>`,
    };
  }
  return {
    begin: `<<<PMUX_BEGIN agent=${o.agentId} turn=${o.turn}>>>`,
    end: `<<<PMUX_END agent=${o.agentId} turn=${o.turn}>>>`,
  };
}

/**
 * Pre-R2 long-form BEGIN/END (agent+turn+req all present) — recognized ONLY
 * for backward compatibility when a pane still carries a marker written
 * before this shortening shipped (design R2 §1 "구형 호환"). Never used for
 * generation — `makeMarkers` above is the sole generator.
 */
function legacyMarkers(o: {
  agentId: string;
  turn: number;
  requestId: string;
}): { begin: string; end: string } {
  return {
    begin: `<<<PMUX_BEGIN agent=${o.agentId} turn=${o.turn} req=${o.requestId}>>>`,
    end: `<<<PMUX_END agent=${o.agentId} turn=${o.turn} req=${o.requestId}>>>`,
  };
}

/**
 * Wrap-tolerant marker equality (design R2 §2, belt-and-suspenders): a
 * marker line can arrive split across two-plus physical terminal lines when
 * the pane is narrower than the marker text. Looks for a run of up to
 * `maxSpan` consecutive raw lines, starting at `startIdx`, whose RAW
 * concatenation (no separator, no per-line trim — a real wrap never inserts
 * or drops a character mid-stream) equals `marker` once only the overall
 * leading/trailing whitespace is trimmed (incidental pane padding around the
 * whole span, not a mid-marker boundary — trimming each line individually
 * would wrongly eat a real space that happens to land exactly at a wrap
 * boundary). Returns the span length (>=1) consumed, or null if none match.
 * Safe against echo false positives: the split-string footer (paths.ts
 * §3.4) never contains a complete marker substring, so no echo can ever
 * join into one even under this looser check. Also goes through
 * `normalizeMarkerCandidate` (턴3) so a decoration prefix on the first
 * physical line of a wrapped span doesn't block the match either.
 */
function matchWrappedMarker(
  lines: string[],
  startIdx: number,
  marker: string,
  maxSpan: number,
): number | null {
  for (let span = 1; span <= maxSpan && startIdx + span <= lines.length; span++) {
    const combined = normalizeMarkerCandidate(
      lines.slice(startIdx, startIdx + span).join(""),
    );
    if (combined === marker) return span;
  }
  return null;
}

export function buildSentinelFooter(o: {
  agentId: string;
  turn: number;
  requestId?: string;
  maxResponseLines: number;
}): string {
  const { begin, end } = makeMarkers(o);
  return `응답은 반드시 ${begin} 와 ${end} 사이에만, ${o.maxResponseLines}줄 이내로 작성하세요.`;
}

export type MarkerResult =
  | { status: "complete"; content: string }
  | { status: "partial"; contentSoFar: string }
  | { status: "missing" };

/**
 * Extract the last valid BEGIN/END pair for the given identifiers. A marker
 * only counts when, after `normalizeMarkerCandidate` (stripAnsi+trim+at-most-
 * one leading decoration prefix, 턴3), its line contains the marker and
 * NOTHING else — this excludes prompt-echo lines where the sentinel
 * instruction text ("...사이에만...") or both BEGIN+END sit on the same
 * line (design §4.5-1). The trailing side stays strict throughout.
 */
export function extractMarkerBlock(o: {
  pane: string;
  agentId: string;
  turn: number;
  requestId?: string;
}): MarkerResult {
  const { begin, end } = makeMarkers(o);
  const beginCandidates = [begin];
  const endCandidates = [end];
  if (o.requestId !== undefined) {
    const legacy = legacyMarkers({
      agentId: o.agentId,
      turn: o.turn,
      requestId: o.requestId,
    });
    beginCandidates.push(legacy.begin);
    endCandidates.push(legacy.end);
  }
  const lines = stripAnsi(o.pane).split(/\r?\n/);

  let openBeginIdx = -1; // index of the first content line (i.e. right after BEGIN)
  let completeContent: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const trimmed = normalizeMarkerCandidate(lines[i]);

    if (beginCandidates.includes(trimmed)) {
      openBeginIdx = i + 1;
      i += 1;
      continue;
    }
    if (endCandidates.includes(trimmed) && openBeginIdx !== -1) {
      completeContent = lines.slice(openBeginIdx, i).join("\n");
      openBeginIdx = -1;
      i += 1;
      continue;
    }

    let advanced = false;
    for (const m of beginCandidates) {
      const span = matchWrappedMarker(lines, i, m, 4);
      if (span !== null && span > 1) {
        openBeginIdx = i + span;
        i += span;
        advanced = true;
        break;
      }
    }
    if (!advanced && openBeginIdx !== -1) {
      for (const m of endCandidates) {
        const span = matchWrappedMarker(lines, i, m, 4);
        if (span !== null && span > 1) {
          completeContent = lines.slice(openBeginIdx, i).join("\n");
          openBeginIdx = -1;
          i += span;
          advanced = true;
          break;
        }
      }
    }
    if (!advanced) i += 1;
  }

  if (openBeginIdx !== -1) {
    return {
      status: "partial",
      contentSoFar: lines.slice(openBeginIdx).join("\n"),
    };
  }
  if (completeContent !== null) {
    return { status: "complete", content: completeContent };
  }
  return { status: "missing" };
}

export type ReadinessState =
  | "agent_ready"
  | "agent_busy"
  | "agent_starting"
  | "agent_blocked"
  | "launch_failed";

// Bash/zsh/root prompt returning after a launch command echo — the tell for
// a silent boot failure (design §2.2 "조용한 부팅 실패").
const SHELL_PROMPT_RE = /[$#%]\s*$/;

// R1: composer glyph per provider — used for bare-composer/queued detection
// on the pane's last non-blank line, distinct from readyPattern (which may
// be a caller override and is checked against the whole tail).
function composerGlyph(provider: Provider): string {
  return provider === "codex" ? "›" : "❯";
}

function isBareComposer(line: string, glyph: string): boolean {
  return new RegExp(`^\\s*${glyph}\\s*$`).test(line);
}

function isQueuedComposer(line: string, glyph: string): boolean {
  return new RegExp(`^\\s*${glyph}\\s*\\S`).test(line);
}

/**
 * Does this composer line carry OUR protocol's own footer text (design v22
 * 턴4 라이브 발견)? codex redisplays a placeholder in the composer whenever
 * it's empty — not only at boot, but after EVERY turn completes too (e.g.
 * "› Implement {feature}") — so a non-blank composer line is not
 * necessarily a genuinely queued/unsent prompt; it's just as likely to be
 * that placeholder ghost text, and treating it as queued made every
 * post-turn-1 `send` misfire as `not_ready`. `pmux_agent_send` always
 * injects a footer containing either a `<<<PMUX_...>>>` marker or the
 * `[응답 규약]` file-output instruction (see buildSentinelFooter/
 * makeFileFooter/buildPaneFallbackFooter) — so genuinely unsubmitted input
 * from OUR OWN send path is guaranteed to carry one of these substrings.
 * Composer text without either is therefore either a CLI placeholder or
 * unrelated text this system didn't put there, and in both cases treating
 * it as a ready candidate (same as a bare composer) is the correct/safe
 * call here.
 */
const PROTOCOL_SIGNATURE_RE = /PMUX_|응답 규약/;

// claude approval-dialog signatures (plan-mode "Would you like to proceed?"
// and permission prompts). Needed because claude's native cliState
// "ready-for-review" was degraded to null (see mapCliState) — the pane
// heuristic must now be the one that tells a genuine approval wait apart
// from an idle post-turn composer. Tail-scoped like busy/ready, so a
// response body quoting one of these phrases can linger only briefly (same
// documented limitation as detectRuntimeError).
// Case-insensitive + common permission-prompt variants (리뷰 NIT). Still an
// allowlist — an unrecognized future dialog phrasing reads not-blocked, so
// keep extending this from live captures.
const CLAUDE_APPROVAL_DIALOG_RE =
  /would you like to proceed\?|do you want to (?:proceed|make this edit|run this command|allow)|no, keep planning/i;

function hasProtocolSignature(line: string): boolean {
  return PROTOCOL_SIGNATURE_RE.test(line);
}

/**
 * The last line within `tail` that starts with the composer glyph (design
 * v22-턴2 Codex C1 fix): checking only the pane's very last non-blank line
 * missed a queued/dirty composer whenever a status-bar redraw landed BELOW
 * it (common in --no-alt-screen scrolling output) — the composer's dirty
 * text would scroll out of the "last line" check entirely, while the old
 * fast glyph path (readyPattern.test(tail)) still saw the bare `›`/`❯`
 * character anywhere in tail and wrongly promoted to ready, reintroducing
 * the "queued input read as ready" bug. Scanning tail bottom-up for the
 * last composer-prefixed line (regardless of what non-composer content sits
 * below it) recovers the actual current composer content instead of
 * whatever line happens to be physically last.
 */
function lastComposerLine(tail: string, glyph: string): string | null {
  const lines = tail.split(/\r?\n/);
  const composerStart = new RegExp(`^\\s*${glyph}`);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (composerStart.test(lines[i])) return lines[i];
  }
  return null;
}

function isFrameSeen(tail: string, provider: Provider): boolean {
  let hits = 0;
  for (const re of frameSignaturePatterns(provider)) {
    if (re.test(tail)) hits++;
  }
  return hits >= 2;
}

const TAIL_WIDTH = 30;

/**
 * Classification order (design v22 R1, additive over v2 §4.2; queued/bare
 * check corrected in 턴2 per Codex review C1): ① errorPattern → ② shell
 * prompt returned (pane's last non-blank line, ONLY when frameSeen is false
 * — a real CLI frame's status bar can end in `$`/`%`-like glyphs that would
 * otherwise misfire as a shell return) → ③ busyPattern → ④ queued composer
 * (`›`/`❯` followed by non-blank text that carries OUR protocol signature —
 * see `hasProtocolSignature` — checked on the LAST tail line that actually
 * starts with the composer glyph, not the pane's last non-blank line, which
 * can be a status-bar redraw sitting below a dirty composer in
 * --no-alt-screen output; checking the wrong line let the old fast glyph
 * path see `›`/`❯` elsewhere in tail and wrongly promote to ready, i.e. the
 * queued-input-read-as-ready bug the tail-only check reintroduced. Composer
 * text WITHOUT the protocol signature — e.g. codex's post-turn placeholder
 * ghost text ("› Implement {feature}"), redisplayed after every turn, not
 * just at boot — is treated as a ready candidate instead, 턴4) → ⑤ ready :=
 * bare composer OR non-signature composer text (both same last-composer-line)
 * OR existing readyPattern fast path OR frameSeen (status-bar signature,
 * >=2 matches) → ⑥ agent_starting. error/busy/ready/frameSeen are evaluated
 * on tail(30) (widened from 15 in v2 — composer+status-bar+recent output
 * need to coexist in view); a full-pane errorPattern check caused a
 * permanent false "launch_failed" once a multi-turn session's response body
 * ever quoted an error string like "command not found", so error/busy/ready
 * stay tail-scoped like v2. Shell-prompt-return still looks at the pane's
 * last non-blank line (unaffected either way — that check is about a shell
 * returning, not the composer).
 */
export function classifyReadiness(o: {
  pane: string;
  provider: Provider;
  readyPattern?: RegExp;
  errorPattern?: RegExp;
  busyPattern?: RegExp;
}): { state: ReadinessState; reason?: string } {
  const pane = stripAnsi(o.pane);
  const readyPattern = o.readyPattern ?? defaultReadyPattern(o.provider);
  const errorPattern = o.errorPattern ?? defaultErrorPattern(o.provider);
  const busyPattern = o.busyPattern ?? defaultBusyPattern(o.provider);
  const tail = tailLines(pane, TAIL_WIDTH);

  if (errorPattern.test(tail)) {
    return { state: "launch_failed", reason: "error pattern matched" };
  }

  const lines = pane.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? "";
  const frameSeen = isFrameSeen(tail, o.provider);

  if (!frameSeen && SHELL_PROMPT_RE.test(lastLine)) {
    return { state: "launch_failed", reason: "shell prompt returned" };
  }

  if (busyPattern.test(tail)) {
    return { state: "agent_busy", reason: "busy pattern matched" };
  }

  if (o.provider === "claude" && CLAUDE_APPROVAL_DIALOG_RE.test(tail)) {
    return { state: "agent_blocked", reason: "approval dialog" };
  }

  const glyph = composerGlyph(o.provider);
  const composerLine = lastComposerLine(tail, glyph);
  if (composerLine !== null && isBareComposer(composerLine, glyph)) {
    return { state: "agent_ready", reason: "bare composer" };
  }
  if (composerLine !== null && isQueuedComposer(composerLine, glyph)) {
    if (hasProtocolSignature(composerLine)) {
      return { state: "agent_starting", reason: "input_queued" };
    }
    return { state: "agent_ready", reason: "placeholder composer" };
  }
  if (readyPattern.test(tail)) {
    return { state: "agent_ready", reason: "ready pattern matched" };
  }
  if (frameSeen) {
    return { state: "agent_ready", reason: "frame signature matched" };
  }

  return { state: "agent_starting" };
}

/**
 * Single source of truth for the `<<<PMUX_DONE ...>>>` completion signal
 * (design §3.1, shortened by R2 §1). `parseDoneSignal` matches against
 * strings built by THIS function (never a hand-rolled literal), and
 * `makeFileFooter` (paths.ts) builds its footer instruction by slicing this
 * same string — so the generator and the parser can never drift apart (턴4
 * 리뷰 blocking: a hand-copied literal in the footer had one more trailing
 * '>' than the parser expected, permanently blocking eofMarker's DONE-marker
 * sibling). requestId alone uniquely identifies a pane signal, so when it is
 * given, agent/turn are dropped from the marker (R2 §1); when omitted
 * (pane-fallback path with no req assigned), the original agent/turn form is
 * kept since it's the only identifier available.
 */
export function makeDoneMarker(o: {
  agentId: string;
  turn: number;
  requestId?: string;
  status: "complete" | "blocked";
}): string {
  if (o.requestId !== undefined) {
    return `<<<PMUX_DONE req=${o.requestId} status=${o.status}>>>`;
  }
  return `<<<PMUX_DONE agent=${o.agentId} turn=${o.turn} status=${o.status}>>>`;
}

/**
 * Pre-R2 long-form DONE marker (agent+turn+req all present) — recognized
 * ONLY for backward compatibility when a pane still carries a marker written
 * before this shortening shipped (design R2 §1 "구형 호환"). Never used for
 * generation — `makeDoneMarker` above is the sole generator.
 */
function legacyDoneMarker(o: {
  agentId: string;
  turn: number;
  requestId: string;
  status: "complete" | "blocked";
}): string {
  return `<<<PMUX_DONE agent=${o.agentId} turn=${o.turn} req=${o.requestId} status=${o.status}>>>`;
}

/**
 * Detect the single-line `<<<PMUX_DONE ...>>>` completion signal (design
 * §3.1). Only a line that, after `normalizeMarkerCandidate` (stripAnsi+trim+
 * at-most-one leading decoration prefix, 턴3), matches the marker EXACTLY
 * (anchored, via string equality against `makeDoneMarker`'s output) counts —
 * this is the same echo-defense as extractMarkerBlock; the trailing side
 * stays strict. A wrap-tolerant fallback (R2 §2) additionally recognizes the
 * marker split across up to 4 consecutive physical lines (narrow pane
 * wrap), joined with no separator. The LAST matching line/span wins.
 * `requestId` is a gate: when given, the signal must carry that exact
 * `req=` field (either the current short form or the pre-R2 long form);
 * when omitted, only a signal with NO `req=` field at all matches (the
 * pane-block fallback path, which never emits req).
 */
export function parseDoneSignal(o: {
  pane: string;
  agentId: string;
  turn: number;
  requestId?: string;
}): { found: boolean; status?: "complete" | "blocked" } {
  const pane = stripAnsi(o.pane);
  const candidates: Array<{ marker: string; status: "complete" | "blocked" }> =
    [
      { status: "complete", marker: makeDoneMarker({ ...o, status: "complete" }) },
      { status: "blocked", marker: makeDoneMarker({ ...o, status: "blocked" }) },
    ];
  if (o.requestId !== undefined) {
    const { agentId, turn, requestId } = o;
    candidates.push(
      { status: "complete", marker: legacyDoneMarker({ agentId, turn, requestId, status: "complete" }) },
      { status: "blocked", marker: legacyDoneMarker({ agentId, turn, requestId, status: "blocked" }) },
    );
  }

  const lines = pane.split(/\r?\n/);
  let status: "complete" | "blocked" | undefined;

  let i = 0;
  while (i < lines.length) {
    const trimmed = normalizeMarkerCandidate(lines[i]);
    const exact = candidates.find((c) => c.marker === trimmed);
    if (exact) {
      status = exact.status;
      i += 1;
      continue;
    }
    let advanced = false;
    for (const c of candidates) {
      const span = matchWrappedMarker(lines, i, c.marker, 4);
      if (span !== null && span > 1) {
        status = c.status;
        i += span;
        advanced = true;
        break;
      }
    }
    if (!advanced) i += 1;
  }
  return status !== undefined ? { found: true, status } : { found: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// Arbitrary alnum token used only as a diffing probe (never emitted to a
// pane) — see wildcardReqRegex.
const REQ_DIFF_PROBE = "X7QDIFFPROBE9K2";

/**
 * Build a regex that matches `noReq` (a single-source marker generated with
 * requestId omitted) OR the same marker carrying an arbitrary `req=<...>`
 * field, WITHOUT hand-typing the marker's literal text. Derived purely by
 * diffing `noReq` against `withProbeReq` (the same marker generated via the
 * legacy long-form helper with requestId=REQ_DIFF_PROBE): the common prefix
 * and common suffix of the two strings bracket exactly the req-field segment
 * that differs between them, so the "optional req" group is whatever sits
 * between the two diff boundaries — never retyped, so it can never drift
 * from makeMarkers/makeDoneMarker the way a hand-copied regex literal did
 * before (design R2 §1, and the exact bug class 턴2 Opus B1 flagged in
 * hasPriorTurnEnd/hasPriorDoneSignal's old hand-rolled regexes).
 */
function wildcardReqRegex(noReq: string, withProbeReq: string): RegExp {
  const prefixLen = commonPrefixLength(noReq, withProbeReq);
  // Clamp against the shorter string's remaining length after the prefix —
  // without this, a repeated character straddling the diff boundary (e.g.
  // the DONE marker's " status=" space also being the last char of the
  // no-req prefix AND the first char of the common suffix) makes the raw
  // prefix/suffix scans overlap, double-counting that character and
  // corrupting the derived middle segment.
  const rawSuffixLen = commonSuffixLength(noReq, withProbeReq);
  const suffixLen = Math.min(
    rawSuffixLen,
    noReq.length - prefixLen,
    withProbeReq.length - prefixLen,
  );
  const prefix = noReq.slice(0, prefixLen);
  const suffix = suffixLen > 0 ? noReq.slice(noReq.length - suffixLen) : "";
  const middle = withProbeReq.slice(prefixLen, withProbeReq.length - suffixLen);
  const middlePattern = escapeRegExp(middle).replace(REQ_DIFF_PROBE, "\\S+");
  return new RegExp(
    `^${escapeRegExp(prefix)}(?:${middlePattern})?${escapeRegExp(suffix)}$`,
  );
}

function exactLineRegex(marker: string): RegExp {
  return new RegExp(`^${escapeRegExp(marker)}$`);
}

/**
 * Did agent/turn already complete before this call (design R2, 턴2 Opus B1
 * fix)? Used to validate `expectPrevTurnEnd`-style checks. Recognizes:
 * ① the pre-R2 legacy DONE/END form (`agent=<id> turn=<n>`, with an
 *    OPTIONAL/wildcarded `req=<...>` field — the historical requestId used
 *    for that earlier turn is generally not known by the caller, so any or
 *    no req counts, matching the original pre-R2 hasPriorTurnEnd /
 *    hasPriorDoneSignal semantics), and
 * ② when `requestId` is supplied, ALSO the R2 short form (`req=<rid>`
 *    only, no agent/turn) for exactly that requestId.
 * Both are derived from `makeMarkers`/`makeDoneMarker` (single source) —
 * never a hand-rolled marker literal, so a future format change is picked
 * up automatically instead of silently going stale like the regexes this
 * replaces. Matching is standalone-line-or-wrap-tolerant, mirroring
 * `parseDoneSignal`/`extractMarkerBlock`.
 */
export function hasPriorTurnCompletion(o: {
  pane: string;
  agentId: string;
  turn: number;
  requestId?: string;
}): boolean {
  const { agentId, turn } = o;
  const patterns: RegExp[] = [];

  const legacyEndNoReq = makeMarkers({ agentId, turn }).end;
  const legacyEndProbe = legacyMarkers({
    agentId,
    turn,
    requestId: REQ_DIFF_PROBE,
  }).end;
  patterns.push(wildcardReqRegex(legacyEndNoReq, legacyEndProbe));

  for (const status of ["complete", "blocked"] as const) {
    const doneNoReq = makeDoneMarker({ agentId, turn, status });
    const doneProbe = legacyDoneMarker({
      agentId,
      turn,
      requestId: REQ_DIFF_PROBE,
      status,
    });
    patterns.push(wildcardReqRegex(doneNoReq, doneProbe));
  }

  if (o.requestId !== undefined) {
    const { requestId } = o;
    patterns.push(exactLineRegex(makeMarkers({ agentId, turn, requestId }).end));
    for (const status of ["complete", "blocked"] as const) {
      patterns.push(
        exactLineRegex(makeDoneMarker({ agentId, turn, requestId, status })),
      );
    }
  }

  const lines = stripAnsi(o.pane).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (let span = 1; span <= 4 && i + span <= lines.length; span++) {
      const combined = normalizeMarkerCandidate(lines.slice(i, i + span).join(""));
      if (patterns.some((re) => re.test(combined))) return true;
    }
  }
  return false;
}

// Live-observed runtime-failure vocabulary (design R6, v22-턴5): a task can
// die mid-turn (529/rate-limit/connection failure) while every readiness
// signal still reports the session as genuinely ready — cliState
// needs-input and a bare composer are both true at once, so nothing in the
// R0/R1 state model ever notices. Override with a caller-supplied pattern
// (<=200 chars, validated the same way as ready/error/busyPattern) for
// other CLIs' wording.
// Narrowed (실측 2026-07-07/08): bare `usage limit`/`rate limit` matched
// benign informational text on BOTH providers — codex's "You have 3 usage
// limit resets available" banner and claude's "you can use up to 50% of
// your plan's weekly usage limit on Fable 5" promo. A limit phrase now
// counts only next to a failure verb (reached/exceeded/hit, either order),
// so an orchestrator that aborts on runtimeError doesn't abort on a banner.
// Reviewed & agreed by codex/claude subagent panel (2026-07-08 합의).
const DEFAULT_RUNTIME_ERROR_RE =
  /\b(?:API Error(?::\s*\d+)?|Overloaded|stream disconnected|connection (?:error|failed|lost|reset|closed|timed out)|ECONNRESET|ETIMEDOUT|too many requests|(?:rate|usage) limit (?:reached|exceeded|hit)|(?:reached|exceeded|hit) (?:the |your )?(?:rate|usage) limit)\b/i;

/**
 * Detect a runtime-error signature within an ALREADY tail-scoped string
 * (design R6). Takes `tail`, not `pane`, deliberately — the caller must
 * pre-slice (e.g. via `tailLines`); this function must never be handed the
 * full scrollback. Scanning the whole pane would reintroduce exactly the
 * bug classifyReadiness's errorPattern check hit and fixed by going
 * tail-scoped: a response body that quoted an error string many turns ago
 * would pin `found:true` forever instead of scrolling out like everything
 * else.
 *
 * **Deliberately orthogonal to readiness — never feed this into
 * classifyReadiness/launch_failed.** A session that is genuinely ready
 * (bare composer, correct cliState) IS ready and can be re-prompted, even
 * if its last turn silently died to a 529 — that's the whole point of this
 * function existing separately (§0 "죽은 태스크가 ready로 보인다" 사각).
 * Folding this into launch_failed or agent_busy would corrupt the readiness
 * state model for a condition that has nothing to do with launch or
 * busy-ness. This returns an orthogonal fact only; `wait_ready`/`status`/
 * `send`/`turn` surface it as a `runtimeError` field alongside (not instead
 * of) the readiness state, and deciding whether to re-send/retry is left to
 * the LLM consumer — this function changes no state and makes no judgment
 * call itself.
 *
 * Known limitation (documented, not fixed — same class as errorPattern):
 * if the agent's OWN response body quotes one of these phrases (reviewing
 * error-handling code, or even a design doc discussing this very feature
 * and containing the literal string "API Error: 529"), this reports a
 * false `found:true`. Tail-scoping bounds how long a stale quote can
 * linger but cannot distinguish a quote from a live failure — `{match,
 * line}` is handed back precisely so the LLM consumer can judge from
 * context instead of this function guessing.
 */
export function detectRuntimeError(
  tail: string,
  pattern?: RegExp,
): { found: boolean; match?: string; line?: string } {
  const stripped = stripAnsi(tail);
  const source = pattern ?? DEFAULT_RUNTIME_ERROR_RE;
  // Strip a 'g' flag defensively: exec() on a global regex mutates
  // lastIndex across calls, which would make repeated calls with the same
  // caller-held RegExp object silently skip matches. This function is
  // stateless by contract, so it must not inherit that statefulness.
  const re = new RegExp(source.source, source.flags.replace(/g/g, ""));
  const match = re.exec(stripped);
  if (!match) return { found: false };
  const lines = stripped.split(/\r?\n/);
  const before = stripped.slice(0, match.index);
  const lineIndex = before.split(/\r?\n/).length - 1;
  return { found: true, match: match[0], line: (lines[lineIndex] ?? "").trim() };
}
