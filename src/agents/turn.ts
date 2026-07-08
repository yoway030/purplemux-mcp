import { callApi } from "../http.js";
import { ToolError } from "../errors.js";
import { defaultBusyPattern } from "../profiles.js";
import {
  classifyReadiness,
  extractMarkerBlock,
  hasPriorTurnCompletion,
  parseDoneSignal,
  tailLines,
} from "../pane.js";
import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "../paths.js";
import { capturePane, resolveWorkspaceDir, tabStatus } from "./api.js";
import { generateRequestId, sleep, validateId } from "./common.js";
import {
  classifyTurnReadiness,
  compileAllPatterns,
  isShellCommand,
  nativeCliState,
  runtimeErrorInTail,
  withRuntimeError,
} from "./readiness.js";
import { buildPaneFallbackFooter } from "./report.js";
import type {
  AgentCaptureArgs,
  AgentSendArgs,
  AgentSendValue,
  AgentTurnArgs,
  CaptureEvidence,
} from "./types.js";

export async function sendAgentPrompt(args: AgentSendArgs): Promise<AgentSendValue> {
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

export async function captureAgentEvidence(args: AgentCaptureArgs): Promise<CaptureEvidence> {
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

export async function runAgentTurn(args: AgentTurnArgs): Promise<Record<string, unknown>> {
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
