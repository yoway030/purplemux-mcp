import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ToolError } from "../errors.js";
import { jsonResult } from "../tool-result.js";
import { classifyReadiness, parseDoneSignal, tailLines } from "../pane.js";
import {
  BOOTSTRAP_ECHO_AGENT_ID,
  BOOTSTRAP_ECHO_TURN,
  bootFilePath,
  bootFileSeen,
} from "../boot.js";
import { capturePane, tabStatus } from "./api.js";
import { sleep } from "./common.js";
import {
  compileAllPatterns,
  isShellCommand,
  nativeCliState,
  runtimeErrorInTail,
} from "./readiness.js";
import type { AgentWaitReadyArgs } from "./types.js";

export async function runWaitReady(args: AgentWaitReadyArgs): Promise<CallToolResult> {
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
