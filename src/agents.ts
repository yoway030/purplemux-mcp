import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { callApi } from "./http.js";
import { ToolError } from "./errors.js";
import { guard, jsonResult } from "./tool-result.js";
import * as S from "./schemas.js";
import {
  ID_RE,
  MODEL_RE,
  SHELL_NAMES,
  buildAgentCommand,
  compileUserPattern,
  defaultBusyPattern,
  defaultErrorPattern,
  defaultReadyPattern,
  mapCliState,
  type Provider,
} from "./profiles.js";
import {
  classifyReadiness,
  detectRuntimeError,
  extractMarkerBlock,
  hasPriorTurnCompletion,
  makeMarkers,
  parseDoneSignal,
  tailLines,
} from "./pane.js";
import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "./paths.js";
import {
  BOOTSTRAP_ECHO_AGENT_ID,
  BOOTSTRAP_ECHO_TURN,
  bootFilePath,
  bootFileSeen,
  buildBootstrapEchoPrompt,
  codexHookConfigs,
  ensureBootHookScript,
  pruneBootArtifacts,
  writeClaudeBootSettings,
  type SettingsMerge,
} from "./boot.js";

type AgentStartArgs = {
  workspaceId: string;
  name?: string;
  provider: Provider;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write";
  permissionMode?: "plan" | "manual" | "acceptEdits" | "dontAsk" | "auto";
  shellTimeoutMs?: number;
  bootstrapEcho?: boolean;
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
  runtimeErrorPattern?: string;
  requireBusyTransition?: boolean;
  bootId?: string;
  expectEcho?: boolean;
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
  expectPrevRequestId?: string;
  skipReadyCheck?: boolean;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
  runtimeErrorPattern?: string;
};

type AgentCaptureArgs = {
  workspaceId: string;
  tabId: string;
  agentId: string;
  turn: number;
  requestId?: string;
};

type AgentTurnArgs = AgentSendArgs & {
  pollTimeoutMs?: number;
  pollMs?: number;
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
  runtimeErrorPattern?: string;
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
  cliState?: unknown;
  command?: unknown;
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

type RuntimeErrorInfo = { match: string; line: string };

type MarkerInfo = {
  agentId: string;
  turn: number;
  requestId?: string;
};

type AgentSendValue =
  | {
      sent: true;
      marker: MarkerInfo;
      expectedReportFile?: string;
      validation: {
        ready?: boolean;
        prevTurnEnd?: boolean;
        warning?: string;
      };
      signalSource: "cliState" | "pane";
      rawCliState: string | null;
      command: string | null;
      runtimeError?: RuntimeErrorInfo;
    }
  | {
      sent: false;
      reason:
        | "launch_failed"
        | "busy"
        | "blocked"
        | "not_ready"
        | "missing_prev_turn_end";
      signalSource: "cliState" | "pane";
      rawCliState: string | null;
      command: string | null;
      tail: string;
      readinessState?: string;
      readinessReason?: string;
      runtimeError?: RuntimeErrorInfo;
    };

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

type NativeState =
  | "agent_ready"
  | "agent_busy"
  | "agent_starting"
  | "agent_blocked"
  | "launch_failed";

type TabStatusSnapshot = {
  alive: boolean;
  rawCliState: string | null;
  command: string | null;
};

async function tabStatus(
  workspaceId: string,
  tabId: string,
): Promise<TabStatusSnapshot> {
  const payload = await callApi<TabStatusResult>(
    "GET",
    `/api/cli/tabs/${encodeURIComponent(tabId)}/status`,
    { query: { workspaceId } },
  );
  return {
    alive: payload.alive === true,
    rawCliState:
      typeof payload.cliState === "string" && payload.cliState.length > 0
        ? payload.cliState
        : null,
    command:
      typeof payload.command === "string" && payload.command.length > 0
        ? payload.command
        : null,
  };
}

async function tabAlive(workspaceId: string, tabId: string): Promise<boolean> {
  return (await tabStatus(workspaceId, tabId)).alive;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wire app hooks AND the boot-signal SessionStart hook (design 2026-07-08).
 * `hooksWired` keeps its original meaning (purplemux app status hooks);
 * `bootWired` reports the boot-signal wiring separately. Boot wiring
 * degrades gracefully: any fs failure falls back to the legacy app-hook-only
 * command with bootWired:false rather than failing the start. NOTE (codex
 * hook trust): a wired-but-never-seen boot file can be a NORMAL state if the
 * CLI's hook trust layer holds the new script — fileSeen is diagnostic only.
 */
async function wireHooksAndBoot(
  args: AgentStartArgs,
  command: string,
  bootId: string,
): Promise<{
  command: string;
  hooksWired: boolean;
  bootWired: boolean;
  settingsMerge?: SettingsMerge;
}> {
  const home = homedir();
  let bootHookPath: string | undefined;
  try {
    bootHookPath = await ensureBootHookScript();
  } catch {
    bootHookPath = undefined;
  }

  if (args.provider === "claude") {
    if (bootHookPath !== undefined) {
      try {
        const s = await writeClaudeBootSettings(bootId, bootHookPath);
        return {
          command: `${command} --settings ${shellQuote(s.path)}`,
          hooksWired: s.appHooksWired,
          bootWired: true,
          settingsMerge: s.settingsMerge,
        };
      } catch {
        // fall through to legacy app-hook-only wiring
      }
    }
    const settingsPath = `${home}/.purplemux/hooks.json`;
    if (!existsSync(settingsPath)) {
      return { command, hooksWired: false, bootWired: false };
    }
    return {
      command: `${command} --settings ${shellQuote(settingsPath)}`,
      hooksWired: true,
      bootWired: false,
    };
  }

  const appHook = `${home}/.purplemux/codex-hook.sh`;
  const appHookPath = existsSync(appHook) ? appHook : undefined;
  let configs: string[];
  try {
    configs = codexHookConfigs({ appHookPath, bootHookPath });
  } catch {
    // unsafe hook path (allowlist violation) — degrade instead of
    // assembling a shell-expandable hook command.
    return { command, hooksWired: false, bootWired: false };
  }
  if (configs.length === 0) {
    return { command, hooksWired: false, bootWired: false };
  }
  const hookArgs = configs.map((config) => `-c ${shellQuote(config)}`);
  return {
    command: `${command} ${hookArgs.join(" ")}`,
    hooksWired: appHookPath !== undefined,
    bootWired: bootHookPath !== undefined,
  };
}

function isShellCommand(command: string | null): boolean {
  if (command === null) return false;
  const names = SHELL_NAMES as unknown as {
    has?: (value: string) => boolean;
    includes?: (value: string) => boolean;
  };
  return names.has?.(command) ?? names.includes?.(command) ?? false;
}

function nativeCliState(
  provider: Provider,
  rawCliState: string | null,
): NativeState | null {
  if (rawCliState === null) return null;
  return mapCliState(provider, rawCliState) as NativeState | null;
}

function runtimeErrorInTail(
  tail: string,
  pattern?: RegExp,
): RuntimeErrorInfo | undefined {
  const detected = detectRuntimeError(tail, pattern) as {
    found: boolean;
    match?: string;
    line?: string;
  };
  if (!detected.found || detected.match === undefined) return undefined;
  return { match: detected.match, line: detected.line ?? detected.match };
}

function withRuntimeError<const T extends Record<string, unknown>>(
  value: T,
  tail: string,
  pattern?: RegExp,
): T & { runtimeError?: RuntimeErrorInfo } {
  const runtimeError = runtimeErrorInTail(tail, pattern);
  return runtimeError === undefined ? value : { ...value, runtimeError };
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

function compileRuntimeErrorPattern(src: string | undefined): RegExp | undefined {
  return src === undefined
    ? undefined
    : compileUserPattern(src, "runtimeErrorPattern");
}

type CompiledPatterns = {
  readyPattern: RegExp;
  errorPattern: RegExp;
  busyPattern: RegExp;
  runtimeErrorPattern: RegExp | undefined;
};

/** Compile the four user-overridable patterns against provider defaults. */
export function compileAllPatterns(
  args: {
    readyPattern?: string;
    errorPattern?: string;
    busyPattern?: string;
    runtimeErrorPattern?: string;
  },
  provider: Provider,
): CompiledPatterns {
  return {
    readyPattern: compileOptionalPattern(
      args.readyPattern,
      "readyPattern",
      defaultReadyPattern(provider),
    ),
    errorPattern: compileOptionalPattern(
      args.errorPattern,
      "errorPattern",
      defaultErrorPattern(provider),
    ),
    busyPattern: compileOptionalPattern(
      args.busyPattern,
      "busyPattern",
      defaultBusyPattern(provider),
    ),
    runtimeErrorPattern: compileRuntimeErrorPattern(args.runtimeErrorPattern),
  };
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

async function sendAgentPrompt(args: AgentSendArgs): Promise<AgentSendValue> {
  validateId(args.agentId, "agentId");
  validateId(args.requestId, "requestId");
  validateId(args.expectPrevRequestId, "expectPrevRequestId");
  const { readyPattern, errorPattern, busyPattern, runtimeErrorPattern } =
    compileAllPatterns(args, args.provider);
  const status = await tabStatus(args.workspaceId, args.tabId);
  if (!status.alive) {
    return {
      sent: false,
      reason: "launch_failed",
      signalSource: "cliState",
      rawCliState: status.rawCliState,
      command: status.command,
      tail: "",
    };
  }
  const pane = await capturePane(args.workspaceId, args.tabId);
  const tail = tailLines(pane, 15);

  if (isShellCommand(status.command)) {
    return withRuntimeError(
      {
        sent: false,
        reason: "launch_failed",
        signalSource: "cliState",
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
        readinessState: "agent_busy",
      },
      tail,
      runtimeErrorPattern,
    );
  }

  const native = nativeCliState(args.provider, status.rawCliState);
  let signalSource: "cliState" | "pane" = native === null ? "pane" : "cliState";
  let ready = native === "agent_ready";
  let validationWarning: string | undefined;
  let readinessState: string | undefined = native ?? undefined;
  let readinessReason: string | undefined;
  if (native === "launch_failed") {
    return withRuntimeError(
      {
        sent: false,
        reason: "launch_failed",
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
      },
      tail,
      runtimeErrorPattern,
    );
  }
  if (native === "agent_busy") {
    return withRuntimeError(
      {
        sent: false,
        reason: "busy",
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
      },
      tail,
      runtimeErrorPattern,
    );
  }
  if (native === "agent_blocked") {
    return withRuntimeError(
      {
        sent: false,
        reason: "blocked",
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
      },
      tail,
      runtimeErrorPattern,
    );
  }

  if (native !== "agent_ready") {
    const classified = classifyReadiness({
      pane,
      provider: args.provider,
      readyPattern,
      errorPattern,
      busyPattern,
    });
    signalSource = "pane";
    ready = classified.state === "agent_ready";
    readinessState = classified.state;
    readinessReason = classified.reason;
    if (classified.state === "launch_failed") {
      return withRuntimeError(
        {
          sent: false,
          reason: "launch_failed",
          signalSource,
          rawCliState: status.rawCliState,
          command: status.command,
          tail,
          readinessState: "agent_busy",
        },
        tail,
        runtimeErrorPattern,
      );
    }
    if (classified.state === "agent_busy") {
      return withRuntimeError(
        {
          sent: false,
          reason: "busy",
          signalSource,
          rawCliState: status.rawCliState,
          command: status.command,
          tail,
        },
        tail,
        runtimeErrorPattern,
      );
    }
    if ((classified.state as string) === "agent_blocked") {
      return withRuntimeError(
        {
          sent: false,
          reason: "blocked",
          signalSource,
          rawCliState: status.rawCliState,
          command: status.command,
          tail,
        },
        tail,
        runtimeErrorPattern,
      );
    }
    if (
      classified.state === "agent_starting" &&
      classified.reason === "input_queued" &&
      args.turn <= 1
    ) {
      ready = true;
      validationWarning = "composer_placeholder_assumed";
    }
  }
  if (!args.skipReadyCheck && !ready) {
    return withRuntimeError(
      {
        sent: false,
        reason: "not_ready",
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
        readinessState,
        readinessReason,
      },
      tail,
      runtimeErrorPattern,
    );
  }
  if (
    args.expectPrevTurnEnd !== undefined &&
    !hasPriorTurnCompletion({
      pane,
      agentId: args.agentId,
      turn: args.expectPrevTurnEnd,
      requestId: args.expectPrevRequestId,
    })
  ) {
    return withRuntimeError(
      {
        sent: false,
        reason: "missing_prev_turn_end",
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        tail,
      },
      tail,
      runtimeErrorPattern,
    );
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
  return {
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
      warning: validationWarning,
    },
    signalSource,
    rawCliState: status.rawCliState,
    command: status.command,
    ...(runtimeErrorInTail(tail, runtimeErrorPattern) === undefined
      ? {}
      : { runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern) }),
  };
}

type CaptureEvidence =
  | {
      status: "complete" | "blocked";
      content: string;
      source: "file" | "pane";
      doneSignal?: boolean;
      tail: string;
    }
  | {
      status: "working" | "partial" | "inconsistent" | "missing";
      reason?: string;
      contentSoFar?: string;
      tail: string;
    };

async function captureAgentEvidence(args: AgentCaptureArgs): Promise<CaptureEvidence> {
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
      return {
        status: file.status,
        content: file.content,
        source: "file",
        doneSignal: doneSignal.found,
        tail,
      };
    }
    if (file.state === "invalid") {
      return {
        status: "working",
        reason:
          file.reason === "req_mismatch"
            ? "stale_file_req_mismatch"
            : "file_invalid_or_midwrite",
        tail,
      };
    }
    if (doneSignal.found) {
      return { status: "inconsistent", tail };
    }
  }

  const result = extractMarkerBlock({
    pane,
    agentId: args.agentId,
    turn: args.turn,
    requestId: args.requestId,
  });
  if (result.status === "complete") {
    return { ...result, source: "pane", tail };
  }
  if (result.status === "partial") {
    return {
      status: "partial",
      contentSoFar: result.contentSoFar,
      tail,
    };
  }
  const busy = classifyReadiness({
    pane,
    provider: "codex",
    busyPattern: defaultBusyPattern("codex"),
    readyPattern: /$a/,
    errorPattern: /$a/,
  });
  if (busy.state === "agent_busy") {
    return { status: "working", tail };
  }
  return { status: "missing", tail };
}

function isReadyStateForTurn(state: NativeState | ReturnType<typeof classifyReadiness>["state"] | null): boolean {
  return state === "agent_ready";
}

async function classifyTurnReadiness(o: {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  pane: string;
  readyPattern: RegExp;
  errorPattern: RegExp;
  busyPattern: RegExp;
}): Promise<{
  ready: boolean;
  state: string | null;
  rawCliState: string | null;
  command: string | null;
}> {
  const status = await tabStatus(o.workspaceId, o.tabId);
  if (!status.alive || isShellCommand(status.command)) {
    return {
      ready: false,
      state: status.alive ? "launch_failed" : "exited",
      rawCliState: status.rawCliState,
      command: status.command,
    };
  }
  const native = nativeCliState(o.provider, status.rawCliState);
  if (native !== null) {
    return {
      ready: isReadyStateForTurn(native),
      state: native,
      rawCliState: status.rawCliState,
      command: status.command,
    };
  }
  const classified = classifyReadiness({
    pane: o.pane,
    provider: o.provider,
    readyPattern: o.readyPattern,
    errorPattern: o.errorPattern,
    busyPattern: o.busyPattern,
  });
  return {
    ready: isReadyStateForTurn(classified.state),
    state: classified.state,
    rawCliState: status.rawCliState,
    command: status.command,
  };
}

async function runAgentTurn(args: AgentTurnArgs): Promise<Record<string, unknown>> {
  const started = Date.now();
  const timeoutMs = args.pollTimeoutMs ?? 120_000;
  const pollMs = args.pollMs ?? 2_000;
  let sendAttempts = 0;
  let lastSendFailure: AgentSendValue | undefined;

  let sent: Extract<AgentSendValue, { sent: true }> | undefined;
  while (Date.now() - started <= timeoutMs) {
    sendAttempts += 1;
    const candidate = await sendAgentPrompt(args);
    if (candidate.sent) {
      sent = candidate;
      break;
    }
    lastSendFailure = candidate;
    const retryable =
      candidate.reason === "busy" ||
      (candidate.reason === "not_ready" &&
        candidate.readinessState === "agent_starting" &&
        candidate.readinessReason !== "input_queued");
    if (!retryable) {
      return { status: "send_failed", ...candidate, phase: "pre_send", sendAttempts };
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  if (sent === undefined) {
    return {
      status: "timeout",
      phase: "pre_send",
      sendAttempts,
      elapsedMs: Date.now() - started,
      ...(lastSendFailure ?? {}),
    };
  }

  const marker = sent.marker;
  // Compiled only after the send loop on purpose: an invalid user pattern
  // already threw the identical ToolError inside sendAgentPrompt on the
  // first loop iteration, so hoisting this earlier would not change the
  // observable behavior — but keeping it here preserves the original flow.
  const { readyPattern, errorPattern, busyPattern, runtimeErrorPattern } =
    compileAllPatterns(args, args.provider);
  let attempts = 0;
  let lastTail = "";
  let lastRawCliState: string | null = sent.rawCliState;
  let lastCommand: string | null = sent.command;

  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const evidence = await captureAgentEvidence({
      workspaceId: args.workspaceId,
      tabId: args.tabId,
      agentId: marker.agentId,
      turn: marker.turn,
      requestId: marker.requestId,
    });
    lastTail = evidence.tail;
    if (evidence.status === "complete" || evidence.status === "blocked") {
      return {
        status: evidence.status,
        content: evidence.content,
        source: evidence.source,
        marker,
        attempts,
        sendAttempts,
        elapsedMs: Date.now() - started,
      };
    }

    const pane = await capturePane(args.workspaceId, args.tabId);
    lastTail = tailLines(pane, 15);
    const readiness = await classifyTurnReadiness({
      workspaceId: args.workspaceId,
      tabId: args.tabId,
      provider: args.provider,
      pane,
      readyPattern,
      errorPattern,
      busyPattern,
    });
    lastRawCliState = readiness.rawCliState;
    lastCommand = readiness.command;
    if (readiness.state === "agent_blocked") {
      return {
        status: "blocked_state",
        rawCliState: readiness.rawCliState,
        command: readiness.command,
        marker,
        tail: lastTail,
        attempts,
        sendAttempts,
        elapsedMs: Date.now() - started,
      };
    }
    const runtimeError = runtimeErrorInTail(lastTail, runtimeErrorPattern);
    if (readiness.ready && runtimeError !== undefined) {
      return {
        status: "agent_error",
        runtimeError,
        marker,
        tail: lastTail,
        attempts,
        sendAttempts,
        elapsedMs: Date.now() - started,
      };
    }

    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  return {
    status: "timeout",
    phase: "awaiting_completion",
    marker,
    expectedReportFile: sent.expectedReportFile,
    attempts,
    sendAttempts,
    elapsedMs: Date.now() - started,
    rawCliState: lastRawCliState,
    command: lastCommand,
    tail: lastTail,
  };
}

async function runWaitReady(args: AgentWaitReadyArgs): Promise<CallToolResult> {
  const started = Date.now();
  const expectEcho = args.expectEcho ?? false;
  if (expectEcho && args.bootId === undefined) {
    throw new ToolError(
      "expectEcho requires bootId (returned by pmux_agent_start).",
    );
  }
  // echo completion includes a model turn — 30s is too tight for a cold
  // boot + first inference, so the default widens (합의 항목 2).
  const timeoutMs = args.timeoutMs ?? (expectEcho ? 90_000 : 30_000);
  const pollMs = args.pollMs ?? 1_500;
  const requireBusyTransition = args.requireBusyTransition ?? false;
  const bootFile =
    args.bootId !== undefined ? bootFilePath(args.bootId) : undefined;
  let fileSeen = false;
  let echoSeen = false;
  // Diagnostic only — fileSeen never feeds readiness (진단 전용, 합의
  // 항목 3). On an expectEcho timeout it gives the 2-bit diagnosis:
  // fileSeen:false → launch/hook problem; fileSeen:true without echo →
  // prompt not submitted / model auth / hang.
  const bootInfo = () =>
    args.bootId === undefined
      ? {}
      : {
          boot: {
            bootId: args.bootId,
            fileSeen,
            ...(expectEcho ? { echoSeen } : {}),
          },
        };
  const { readyPattern, errorPattern, busyPattern, runtimeErrorPattern } =
    compileAllPatterns(args, args.provider);
  let polls = 0;
  let lastPane = "";
  let lastRawCliState: string | null = null;
  let lastCommand: string | null = null;
  let lastSignalSource: "cliState" | "pane" = "pane";
  let transitionSeen = false;
  let baseline:
    | {
        source: "cliState" | "pane";
        state: string;
        reason?: string;
        rawCliState: string | null;
      }
    | undefined;

  while (Date.now() - started <= timeoutMs) {
    const status = await tabStatus(args.workspaceId, args.tabId);
    lastRawCliState = status.rawCliState;
    lastCommand = status.command;
    if (bootFile !== undefined && !fileSeen) fileSeen = bootFileSeen(args.bootId as string);
    if (!status.alive) {
      const tail = tailLines(lastPane, 15);
      return jsonResult({
        state: "exited",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "cliState",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }

    lastPane = await capturePane(args.workspaceId, args.tabId);
    polls += 1;
    const tail = tailLines(lastPane, 15);

    if (isShellCommand(status.command)) {
      return jsonResult({
        state: "launch_failed",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "cliState",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }

    if (expectEcho && !echoSeen && args.bootId !== undefined) {
      const echo = parseDoneSignal({
        pane: lastPane,
        agentId: BOOTSTRAP_ECHO_AGENT_ID,
        turn: BOOTSTRAP_ECHO_TURN,
        requestId: args.bootId,
      });
      if (echo.found && echo.status === "blocked") {
        // The marker WAS seen — reflect that in boot.echoSeen so the
        // diagnosis reads "echo arrived but reported blocked", not
        // "echo never arrived" (codex 리뷰 NIT).
        echoSeen = true;
        return jsonResult({
          state: "agent_blocked",
          reason: "bootstrap_echo_blocked",
          elapsedMs: Date.now() - started,
          polls,
          signalSource: "pane",
          rawCliState: status.rawCliState,
          command: status.command,
          runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
          ...bootInfo(),
          tail,
        });
      }
      if (echo.found) {
        // Completion evidence — supersedes ready-pattern heuristics,
        // requireBusyTransition bookkeeping AND a matched runtimeError
        // (which is still reported alongside), same precedence the turn
        // tool already uses (합의 항목 2).
        echoSeen = true;
        return jsonResult({
          state: "agent_ready",
          reason: "bootstrap_echo",
          elapsedMs: Date.now() - started,
          polls,
          signalSource: "pane",
          rawCliState: status.rawCliState,
          command: status.command,
          runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
          ...bootInfo(),
          tail,
        });
      }
    }

    const rawNative = nativeCliState(args.provider, status.rawCliState);
    // Single echo gate (opus 리뷰 항목 3): before the echo marker is
    // seen, NO ready path may fire — native needs-input can be the
    // pre-submit window right before the CLI auto-submits the
    // bootstrap prompt (실측: that window polluted the
    // requireBusyTransition baseline and hung it). Demote to
    // agent_starting so every ready branch below keeps polling.
    const native =
      expectEcho && !echoSeen && rawNative === "agent_ready"
        ? "agent_starting"
        : rawNative;
    if (native === "agent_busy") {
      transitionSeen = true;
      lastSignalSource = "cliState";
    } else if (native === "agent_blocked") {
      return jsonResult({
        state: "agent_blocked",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "cliState",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    } else if (native === "launch_failed") {
      return jsonResult({
        state: "launch_failed",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "cliState",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    } else if (native === "agent_ready") {
      if (
        requireBusyTransition &&
        baseline !== undefined &&
        baseline.state !== "agent_ready"
      ) {
        transitionSeen = true;
      }
      if (!requireBusyTransition || transitionSeen) {
        return jsonResult({
          state: "agent_ready",
          elapsedMs: Date.now() - started,
          polls,
          signalSource: "cliState",
          rawCliState: status.rawCliState,
          command: status.command,
          runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
          ...bootInfo(),
          tail,
        });
      }
    }
    if (
      native === "agent_busy" ||
      native === "agent_starting" ||
      (native === "agent_ready" && requireBusyTransition && !transitionSeen)
    ) {
      if (baseline === undefined) {
        baseline = {
          source: "cliState",
          state: native,
          rawCliState: status.rawCliState,
        };
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
      continue;
    }

    const classified = classifyReadiness({
      pane: lastPane,
      provider: args.provider,
      readyPattern,
      errorPattern,
      busyPattern,
    });
    // Same echo gate as the native path — a pane-classified ready (bare
    // composer / frame signature) before the echo marker is only the
    // pre-submit window, not evidence.
    const classifiedState =
      expectEcho && !echoSeen && classified.state === "agent_ready"
        ? "agent_starting"
        : classified.state;
    if (baseline === undefined) {
      baseline = {
        source: "pane",
        state: classifiedState,
        reason: classified.reason,
        rawCliState: status.rawCliState,
      };
    } else if (
      requireBusyTransition &&
      classifiedState === "agent_ready" &&
      baseline.state !== "agent_ready"
    ) {
      transitionSeen = true;
    }
    if (classifiedState === "agent_ready") {
      if (requireBusyTransition && !transitionSeen) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
        continue;
      }
      return jsonResult({
        state: "agent_ready",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "pane",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }
    if (classifiedState === "agent_blocked") {
      // pane-side approval-dialog detection (claude plan/permission
      // prompts) — parallel to the native agent_blocked branch, needed
      // since claude ready-for-review no longer maps to blocked.
      return jsonResult({
        state: "agent_blocked",
        reason: classified.reason,
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "pane",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }
    if (
      !expectEcho &&
      !requireBusyTransition &&
      classifiedState === "agent_starting" &&
      classified.reason === "input_queued"
    ) {
      // Under expectEcho the queued composer content is (or contains)
      // our own bootstrap prompt awaiting auto-submit — promoting it to
      // ready would defeat the echo gate, so the promotion is disabled.
      return jsonResult({
        state: "agent_ready",
        reason: "composer_placeholder_assumed",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "pane",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }
    if (classifiedState === "launch_failed") {
      return jsonResult({
        state: "launch_failed",
        elapsedMs: Date.now() - started,
        polls,
        signalSource: "pane",
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    }
    lastSignalSource = "pane";
    if (classifiedState === "agent_busy") {
      transitionSeen = true;
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
    signalSource: lastSignalSource,
    rawCliState: lastRawCliState,
    command: lastCommand,
    baseline,
    transitionSeen,
    runtimeError: runtimeErrorInTail(tailLines(lastPane, 15), runtimeErrorPattern),
    ...bootInfo(),
    tail: tailLines(lastPane, 15),
  });
}

async function runAgentStatus(args: AgentStatusArgs): Promise<CallToolResult> {
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

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "pmux_agent_start",
    {
      description:
        "Primary agent orchestration tool: create a terminal tab, poll briefly for shell readiness, then send an interactive agent CLI command. ORCHESTRATOR CONTRACT: before launching, ask the user which model/effort (and codex sandbox / claude permissionMode) each subagent should use, unless the user already specified them. Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. Returns recommendedFileOutput: false for read-only/plan agents that should be sent fileOutput:false. Boot verification: returns bootId — by default (bootstrapEcho:true) the CLI is launched with a fixed initial prompt that makes the model print a DONE marker (req=bootId), and a SessionStart hook writes a boot-signal file; verify with pmux_agent_wait_ready {bootId, expectEcho:true}, then send user work from turn=1 (bootstrap consumed turn 0; do not pass expectPrevTurnEnd on turn 1). bootstrapEcho costs one tiny model turn — pass false to skip. codex hook trust (실측 2026-07-08): the FIRST launch that wires the boot hook requires a one-time interactive trust approval in the codex TUI — until approved, boot.fileSeen stays false while the echo still works; treat fileSeen:false + echoSeen:true on codex as this case, not a failure. This is non-blocking: after a successful start return, use pmux_agent_wait_ready before sending work. wait_ready launch_failed is meaningful only after start has successfully sent the command; an idle shell before command send is indistinguishable to the stateless wait tool. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab. Codex command: codex --no-alt-screen -s <sandbox>; Claude permissionMode choices are based on claude 2.1.201 and intentionally exclude bypassPermissions; claude effort maps to the --effort flag (claude >=2.1.202).",
      inputSchema: S.agentStartShape,
    },
    guard(async (args: AgentStartArgs) => {
      validateModel(args.model);
      const base = buildAgentCommand(args);
      const bootId = generateRequestId();
      const bootFile = bootFilePath(bootId);
      const wired = await wireHooksAndBoot(args, base.command, bootId);
      const bootstrapEcho = args.bootstrapEcho ?? true;
      // `env VAR=… cmd` (not the bare VAR=… prefix) so fish shells work too.
      let command = wired.bootWired
        ? `env PMUX_BOOT_FILE=${shellQuote(bootFile)} ${wired.command}`
        : wired.command;
      if (bootstrapEcho) {
        // Positional initial prompt LAST, after every flag (auto-submitted
        // by both CLIs — 실측 2026-07-08). Fixed template; only the hex
        // bootId is interpolated, so the §4.6 allowlist invariant holds.
        command = `${command} ${shellQuote(buildBootstrapEchoPrompt(bootId))}`;
      }
      await pruneBootArtifacts(bootId);
      const fileOutputHint = recommendedFileOutput(args);
      const next = bootstrapEcho
        ? "pmux_agent_wait_ready에 bootId와 expectEcho:true를 전달해 echo 완료를 확인한 뒤 turn=1부터 작업 전송 (bootstrap이 turn 0을 소비하므로 사용자 턴은 1부터, turn 1에는 expectPrevTurnEnd를 주지 말 것)"
        : "pmux_agent_wait_ready(bootId 전달 권장) 후 pmux_agent_send 또는 pmux_agent_turn";
      const bootFields = {
        bootId,
        bootFile,
        bootWired: wired.bootWired,
        ...(wired.settingsMerge !== undefined
          ? { settingsMerge: wired.settingsMerge }
          : {}),
        bootstrapEcho,
      };
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
          hooksWired: wired.hooksWired,
          ...bootFields,
          recommendedFileOutput: fileOutputHint,
          next,
          fallback: "wait_ready timeout이나 판정 불확실 시 pmux_capture_pane으로 직접 확인",
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
        hooksWired: wired.hooksWired,
        ...bootFields,
        recommendedFileOutput: fileOutputHint,
        next,
        fallback: "wait_ready timeout이나 판정 불확실 시 pmux_capture_pane으로 직접 확인",
      });
    }),
  );

  server.registerTool(
    "pmux_agent_wait_ready",
    {
      description:
        "Primary agent orchestration tool: poll a tab until an agent is ready, still starting/busy, launch_failed, exited, or timeout. Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. agent_busy is non-terminal and keeps polling. Boot verification (recommended after pmux_agent_start): pass {bootId, expectEcho:true} — agent_ready is then returned ONLY on the bootstrap DONE marker (completion evidence; supersedes ready heuristics, requireBusyTransition and runtimeError), and every response carries boot.fileSeen (SessionStart boot-signal file — diagnostic only; on echo timeout, fileSeen:false suggests launch/hook-trust failure while fileSeen:true suggests the model never answered). Default timeout rises to 90s under expectEcho. requireBusyTransition defaults false for boot readiness; set true when waiting after send so ready is returned only after busy was observed or an initial non-ready baseline later changes to ready. In boot mode only (and never under expectEcho), pane fallback input_queued can be treated as a composer placeholder and returned ready; send validation remains strict. Uses pane capture + tab_status only; no server-side registry is kept. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab.",
      inputSchema: S.agentWaitReadyShape,
    },
    guard(runWaitReady),
  );

  server.registerTool(
    "pmux_agent_send",
    {
      description:
        "Primary agent orchestration tool: validate provider-specific readiness/busy/error state, optionally verify a previous DONE signal or END marker, append the v2.1 PMUX footer, and send the prompt. Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. For fileOutput=true previous turns, pass expectPrevTurnEnd together with expectPrevRequestId so shortened req-keyed markers can be matched. On turn <= 1 only, pane fallback input_queued is treated as a composer placeholder and sent with validation.warning; later turns remain strict. fileOutput defaults true: requestId is generated when omitted, workspaceDir is resolved from workspaces[].directories[0], and expectedReportFile is returned. Use fileOutput:false when pmux_agent_start returned recommendedFileOutput:false; read-only/plan agents cannot write report files. fileOutput=false uses the pane BEGIN/END fallback. agent_busy returns {sent:false, reason:\"busy\"}. Caller contract: if pmux_agent_capture returns partial/working, do not call pmux_agent_send again until the current turn completes or is explicitly abandoned.",
      inputSchema: S.agentSendShape,
    },
    guard(async (args: AgentSendArgs) => {
      return jsonResult(await sendAgentPrompt(args));
    }),
  );

  server.registerTool(
    "pmux_agent_turn",
    {
      description:
        "Primary agent orchestration tool for one full turn: send a prompt, poll for completion evidence, then return the recovered response. Safe to call immediately after a previous turn; transient pre-send busy/starting states are retried within the same pollTimeoutMs budget. Use pmux_agent_capture with the returned marker to resume after timeout; use pmux_send_input/pmux_capture_pane only as low-level fallbacks. Completion evidence from a valid report file or pane markers wins over readiness/runtime-error signals. Without completion evidence, ready plus runtimeError returns status:\"agent_error\".",
      inputSchema: S.agentTurnShape,
    },
    guard(async (args: AgentTurnArgs) => jsonResult(await runAgentTurn(args))),
  );

  server.registerTool(
    "pmux_agent_capture",
    {
      description:
        "Primary agent orchestration tool: recover a v2.1 agent response. Use pmux_capture_pane only as a low-level fallback. If requestId is supplied, first read the report file at workspaceDir/.pmux-agents/<agentId>/turn-<n>.md and require matching status line plus EOF marker. Without requestId, file recovery is skipped and pane BEGIN/END fallback is used. Returns structured complete/blocked/working/inconsistent/partial/missing results; partial/working means do not send the next turn yet.",
      inputSchema: S.agentCaptureShape,
    },
    guard(async (args: AgentCaptureArgs) => {
      const evidence = await captureAgentEvidence(args);
      const { tail: _tail, ...withoutTail } = evidence;
      if (evidence.status === "complete" || evidence.status === "blocked") {
        return jsonResult(withoutTail);
      }
      return jsonResult(evidence);
    }),
  );

  server.registerTool(
    "pmux_agent_status",
    {
      description:
        "Primary agent orchestration tool: return a no-wait v2.1 status snapshot. Use pmux_tab_status/pmux_capture_pane only as low-level fallbacks. Includes tab alive, provider-specific readiness, optional DONE signal for agentId/turn/requestId, optional report-file check, runtimeError when detected, and pane tail. No server-side state is kept.",
      inputSchema: S.agentStatusShape,
    },
    guard(runAgentStatus),
  );
}
