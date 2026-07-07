import { ToolError } from "./errors.js";

export type Provider = "codex" | "claude";
export type Effort = "low" | "medium" | "high" | "xhigh";
export type Sandbox = "read-only" | "workspace-write";
export type PermissionMode =
  | "plan"
  | "manual"
  | "acceptEdits"
  | "dontAsk"
  | "auto";

/** agentId / requestId allowlist (design §4.6). */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** model allowlist — no whitespace/metacharacters (design §4.6). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const EFFORT_VALUES: readonly Effort[] = ["low", "medium", "high", "xhigh"];
const SANDBOX_VALUES: readonly Sandbox[] = ["read-only", "workspace-write"];
const PERMISSION_MODE_VALUES: readonly PermissionMode[] = [
  "plan",
  "manual",
  "acceptEdits",
  "dontAsk",
  "auto",
];

export interface AgentCommandOpts {
  provider: Provider;
  model?: string;
  effort?: Effort;
  sandbox?: Sandbox;
  permissionMode?: PermissionMode;
}

/**
 * Assemble the fixed interactive CLI command for a provider (design §2.1).
 * Every interpolated value is validated against an enum or the allowlist
 * regexes above — no free-form string ever reaches the command string.
 */
export function buildAgentCommand(
  opts: AgentCommandOpts,
): { command: string; bootstrapHint?: string } {
  const { provider, model, effort, sandbox, permissionMode } = opts;

  if (model !== undefined && !MODEL_RE.test(model)) {
    throw new ToolError(
      `Invalid model "${model}": must match ${MODEL_RE.source}.`,
    );
  }

  if (provider === "codex") {
    if (sandbox !== undefined && !SANDBOX_VALUES.includes(sandbox)) {
      throw new ToolError(
        `Invalid sandbox "${sandbox}": must be one of ${SANDBOX_VALUES.join("|")}.`,
      );
    }
    if (effort !== undefined && !EFFORT_VALUES.includes(effort)) {
      throw new ToolError(
        `Invalid effort "${effort}": must be one of ${EFFORT_VALUES.join("|")}.`,
      );
    }
    const parts = ["codex", "--no-alt-screen", "-s", sandbox ?? "read-only"];
    if (model !== undefined) parts.push("-m", model);
    if (effort !== undefined) parts.push("-c", `model_reasoning_effort=${effort}`);
    return { command: parts.join(" ") };
  }

  // claude
  if (
    permissionMode !== undefined &&
    !PERMISSION_MODE_VALUES.includes(permissionMode)
  ) {
    throw new ToolError(
      `Invalid permissionMode "${permissionMode}": must be one of ${PERMISSION_MODE_VALUES.join("|")}.`,
    );
  }
  const parts = ["claude"];
  if (model !== undefined) parts.push("--model", model);
  parts.push("--permission-mode", permissionMode ?? "plan");
  // claude CLI has no --effort flag (design §2.1) — surface it as a bootstrap
  // prompt hint instead of silently dropping it.
  const bootstrapHint =
    effort !== undefined
      ? `Note: claude CLI has no reasoning-effort flag. Please operate at "${effort}" effort for this session.`
      : undefined;
  return { command: parts.join(" "), bootstrapHint };
}

const CODEX_READY_RE = /›/;
const CLAUDE_READY_RE = /❯/;
const CODEX_ERROR_RE = /command not found|unexpected argument/i;
const CLAUDE_ERROR_RE = /command not found|unexpected argument/i;
// codex/claude TUIs both show this during generation (§2.2 실측).
const BUSY_RE = /esc to interrupt/i;

export function defaultReadyPattern(p: Provider): RegExp {
  return p === "codex" ? CODEX_READY_RE : CLAUDE_READY_RE;
}

export function defaultErrorPattern(p: Provider): RegExp {
  return p === "codex" ? CODEX_ERROR_RE : CLAUDE_ERROR_RE;
}

export function defaultBusyPattern(_p: Provider): RegExp {
  return BUSY_RE;
}

/**
 * Compile a caller-supplied readyPattern/errorPattern override. Bounded to
 * <=200 chars and wrapped so a bad regex surfaces as a ToolError rather than
 * throwing a raw SyntaxError (design §4.5-5, ReDoS/DoS guard).
 */
export function compileUserPattern(src: string, field: string): RegExp {
  if (src.length > 200) {
    throw new ToolError(
      `${field} must be <=200 characters (got ${src.length}).`,
    );
  }
  try {
    return new RegExp(src);
  } catch (e) {
    throw new ToolError(
      `${field} failed to compile as a regex: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
