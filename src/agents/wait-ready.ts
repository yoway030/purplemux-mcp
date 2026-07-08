import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ToolError } from "../errors.js";
import { jsonResult } from "../tool-result.js";
import { classifyReadiness, parseDoneSignal, TAIL_LINES, tailLines } from "../pane.js";
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
    // Terminal response builder for THIS iteration (R2-D4). tail is computed
    // at call time from lastPane so the exited branch — which fires BEFORE
    // polls increments and the pane recapture — keeps its original
    // stale-tail / pre-increment semantics. reason stays right after state
    // (JSON.stringify insertion order) and is omitted when undefined,
    // exactly like the former literals. The terminal timeout return below
    // the loop has a different key set (baseline/transitionSeen/last*) and
    // is intentionally NOT built by emit.
    const emit = (
      state: string,
      signalSource: "cliState" | "pane",
      reason?: string,
    ) => {
      const tail = tailLines(lastPane, TAIL_LINES);
      return jsonResult({
        state,
        ...(reason !== undefined ? { reason } : {}),
        elapsedMs: Date.now() - started,
        polls,
        signalSource,
        rawCliState: status.rawCliState,
        command: status.command,
        runtimeError: runtimeErrorInTail(tail, runtimeErrorPattern),
        ...bootInfo(),
        tail,
      });
    };
    if (bootFile !== undefined && !fileSeen) fileSeen = bootFileSeen(args.bootId as string);
    if (!status.alive) {
      return emit("exited", "cliState");
    }

    lastPane = await capturePane(args.workspaceId, args.tabId);
    polls += 1;

    if (isShellCommand(status.command)) {
      return emit("launch_failed", "cliState");
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
        return emit("agent_blocked", "pane", "bootstrap_echo_blocked");
      }
      if (echo.found) {
        // Completion evidence — supersedes ready-pattern heuristics,
        // requireBusyTransition bookkeeping AND a matched runtimeError
        // (which is still reported alongside), same precedence the turn
        // tool already uses (합의 항목 2).
        echoSeen = true;
        return emit("agent_ready", "pane", "bootstrap_echo");
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
      return emit("agent_blocked", "cliState");
    } else if (native === "launch_failed") {
      return emit("launch_failed", "cliState");
    } else if (native === "agent_ready") {
      if (
        requireBusyTransition &&
        baseline !== undefined &&
        baseline.state !== "agent_ready"
      ) {
        transitionSeen = true;
      }
      if (!requireBusyTransition || transitionSeen) {
        return emit("agent_ready", "cliState");
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
      return emit("agent_ready", "pane");
    }
    if (classifiedState === "agent_blocked") {
      // pane-side approval-dialog detection (claude plan/permission
      // prompts) — parallel to the native agent_blocked branch, needed
      // since claude ready-for-review no longer maps to blocked.
      return emit("agent_blocked", "pane", classified.reason);
    }
    // READINESS LADDER (wait-ready variant) — one of three deliberately
    // DIFFERENT ladders; do not unify without a behavior review (worklog
    // plan-sustainability-refactor.md 비목표). Here: input_queued promotes
    // to ready only in plain boot mode (no expectEcho, no busy-transition
    // requirement). Compare: turn.ts sendAgentPrompt (turn <= 1 promotion
    // with validation warning), readiness.ts classifyTurnReadiness (none).
    if (
      !expectEcho &&
      !requireBusyTransition &&
      classifiedState === "agent_starting" &&
      classified.reason === "input_queued"
    ) {
      // Under expectEcho the queued composer content is (or contains)
      // our own bootstrap prompt awaiting auto-submit — promoting it to
      // ready would defeat the echo gate, so the promotion is disabled.
      return emit("agent_ready", "pane", "composer_placeholder_assumed");
    }
    if (classifiedState === "launch_failed") {
      return emit("launch_failed", "pane");
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
    runtimeError: runtimeErrorInTail(tailLines(lastPane, TAIL_LINES), runtimeErrorPattern),
    ...bootInfo(),
    tail: tailLines(lastPane, TAIL_LINES),
  });
}
