import {
  defaultBusyPattern,
  defaultErrorPattern,
  defaultReadyPattern,
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

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Last `n` lines of `s` (raw split on \n / \r\n), joined with \n. */
export function tailLines(s: string, n: number): string {
  if (n <= 0) return "";
  return s.split(/\r?\n/).slice(-n).join("\n");
}

export function makeMarkers(o: {
  agentId: string;
  turn: number;
  requestId?: string;
}): { begin: string; end: string } {
  const reqPart = o.requestId ? ` req=${o.requestId}` : "";
  return {
    begin: `<<<PMUX_BEGIN agent=${o.agentId} turn=${o.turn}${reqPart}>>>`,
    end: `<<<PMUX_END agent=${o.agentId} turn=${o.turn}${reqPart}>>>`,
  };
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
 * only counts when, after stripAnsi+trim, its line contains the marker and
 * NOTHING else — this excludes prompt-echo lines where the sentinel
 * instruction text ("...사이에만...") or both BEGIN+END sit on the same
 * line (design §4.5-1).
 */
export function extractMarkerBlock(o: {
  pane: string;
  agentId: string;
  turn: number;
  requestId?: string;
}): MarkerResult {
  const { begin, end } = makeMarkers(o);
  const lines = stripAnsi(o.pane).split(/\r?\n/);

  let openBeginIdx = -1;
  let completeContent: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === begin) {
      openBeginIdx = i;
    } else if (trimmed === end && openBeginIdx !== -1) {
      completeContent = lines.slice(openBeginIdx + 1, i).join("\n");
      openBeginIdx = -1;
    }
  }

  if (openBeginIdx !== -1) {
    return {
      status: "partial",
      contentSoFar: lines.slice(openBeginIdx + 1).join("\n"),
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
  | "launch_failed";

// Bash/zsh/root prompt returning after a launch command echo — the tell for
// a silent boot failure (design §2.2 "조용한 부팅 실패").
const SHELL_PROMPT_RE = /[$#%]\s*$/;

/**
 * Classification order (design v2 §4.2, Opus 턴4 B1 반영): ① errorPattern
 * → ② shell prompt returned (last non-blank line) → ③ busyPattern → ④
 * readyPattern → ⑤ agent_starting. error/busy/ready are ALL evaluated on
 * tail(15) only (unified in v2 — a full-pane errorPattern check caused a
 * permanent false "launch_failed" once a multi-turn session's response body
 * ever quoted an error string like "command not found"; restricting to the
 * tail lets that scroll out like everything else). Shell-prompt-return
 * still looks at the pane's last non-blank line (unaffected either way).
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
  const tail = tailLines(pane, 15);

  if (errorPattern.test(tail)) {
    return { state: "launch_failed", reason: "error pattern matched" };
  }

  const lines = pane.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? "";
  if (SHELL_PROMPT_RE.test(lastLine)) {
    return { state: "launch_failed", reason: "shell prompt returned" };
  }

  if (busyPattern.test(tail)) {
    return { state: "agent_busy", reason: "busy pattern matched" };
  }
  if (readyPattern.test(tail)) {
    return { state: "agent_ready", reason: "ready pattern matched" };
  }

  return { state: "agent_starting" };
}

/**
 * Single source of truth for the v2 `<<<PMUX_DONE ...>>>` completion signal
 * (design §3.1). `parseDoneSignal` matches against strings built by THIS
 * function (never a hand-rolled literal), and `makeFileFooter` (paths.ts)
 * builds its footer instruction by slicing this same string — so the
 * generator and the parser can never drift apart (턴4 리뷰 blocking: a
 * hand-copied literal in the footer had one more trailing '>' than the
 * parser expected, permanently blocking eofMarker's DONE-marker sibling).
 */
export function makeDoneMarker(o: {
  agentId: string;
  turn: number;
  requestId?: string;
  status: "complete" | "blocked";
}): string {
  const reqPart = o.requestId !== undefined ? ` req=${o.requestId}` : "";
  return `<<<PMUX_DONE agent=${o.agentId} turn=${o.turn}${reqPart} status=${o.status}>>>`;
}

/**
 * Detect the v2 single-line `<<<PMUX_DONE ...>>>` completion signal (design
 * §3.1). Only a line that, after stripAnsi+trim, matches the marker EXACTLY
 * (anchored, via string equality against `makeDoneMarker`'s output) counts —
 * this is the same echo-defense as extractMarkerBlock. The LAST matching
 * line wins. `requestId` is a gate: when given, the signal line must carry
 * that exact `req=` field; when omitted, only a signal with NO `req=` field
 * at all matches (the pane-block fallback path, which never emits req).
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

  let status: "complete" | "blocked" | undefined;
  for (const line of pane.split(/\r?\n/)) {
    const trimmed = line.trim();
    const hit = candidates.find((c) => c.marker === trimmed);
    if (hit) status = hit.status;
  }
  return status !== undefined ? { found: true, status } : { found: false };
}
