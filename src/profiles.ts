import { ToolError } from "./errors.js";
import type { ReadinessState } from "./pane.js";

export type Provider = "codex" | "claude";

/** tmux foreground-process names that mean "no CLI is running" (design R0.2 step1). */
export const SHELL_NAMES = ["bash", "zsh", "fish", "sh", "dash"] as const;
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
// codex/claude TUIs both show this during generation (§2.2 실측). R1 adds
// "Working" and the braille spinner glyph block common CLI spinners animate
// through — narrowed (턴2, Opus 관찰1, non-blocking) to require the two be
// adjacent to each other (or "Working" adjacent to an ellipsis/opening
// paren, e.g. "Working (12s · ...)"), rather than matching either
// independently anywhere in tail(30). An unqualified `\bworking\b` or a bare
// braille glyph anywhere in the tail is too broad for a pane fallback — the
// former can appear in ordinary response prose ("the script is working"),
// and the latter in unrelated Unicode content; requiring status-bar-style
// adjacency keeps the busy signal tied to an actual spinner context.
const BUSY_RE =
  /esc to interrupt|\bworking\b\s*(?:\.{3}|…|\(|[⠀-⣿])|[⠀-⣿]\s*\bworking\b/i;

export function defaultReadyPattern(p: Provider): RegExp {
  return p === "codex" ? CODEX_READY_RE : CLAUDE_READY_RE;
}

export function defaultErrorPattern(p: Provider): RegExp {
  return p === "codex" ? CODEX_ERROR_RE : CLAUDE_ERROR_RE;
}

export function defaultBusyPattern(_p: Provider): RegExp {
  return BUSY_RE;
}

// R1 frame signatures — status-bar tells that are present regardless of
// composer content, used to confirm "this really is the CLI's frame" before
// trusting readiness on a pane that doesn't match the fast glyph path.
const CODEX_FRAME_SIGNATURES: readonly RegExp[] = [
  /Read Only/,
  /Workspace/,
  /gpt-/,
  /·/,
];
const CLAUDE_FRAME_SIGNATURES: readonly RegExp[] = [
  /─{3,}/, // input box border
  /shift\+tab/i, // status-line mode-cycle hint
  /for agents/i, // status-line
  /⏵⏵/, // status-line permission-mode glyph
];

/** Status-bar signature patterns for the given provider (design R1, frameSeen). */
export function frameSignaturePatterns(p: Provider): readonly RegExp[] {
  return p === "codex" ? CODEX_FRAME_SIGNATURES : CLAUDE_FRAME_SIGNATURES;
}

/**
 * Map purplemux's native `cliState` (design R0.1b live-PoC table) to our
 * ReadinessState. Deliberately an open set: any value not in the table
 * (including "idle"/"unknown"/future vocabulary) returns null so the caller
 * falls back to the pane heuristic (R1) rather than guessing.
 */
export function mapCliState(
  provider: Provider,
  cliState: string,
): ReadinessState | null {
  switch (cliState) {
    case "busy":
      return "agent_busy";
    case "notification":
      return "agent_blocked";
    case "needs-input":
      return "agent_ready";
    case "ready-for-review":
      // codex: turn-completion vocabulary → ready. claude: plan-approval
      // wait → blocked (design R0.1b, provider-specific — no blanket mapping).
      return provider === "codex" ? "agent_ready" : "agent_blocked";
    default:
      return null;
  }
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
