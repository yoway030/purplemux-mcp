import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { jsonResult } from "../tool-result.js";
import { classifyReadiness, parseDoneSignal, tailLines } from "../pane.js";
import { agentReportPath, readReportFile } from "../paths.js";
import { capturePane, resolveWorkspaceDir, tabStatus } from "./api.js";
import { validateId } from "./common.js";
import {
  compileAllPatterns,
  isShellCommand,
  nativeCliState,
  runtimeErrorInTail,
} from "./readiness.js";
import { reportFileStatus } from "./report.js";
import type { AgentStatusArgs } from "./types.js";

export async function runAgentStatus(args: AgentStatusArgs): Promise<CallToolResult> {
  validateId(args.agentId, "agentId");
  validateId(args.requestId, "requestId");
  const status = await tabStatus(args.workspaceId, args.tabId);
  const alive = status.alive;
  const pane = alive ? await capturePane(args.workspaceId, args.tabId) : "";
  const tail = tailLines(pane, 15);
  const { readyPattern, errorPattern, busyPattern, runtimeErrorPattern } =
    compileAllPatterns(args, args.provider);
  let signalSource: "cliState" | "pane" = "cliState";
  let readiness:
    | { state: string; reason?: string }
    | ReturnType<typeof classifyReadiness>;
  if (!alive) {
    readiness = { state: "exited", reason: "tab exited" };
  } else if (isShellCommand(status.command)) {
    readiness = {
      state: "shell_ready",
      reason: "foreground command is shell",
    };
  } else {
    const native = nativeCliState(args.provider, status.rawCliState);
    if (native !== null) {
      readiness = { state: native };
    } else {
      signalSource = "pane";
      readiness = classifyReadiness({
        pane,
        provider: args.provider,
        readyPattern,
        errorPattern,
        busyPattern,
      });
    }
  }

  let doneSignal: { found: boolean; status?: "complete" | "blocked" } = {
    found: false,
  };
  let reportFile:
    | {
        path: string;
        exists: boolean;
        statusLine?: "complete" | "blocked" | "invalid";
        reqMatch?: boolean;
        eofPresent?: boolean;
        bytes?: number;
      }
    | undefined;
  if (args.agentId !== undefined && args.turn !== undefined) {
    doneSignal = parseDoneSignal({
      pane,
      agentId: args.agentId,
      turn: args.turn,
      requestId: args.requestId,
    });
    const workspaceDir = await resolveWorkspaceDir(args.workspaceId);
    const path = agentReportPath(workspaceDir, args.agentId, args.turn);
    if (args.requestId !== undefined) {
      const check = await readReportFile(
        workspaceDir,
        args.agentId,
        args.turn,
        args.requestId,
      );
      reportFile = {
        path,
        ...(await reportFileStatus(check, path, args.requestId)),
      };
    } else {
      reportFile = { path, exists: false };
    }
  }

  return jsonResult({
    alive,
    readiness,
    signalSource,
    rawCliState: status.rawCliState,
    command: status.command,
    runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
    doneSignal,
    reportFile,
    tail,
  });
}
