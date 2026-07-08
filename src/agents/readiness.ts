import { classifyReadiness, detectRuntimeError } from "../pane.js";
import {
  SHELL_NAMES,
  compileUserPattern,
  defaultBusyPattern,
  defaultErrorPattern,
  defaultReadyPattern,
  mapCliState,
  type Provider,
} from "../profiles.js";
import { tabStatus } from "./api.js";
import type { NativeState, RuntimeErrorInfo } from "./types.js";

export function isShellCommand(command: string | null): boolean {
  if (command === null) return false;
  const names = SHELL_NAMES as unknown as {
    has?: (value: string) => boolean;
    includes?: (value: string) => boolean;
  };
  return names.has?.(command) ?? names.includes?.(command) ?? false;
}

export function nativeCliState(
  provider: Provider,
  rawCliState: string | null,
): NativeState | null {
  if (rawCliState === null) return null;
  return mapCliState(provider, rawCliState) as NativeState | null;
}

export function runtimeErrorInTail(
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

export function withRuntimeError<const T extends Record<string, unknown>>(
  value: T,
  tail: string,
  pattern?: RegExp,
): T & { runtimeError?: RuntimeErrorInfo } {
  const runtimeError = runtimeErrorInTail(tail, pattern);
  return runtimeError === undefined ? value : { ...value, runtimeError };
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

function isReadyStateForTurn(state: NativeState | ReturnType<typeof classifyReadiness>["state"] | null): boolean {
  return state === "agent_ready";
}

export async function classifyTurnReadiness(o: {
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
