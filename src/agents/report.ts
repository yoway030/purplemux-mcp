import { readFile } from "node:fs/promises";

import { makeMarkers } from "../pane.js";
import { MARKER_PREFIX, STATUS_LINE_RE, readReportFile } from "../paths.js";
import type { ReportFileStatus } from "./types.js";

export function buildPaneFallbackFooter(o: {
  agentId: string;
  turn: number;
  requestId?: string;
  maxResponseLines: number;
}): string {
  const { begin, end } = makeMarkers(o);
  const beginRest = begin.slice(MARKER_PREFIX.length);
  const endRest = end.slice(MARKER_PREFIX.length);
  return [
    `[응답 규약] 응답은 ${o.maxResponseLines}줄 이내로 작성하세요.`,
    `첫 줄에는 "${MARKER_PREFIX}" 뒤에 "${beginRest}" 를 이어붙인 한 줄만 출력하세요.`,
    "그 다음 줄부터 본문을 출력하세요.",
    `마지막 줄에는 "${MARKER_PREFIX}" 뒤에 "${endRest}" 를 이어붙인 한 줄만 출력하세요.`,
  ].join("\n");
}

async function readReportStatusLine(
  path: string,
  requestId: string,
): Promise<Pick<ReportFileStatus, "statusLine" | "reqMatch">> {
  let firstLine = "";
  try {
    const raw = await readFile(path, "utf8");
    firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  } catch {
    return {};
  }
  const match = STATUS_LINE_RE.exec(firstLine);
  if (!match) return { statusLine: "invalid" };
  return {
    statusLine: match[1] as "complete" | "blocked",
    reqMatch: match[2] === requestId,
  };
}

export async function reportFileStatus(
  check: Awaited<ReturnType<typeof readReportFile>>,
  path: string,
  requestId: string,
): Promise<ReportFileStatus> {
  if (check.state === "missing") {
    return { exists: false };
  }
  if (check.state === "valid") {
    return {
      exists: true,
      statusLine: check.status,
      reqMatch: true,
      eofPresent: true,
      bytes: check.bytes,
    };
  }
  const statusLine = await readReportStatusLine(path, requestId);
  if (check.reason === "status_line") {
    return {
      exists: true,
      statusLine: statusLine.statusLine ?? "invalid",
      reqMatch: statusLine.reqMatch,
    };
  }
  if (check.reason === "req_mismatch") {
    return {
      exists: true,
      statusLine: statusLine.statusLine,
      reqMatch: false,
    };
  }
  return {
    exists: true,
    statusLine: statusLine.statusLine,
    reqMatch: statusLine.reqMatch ?? true,
    eofPresent: false,
  };
}
