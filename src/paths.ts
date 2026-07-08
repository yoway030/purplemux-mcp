import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { ToolError } from "./errors.js";
import { ID_RE } from "./profiles.js";
import { makeDoneMarker } from "./pane.js";

/**
 * Single source of truth for the report-file commit marker (design §3.2).
 * Both `readReportFile` (parser) and `makeFileFooter` (generator) build off
 * THIS function — never a hand-copied literal — so they can never drift
 * apart (턴4 리뷰 blocking: the footer's hand-written fragment had 4
 * trailing '>' where the parser expected 3, permanently blocking
 * eof_missing for any agent that followed the footer exactly).
 */
function eofMarker(requestId: string): string {
  return `<<<PMUX_EOF req=${requestId}>>>`;
}

/**
 * Assemble the fixed report-file path for an agent turn (design v2 §3.2).
 * Validates agentId (ID_RE) and turn (non-negative integer) so no
 * caller-controlled path fragment can ever traverse outside
 * `<workspaceDir>/.pmux-agents/`.
 */
export function agentReportPath(
  workspaceDir: string,
  agentId: string,
  turn: number,
): string {
  if (!ID_RE.test(agentId)) {
    throw new ToolError(
      `Invalid agentId "${agentId}": must match ${ID_RE.source}.`,
    );
  }
  if (!Number.isInteger(turn) || turn < 0) {
    throw new ToolError(
      `Invalid turn ${turn}: must be a non-negative integer.`,
    );
  }
  return join(workspaceDir, ".pmux-agents", agentId, `turn-${turn}.md`);
}

export type ReportFileCheck =
  | { state: "missing" }
  | { state: "invalid"; reason: "status_line" | "req_mismatch" | "eof_missing" }
  | { state: "valid"; status: "complete" | "blocked"; content: string; bytes: number };

const STATUS_LINE_RE = /^status=(complete|blocked) req=(\S+)$/;

/**
 * Read + validate the report file for one agent turn (design v2 §3.2/§4.5).
 * Isolation: resolves both `workspaceDir` and the target path via realpath
 * and refuses anything that escaped `workspaceDir` (symlink defense) — a
 * violation throws ToolError. A file that simply does not exist yet is NOT
 * a violation and resolves to `{ state:"missing" }` (§N3).
 *
 * Once read: line 1 must parse as `status=<s> req=<rid>` with `rid`
 * matching `requestId` (identity gate — blocks stale-session files), and
 * the LAST non-blank line must be the exact `<<<PMUX_EOF req=<rid>>>`
 * commit marker (blocks truncated mid-write reads and body text that
 * merely quotes an EOF marker). `content` is line 2 through the line
 * immediately before that EOF marker.
 */
export async function readReportFile(
  workspaceDir: string,
  agentId: string,
  turn: number,
  requestId: string,
): Promise<ReportFileCheck> {
  const path = agentReportPath(workspaceDir, agentId, turn);

  let realFile: string;
  try {
    realFile = await realpath(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    throw new ToolError(
      `Failed to stat report file at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let realWorkspace: string;
  try {
    realWorkspace = await realpath(workspaceDir);
  } catch (e) {
    throw new ToolError(
      `Failed to resolve workspaceDir ${workspaceDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (realFile !== realWorkspace && !realFile.startsWith(realWorkspace + sep)) {
    throw new ToolError(
      `Report file escapes workspaceDir (symlink?): ${path}`,
    );
  }

  const raw = await readFile(realFile);
  const lines = raw.toString("utf8").split(/\r?\n/);

  const statusMatch = STATUS_LINE_RE.exec((lines[0] ?? "").trim());
  if (!statusMatch) {
    return { state: "invalid", reason: "status_line" };
  }
  const status = statusMatch[1] as "complete" | "blocked";
  if (statusMatch[2] !== requestId) {
    return { state: "invalid", reason: "req_mismatch" };
  }

  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lines[lastIdx]?.trim() !== eofMarker(requestId)) {
    return { state: "invalid", reason: "eof_missing" };
  }

  return {
    state: "valid",
    status,
    content: lines.slice(1, lastIdx).join("\n"),
    bytes: raw.byteLength,
  };
}

// Common split point for both markers in the footer text below — never a
// hand-typed literal fragment past this point; both `rest` values are
// sliced off the single-source marker strings (eofMarker / makeDoneMarker).
// Exported for boot.ts, whose bootstrap-echo prompt uses the same
// split-string trick so the prompt (and its command-line echo) never
// contains a complete marker substring.
export const MARKER_PREFIX = "<<<PMUX_";

/**
 * Build the fileOutput=true footer (design v2 §3.4). Split into fragments
 * so the two completion markers ("<<<PMUX_EOF ...>>>" and
 * "<<<PMUX_DONE ...>>>") NEVER appear as one contiguous substring in the
 * instruction text itself — only the assembled marker the agent later
 * writes/prints is complete. This means a verbatim pane echo of this
 * footer can never be mistaken for a real signal (§3.4 / Codex 턴5). Both
 * fragments are sliced from `eofMarker`/`makeDoneMarker`'s own output
 * (single source — 턴4 리뷰 blocking fix) rather than retyped, so the
 * footer can never fall out of sync with what the parsers actually check.
 * The line-1 status instruction is also kept on its own line, separate from
 * the "blocked" alternative note, so an agent copying "line 1 verbatim"
 * can't accidentally drag the parenthetical into the parsed status line
 * (턴4 리뷰 비차단 — would fail STATUS_LINE_RE).
 */
export function makeFileFooter(o: {
  workspaceDir: string;
  agentId: string;
  turn: number;
  requestId: string;
}): string {
  const { agentId, turn, requestId } = o;
  const reportPath = agentReportPath(o.workspaceDir, agentId, turn);

  const eofRest = eofMarker(requestId).slice(MARKER_PREFIX.length);
  const doneRest = makeDoneMarker({
    agentId,
    turn,
    requestId,
    status: "complete",
  }).slice(MARKER_PREFIX.length);

  return [
    `[응답 규약] 응답을 모두 완성한 뒤 ${reportPath} 에 저장하세요.`,
    `- 1줄차: status=complete req=${requestId}`,
    `  (수행이 불가능한 경우에만 1줄차의 "complete"를 "blocked"로 바꾸세요. 다른 텍스트는 1줄차에 추가하지 마세요.)`,
    `- 2줄부터 본문. (가능하면 .tmp에 쓰고 rename)`,
    `- 마지막 줄: "${MARKER_PREFIX}" 뒤에 "${eofRest}" 를 이어붙인 한 줄`,
    `저장이 끝난 후 화면에는 "${MARKER_PREFIX}" 뒤에 "${doneRest}" 를 이어붙인 한 줄만 출력하세요.`,
  ].join("\n");
}
