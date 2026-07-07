import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { callApi } from "./http.js";
import { ToolError } from "./errors.js";
import * as S from "./schemas.js";
import {
  ID_RE,
  MODEL_RE,
  buildAgentCommand,
  compileUserPattern,
  defaultBusyPattern,
  defaultErrorPattern,
  defaultReadyPattern,
  type Provider,
} from "./profiles.js";
import {
  classifyReadiness,
  extractMarkerBlock,
  makeMarkers,
  parseDoneSignal,
  stripAnsi,
  tailLines,
} from "./pane.js";
import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "./paths.js";

type AgentStartArgs = {
  workspaceId: string;
  name?: string;
  provider: Provider;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write";
  permissionMode?: "plan" | "manual" | "acceptEdits" | "dontAsk" | "auto";
  shellTimeoutMs?: number;
};

type AgentWaitReadyArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  timeoutMs?: number;
  pollMs?: number;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
};

type AgentSendArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  agentId: string;
  turn: number;
  prompt: string;
  requestId?: string;
  fileOutput?: boolean;
  maxResponseLines?: number;
  expectPrevTurnEnd?: number;
  skipReadyCheck?: boolean;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
};

type AgentCaptureArgs = {
  workspaceId: string;
  tabId: string;
  agentId: string;
  turn: number;
  requestId?: string;
};

type AgentStatusArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  agentId?: string;
  turn?: number;
  requestId?: string;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
};

interface TabCreateResult {
  tabId?: unknown;
  id?: unknown;
  sessionName?: unknown;
  tmuxSession?: unknown;
  agentSessionId?: unknown;
  claudeSessionId?: unknown;
}

interface TabStatusResult {
  alive?: unknown;
}

interface PaneResult {
  content?: unknown;
}

interface WorkspaceListResult {
  workspaces?: unknown;
}

interface WorkspaceInfo {
  id?: unknown;
  workspaceId?: unknown;
  directories?: unknown;
}

type ReportFileStatus = {
  exists: boolean;
  statusLine?: "complete" | "blocked" | "invalid";
  reqMatch?: boolean;
  eofPresent?: boolean;
  bytes?: number;
};

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  if (err instanceof ToolError) {
    const payload = { message: err.message, ...err.details };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ message }, null, 2) }],
  };
}

function guard<A>(
  fn: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capturePane(workspaceId: string, tabId: string): Promise<string> {
  const payload = await callApi<PaneResult | string>(
    "GET",
    `/api/cli/tabs/${encodeURIComponent(tabId)}/result`,
    { query: { workspaceId } },
  );
  if (typeof payload === "string") return payload;
  if (typeof payload.content === "string") return payload.content;
  throw new ToolError("Capture response did not include string content.", {
    details: { tabId },
  });
}

async function tabAlive(workspaceId: string, tabId: string): Promise<boolean> {
  const payload = await callApi<TabStatusResult>(
    "GET",
    `/api/cli/tabs/${encodeURIComponent(tabId)}/status`,
    { query: { workspaceId } },
  );
  return payload.alive === true;
}

async function resolveWorkspaceDir(workspaceId: string): Promise<string> {
  const payload = await callApi<WorkspaceListResult>(
    "GET",
    "/api/cli/workspaces",
  );
  const workspaces = Array.isArray(payload.workspaces)
    ? (payload.workspaces as WorkspaceInfo[])
    : [];
  const workspace = workspaces.find((w) => {
    const id = typeof w.id === "string" ? w.id : w.workspaceId;
    return id === workspaceId;
  });
  const dirs = workspace && Array.isArray(workspace.directories)
    ? workspace.directories
    : [];
  const firstDir = dirs.find((dir): dir is string => typeof dir === "string");
  if (!firstDir) {
    throw new ToolError(
      `Workspace ${workspaceId} has no directories[0]; cannot resolve agent report path.`,
      { details: { workspaceId } },
    );
  }
  return firstDir;
}

function validateId(value: string | undefined, field: string): void {
  if (value !== undefined && !ID_RE.test(value)) {
    throw new ToolError(`${field} must match ${ID_RE.source}.`, {
      details: { field, value },
    });
  }
}

function validateModel(model: string | undefined): void {
  if (model !== undefined && !MODEL_RE.test(model)) {
    throw new ToolError(`model must match ${MODEL_RE.source}.`, {
      details: { field: "model", value: model },
    });
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractTabId(payload: TabCreateResult): string {
  const tabId = asString(payload.tabId) ?? asString(payload.id);
  if (!tabId) {
    throw new ToolError("Create-tab response did not include a tabId.", {
      details: { response: payload },
    });
  }
  return tabId;
}

function sessionName(payload: TabCreateResult, tabId: string): string {
  return (
    asString(payload.sessionName) ??
    asString(payload.tmuxSession) ??
    asString(payload.agentSessionId) ??
    asString(payload.claudeSessionId) ??
    tabId
  );
}

function looksShellReady(pane: string): boolean {
  const lines = pane
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const recent = lines.slice(-8);
  return recent.some((line) => /(?:^|[~\w./:@-])(?:[$#%>]|❯)\s*$/.test(line));
}

async function waitForShellReady(o: {
  workspaceId: string;
  tabId: string;
  timeoutMs: number;
}): Promise<{ ready: true; pane: string } | { ready: false; pane: string }> {
  const started = Date.now();
  let lastPane = "";
  while (Date.now() - started <= o.timeoutMs) {
    try {
      lastPane = await capturePane(o.workspaceId, o.tabId);
      if (looksShellReady(lastPane)) {
        return { ready: true, pane: lastPane };
      }
    } catch (err) {
      if (!(err instanceof ToolError && err.status === 409)) {
        throw err;
      }
    }
    const remaining = o.timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(300, remaining));
  }
  return { ready: false, pane: lastPane };
}

function compileOptionalPattern(
  src: string | undefined,
  field: "readyPattern" | "errorPattern" | "busyPattern",
  fallback: RegExp,
): RegExp {
  return src === undefined ? fallback : compileUserPattern(src, field);
}

function hasPriorTurnEnd(pane: string, agentId: string, turn: number): boolean {
  const escapedAgent = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = new RegExp(
    `^<<<PMUX_END agent=${escapedAgent} turn=${turn}(?: req=[a-z0-9][a-z0-9_-]{0,31})?>>>$`,
  );
  return stripAnsi(pane)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => end.test(line));
}

function hasPriorDoneSignal(pane: string, agentId: string, turn: number): boolean {
  const escapedAgent = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const done = new RegExp(
    `^<<<PMUX_DONE agent=${escapedAgent} turn=${turn}(?: req=[a-z0-9][a-z0-9_-]{0,31})? status=(?:complete|blocked)>>>$`,
  );
  return stripAnsi(pane)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => done.test(line));
}

function hasPriorTurnCompletion(
  pane: string,
  agentId: string,
  turn: number,
): boolean {
  return hasPriorDoneSignal(pane, agentId, turn) || hasPriorTurnEnd(pane, agentId, turn);
}

function generateRequestId(): string {
  return randomBytes(6).toString("hex");
}

function recommendedFileOutput(args: AgentStartArgs): boolean {
  if (args.provider === "codex") {
    return (args.sandbox ?? "read-only") !== "read-only";
  }
  return (args.permissionMode ?? "plan") !== "plan";
}

function buildPaneFallbackFooter(o: {
  agentId: string;
  turn: number;
  requestId?: string;
  maxResponseLines: number;
}): string {
  const { begin, end } = makeMarkers(o);
  const beginRest = begin.slice("<<<PMUX_".length);
  const endRest = end.slice("<<<PMUX_".length);
  return [
    `[응답 규약] 응답은 ${o.maxResponseLines}줄 이내로 작성하세요.`,
    `첫 줄에는 "<<<PMUX_" 뒤에 "${beginRest}" 를 이어붙인 한 줄만 출력하세요.`,
    "그 다음 줄부터 본문을 출력하세요.",
    `마지막 줄에는 "<<<PMUX_" 뒤에 "${endRest}" 를 이어붙인 한 줄만 출력하세요.`,
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
  const match = /^status=(complete|blocked) req=(\S+)$/.exec(firstLine);
  if (!match) return { statusLine: "invalid" };
  return {
    statusLine: match[1] as "complete" | "blocked",
    reqMatch: match[2] === requestId,
  };
}

async function reportFileStatus(
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

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "pmux_agent_start",
    {
      description:
        "Create a terminal tab, poll briefly for shell readiness, then send an interactive agent CLI command. Returns recommendedFileOutput: false for read-only/plan agents that should be sent fileOutput:false. This is non-blocking: after a successful start return, use pmux_agent_wait_ready before sending work. wait_ready launch_failed is meaningful only after start has successfully sent the command; an idle shell before command send is indistinguishable to the stateless wait tool. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab. Codex command: codex --no-alt-screen -s <sandbox>; Claude permissionMode choices are based on claude 2.1.201 and intentionally exclude bypassPermissions.",
      inputSchema: S.agentStartShape,
    },
    guard(async (args: AgentStartArgs) => {
      validateModel(args.model);
      const { command, bootstrapHint } = buildAgentCommand(args);
      const fileOutputHint = recommendedFileOutput(args);
      // command is safe to return because all assembled inputs are allowlisted.
      // If future free-form command args are added, redact here before returning.
      const created = await callApi<TabCreateResult>("POST", "/api/cli/tabs", {
        body: {
          workspaceId: args.workspaceId,
          name: args.name,
          panelType: "terminal",
        },
      });
      const tabId = extractTabId(created);
      const shell = await waitForShellReady({
        workspaceId: args.workspaceId,
        tabId,
        timeoutMs: args.shellTimeoutMs ?? 5_000,
      });
      if (!shell.ready) {
        return jsonResult({
          state: "not_shell_ready",
          tabId,
          sessionName: sessionName(created, tabId),
          command,
          provider: args.provider,
          recommendedFileOutput: fileOutputHint,
          bootstrapHint,
          tail: tailLines(shell.pane, 15),
        });
      }
      await callApi("POST", `/api/cli/tabs/${encodeURIComponent(tabId)}/send`, {
        query: { workspaceId: args.workspaceId },
        body: { content: command },
      });
      return jsonResult({
        tabId,
        sessionName: sessionName(created, tabId),
        command,
        provider: args.provider,
        recommendedFileOutput: fileOutputHint,
        bootstrapHint,
      });
    }),
  );

  server.registerTool(
    "pmux_agent_wait_ready",
    {
      description:
        "Poll a tab until an agent is ready, still starting/busy, launch_failed, exited, or timeout. agent_busy is non-terminal and keeps polling. Uses pane capture + tab_status only; no server-side registry is kept. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab.",
      inputSchema: S.agentWaitReadyShape,
    },
    guard(async (args: AgentWaitReadyArgs) => {
      const started = Date.now();
      const timeoutMs = args.timeoutMs ?? 30_000;
      const pollMs = args.pollMs ?? 1_500;
      const readyPattern = compileOptionalPattern(
        args.readyPattern,
        "readyPattern",
        defaultReadyPattern(args.provider),
      );
      const errorPattern = compileOptionalPattern(
        args.errorPattern,
        "errorPattern",
        defaultErrorPattern(args.provider),
      );
      const busyPattern = compileOptionalPattern(
        args.busyPattern,
        "busyPattern",
        defaultBusyPattern(args.provider),
      );
      let polls = 0;
      let lastPane = "";

      while (Date.now() - started <= timeoutMs) {
        if (!(await tabAlive(args.workspaceId, args.tabId))) {
          return jsonResult({
            state: "exited",
            elapsedMs: Date.now() - started,
            polls,
            tail: tailLines(lastPane, 15),
          });
        }

        lastPane = await capturePane(args.workspaceId, args.tabId);
        polls += 1;
        const classified = classifyReadiness({
          pane: lastPane,
          provider: args.provider,
          readyPattern,
          errorPattern,
          busyPattern,
        });
        if (classified.state === "agent_ready") {
          return jsonResult({
            state: "agent_ready",
            elapsedMs: Date.now() - started,
            polls,
            tail: tailLines(lastPane, 15),
          });
        }
        if (classified.state === "launch_failed") {
          return jsonResult({
            state: "launch_failed",
            elapsedMs: Date.now() - started,
            polls,
            tail: tailLines(lastPane, 15),
          });
        }
        // agent_busy is a non-terminal readiness state for wait_ready.

        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
      }

      return jsonResult({
        state: "timeout",
        elapsedMs: Date.now() - started,
        polls,
        tail: tailLines(lastPane, 15),
      });
    }),
  );

  server.registerTool(
    "pmux_agent_send",
    {
      description:
        "Validate provider-specific readiness/busy/error state, optionally verify a previous DONE signal or END marker, append the v2.1 PMUX footer, and send the prompt. fileOutput defaults true: requestId is generated when omitted, workspaceDir is resolved from workspaces[].directories[0], and expectedReportFile is returned. Use fileOutput:false when pmux_agent_start returned recommendedFileOutput:false; read-only/plan agents cannot write report files. fileOutput=false uses the pane BEGIN/END fallback. agent_busy returns {sent:false, reason:\"busy\"}. Caller contract: if pmux_agent_capture returns partial/working, do not call pmux_agent_send again until the current turn completes or is explicitly abandoned.",
      inputSchema: S.agentSendShape,
    },
    guard(async (args: AgentSendArgs) => {
      validateId(args.agentId, "agentId");
      validateId(args.requestId, "requestId");
      const readyPattern = compileOptionalPattern(
        args.readyPattern,
        "readyPattern",
        defaultReadyPattern(args.provider),
      );
      const errorPattern = compileOptionalPattern(
        args.errorPattern,
        "errorPattern",
        defaultErrorPattern(args.provider),
      );
      const busyPattern = compileOptionalPattern(
        args.busyPattern,
        "busyPattern",
        defaultBusyPattern(args.provider),
      );
      const pane = await capturePane(args.workspaceId, args.tabId);
      const tail = tailLines(pane, 15);
      const classified = classifyReadiness({
        pane,
        provider: args.provider,
        readyPattern,
        errorPattern,
        busyPattern,
      });
      if (classified.state === "launch_failed") {
        return jsonResult({ sent: false, reason: "launch_failed", tail });
      }
      if (classified.state === "agent_busy") {
        return jsonResult({ sent: false, reason: "busy", tail });
      }
      if (!args.skipReadyCheck && classified.state !== "agent_ready") {
        return jsonResult({ sent: false, reason: "not_ready", tail });
      }
      if (
        args.expectPrevTurnEnd !== undefined &&
        !hasPriorTurnCompletion(pane, args.agentId, args.expectPrevTurnEnd)
      ) {
        return jsonResult({
          sent: false,
          reason: "missing_prev_turn_end",
          tail,
        });
      }

      const fileOutput = args.fileOutput ?? true;
      const requestId = fileOutput ? (args.requestId ?? generateRequestId()) : args.requestId;
      validateId(requestId, "requestId");
      let expectedReportFile: string | undefined;
      let footer: string;
      if (fileOutput) {
        if (requestId === undefined) {
          throw new ToolError("requestId generation failed.");
        }
        const workspaceDir = await resolveWorkspaceDir(args.workspaceId);
        expectedReportFile = agentReportPath(workspaceDir, args.agentId, args.turn);
        footer = makeFileFooter({
          workspaceDir,
          agentId: args.agentId,
          turn: args.turn,
          requestId,
        });
      } else {
        const maxResponseLines = args.maxResponseLines ?? 40;
        footer = buildPaneFallbackFooter({
          agentId: args.agentId,
          turn: args.turn,
          requestId,
          maxResponseLines,
        });
      }
      const content = `${args.prompt.trimEnd()}\n\n${footer}`;
      await callApi("POST", `/api/cli/tabs/${encodeURIComponent(args.tabId)}/send`, {
        query: { workspaceId: args.workspaceId },
        body: { content },
      });
      return jsonResult({
        sent: true,
        marker: {
          agentId: args.agentId,
          turn: args.turn,
          requestId,
        },
        expectedReportFile,
        validation: {
          ready: args.skipReadyCheck ? undefined : true,
          prevTurnEnd: args.expectPrevTurnEnd === undefined ? undefined : true,
        },
      });
    }),
  );

  server.registerTool(
    "pmux_agent_capture",
    {
      description:
        "Recover a v2.1 agent response. If requestId is supplied, first read the report file at workspaceDir/.pmux-agents/<agentId>/turn-<n>.md and require matching status line plus EOF marker. Without requestId, file recovery is skipped and pane BEGIN/END fallback is used. Returns structured complete/blocked/working/inconsistent/partial/missing results; partial/working means do not send the next turn yet.",
      inputSchema: S.agentCaptureShape,
    },
    guard(async (args: AgentCaptureArgs) => {
      validateId(args.agentId, "agentId");
      validateId(args.requestId, "requestId");
      const pane = await capturePane(args.workspaceId, args.tabId);
      const tail = tailLines(pane, 15);
      const doneSignal = parseDoneSignal({
        pane,
        agentId: args.agentId,
        turn: args.turn,
        requestId: args.requestId,
      });

      if (args.requestId !== undefined) {
        const workspaceDir = await resolveWorkspaceDir(args.workspaceId);
        const file = await readReportFile(
          workspaceDir,
          args.agentId,
          args.turn,
          args.requestId,
        );
        if (file.state === "valid") {
          return jsonResult({
            status: file.status,
            content: file.content,
            source: "file",
            doneSignal: doneSignal.found,
          });
        }
        if (file.state === "invalid") {
          return jsonResult({
            status: "working",
            reason:
              file.reason === "req_mismatch"
                ? "stale_file_req_mismatch"
                : "file_invalid_or_midwrite",
            tail,
          });
        }
        if (doneSignal.found) {
          return jsonResult({ status: "inconsistent", tail });
        }
      }

      const result = extractMarkerBlock({
        pane,
        agentId: args.agentId,
        turn: args.turn,
        requestId: args.requestId,
      });
      if (result.status === "complete") {
        return jsonResult({ ...result, source: "pane" });
      }
      if (result.status === "partial") {
        return jsonResult({
          status: "partial",
          contentSoFar: result.contentSoFar,
          tail,
        });
      }
      const busy = classifyReadiness({
        pane,
        provider: "codex",
        busyPattern: defaultBusyPattern("codex"),
        readyPattern: /$a/,
        errorPattern: /$a/,
      });
      if (busy.state === "agent_busy") {
        return jsonResult({ status: "working", tail });
      }
      return jsonResult({
        status: "missing",
        tail,
      });
    }),
  );

  server.registerTool(
    "pmux_agent_status",
    {
      description:
        "Return a no-wait v2.1 status snapshot: tab alive, provider-specific readiness, optional DONE signal for agentId/turn/requestId, optional report-file check, and pane tail. No server-side state is kept.",
      inputSchema: S.agentStatusShape,
    },
    guard(async (args: AgentStatusArgs) => {
      validateId(args.agentId, "agentId");
      validateId(args.requestId, "requestId");
      const alive = await tabAlive(args.workspaceId, args.tabId);
      const pane = alive ? await capturePane(args.workspaceId, args.tabId) : "";
      const tail = tailLines(pane, 15);
      const readyPattern = compileOptionalPattern(
        args.readyPattern,
        "readyPattern",
        defaultReadyPattern(args.provider),
      );
      const errorPattern = compileOptionalPattern(
        args.errorPattern,
        "errorPattern",
        defaultErrorPattern(args.provider),
      );
      const busyPattern = compileOptionalPattern(
        args.busyPattern,
        "busyPattern",
        defaultBusyPattern(args.provider),
      );
      const readiness = alive
        ? classifyReadiness({
            pane,
            provider: args.provider,
            readyPattern,
            errorPattern,
            busyPattern,
          })
        : { state: "launch_failed" as const, reason: "tab exited" };

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
        doneSignal,
        reportFile,
        tail,
      });
    }),
  );
}
