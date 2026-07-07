import { z } from "zod";

/**
 * panelType enum (6) from Stage 1 §3. Default when omitted = "terminal".
 * Invalid → server 400 { error:"Invalid panelType", validPanelTypes:[…] }.
 */
export const panelTypeEnum = z.enum([
  "terminal",
  "claude-code",
  "codex-cli",
  "agent-sessions",
  "web-browser",
  "diff",
]);

export type PanelType = z.infer<typeof panelTypeEnum>;

const workspaceId = z
  .string()
  .min(1)
  .describe("Target workspace id (from pmux_list_workspaces).");
const tabId = z
  .string()
  .min(1)
  .describe("Target tab id (from pmux_list_tabs / pmux_create_tab).");

// Raw shapes (zod objects' .shape) — registerTool wants a raw shape.
export const listWorkspacesShape = {} as const;

export const listTabsShape = {
  workspaceId: workspaceId
    .optional()
    .describe(
      "Optional workspace filter. Omit to list tabs across all workspaces.",
    ),
} as const;

export const createTabShape = {
  workspaceId,
  name: z.string().optional().describe("Optional display name for the tab."),
  panelType: panelTypeEnum
    .optional()
    .describe(
      "One of terminal | claude-code | codex-cli | agent-sessions | web-browser | diff. Defaults to terminal.",
    ),
} as const;

export const getTabShape = {
  workspaceId,
  tabId,
} as const;

export const sendInputShape = {
  workspaceId,
  tabId,
  content: z
    .string()
    .describe(
      "Exact text to deliver. The server auto-submits (presses Enter) — do NOT add a trailing newline; one trailing '\\n' is stripped for you.",
    ),
} as const;

export const tabStatusShape = {
  workspaceId,
  tabId,
} as const;

export const capturePaneShape = {
  workspaceId,
  tabId,
} as const;

export const closeTabShape = {
  workspaceId,
  tabId,
} as const;

export const browserUrlShape = {
  workspaceId,
  tabId,
} as const;

export const browserScreenshotShape = {
  workspaceId,
  tabId,
  full: z
    .boolean()
    .optional()
    .describe("Capture the full page beyond the viewport."),
  savePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "If set, write PNG bytes to this ABSOLUTE path and return {saved,bytes} instead of image content. Must be absolute; refuses to overwrite an existing file.",
    ),
} as const;

export const browserConsoleShape = {
  workspaceId,
  tabId,
  since: z
    .number()
    .int()
    .optional()
    .describe("Incremental polling cursor in ms; only entries after this ts."),
  level: z
    .string()
    .optional()
    .describe("Filter by console level (e.g. error, warning, log)."),
} as const;

export const browserNetworkShape = {
  workspaceId,
  tabId,
  since: z
    .number()
    .int()
    .optional()
    .describe("Incremental polling cursor in ms."),
  method: z
    .string()
    .optional()
    .describe("Filter by HTTP method (upper-cased server-side)."),
  url: z.string().optional().describe("Filter by URL substring."),
  status: z
    .number()
    .int()
    .optional()
    .describe("Filter by exact HTTP status code."),
} as const;

export const browserNetworkBodyShape = {
  workspaceId,
  tabId,
  requestId: z
    .string()
    .min(1)
    .describe("Network requestId (from pmux_browser_network entries)."),
} as const;

export const browserEvalShape = {
  workspaceId,
  tabId,
  expression: z
    .string()
    .min(1)
    .describe("JavaScript expression evaluated in the page (CDP, 10s timeout)."),
} as const;

export const apiGuideShape = {} as const;

export const connectionInfoShape = {} as const;

const providerEnum = z.enum(["codex", "claude"]);
const effortEnum = z.enum(["low", "medium", "high", "xhigh"]);
const sandboxEnum = z.enum(["read-only", "workspace-write"]);
const permissionModeEnum = z.enum([
  "plan",
  "manual",
  "acceptEdits",
  "dontAsk",
  "auto",
]);

const agentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
  .describe("Caller-owned agent id: ^[a-z0-9][a-z0-9_-]{0,31}$.");
const requestId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
  .optional()
  .describe("Optional caller-owned request id using the same format as agentId.");
const turn = z
  .number()
  .int()
  .min(0)
  .describe("Caller-owned turn number. turn=0 is recommended for bootstrap.");
const userPattern = (field: string) =>
  z
    .string()
    .max(200)
    .optional()
    .describe(`${field} regex override. Max 200 chars; compile errors become ToolError.`);

export const agentStartShape = {
  workspaceId,
  name: z.string().optional().describe("Optional display name for the terminal tab."),
  provider: providerEnum.describe("Agent CLI provider: codex or claude."),
  model: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Optional model id. Must satisfy ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$; invalid values return ToolError.",
    ),
  effort: effortEnum
    .optional()
    .describe("Optional reasoning effort. For claude this is returned as bootstrapHint, not a CLI flag."),
  sandbox: sandboxEnum
    .optional()
    .describe("Codex-only sandbox. Defaults to read-only in the command profile."),
  permissionMode: permissionModeEnum
    .optional()
    .describe("Claude-only permission mode; bypassPermissions is intentionally excluded."),
  shellTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30000)
    .optional()
    .describe("How long pmux_agent_start waits for the new terminal shell prompt before returning not_shell_ready. Defaults to 5000; max 30000."),
} as const;

export const agentWaitReadyShape = {
  workspaceId,
  tabId,
  provider: providerEnum,
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(180000)
    .optional()
    .describe("Total polling timeout in ms. Defaults to 30000; max 180000."),
  pollMs: z
    .number()
    .int()
    .min(500)
    .optional()
    .describe("Polling interval in ms. Defaults to 1500; minimum 500."),
  readyPattern: userPattern("readyPattern"),
  errorPattern: userPattern("errorPattern"),
  busyPattern: userPattern("busyPattern"),
} as const;

export const agentSendShape = {
  workspaceId,
  tabId,
  provider: providerEnum.describe("Provider used for readiness/busy checks: codex or claude."),
  agentId,
  turn,
  prompt: z.string().min(1).describe("Prompt body to send before the standard PMUX sentinel footer."),
  requestId,
  fileOutput: z
    .boolean()
    .optional()
    .describe("Defaults to true. true writes response content to the v2.1 report file; false uses pane BEGIN/END fallback."),
  maxResponseLines: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line limit inserted into the sentinel footer. Defaults to 40."),
  expectPrevTurnEnd: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("If set, the pane must contain the previous turn's END marker before sending."),
  skipReadyCheck: z
    .boolean()
    .optional()
    .describe("Skip prompt-readiness gating, but still reject launch/error patterns."),
  readyPattern: userPattern("readyPattern"),
  errorPattern: userPattern("errorPattern"),
  busyPattern: userPattern("busyPattern"),
} as const;

export const agentCaptureShape = {
  workspaceId,
  tabId,
  agentId,
  turn,
  requestId,
} as const;

export const agentStatusShape = {
  workspaceId,
  tabId,
  provider: providerEnum,
  agentId: agentId
    .optional()
    .describe("Optional agent id. When omitted, status returns readiness only."),
  turn: turn
    .optional()
    .describe("Optional turn number. Used with agentId for DONE/report-file status."),
  requestId,
  readyPattern: userPattern("readyPattern"),
  errorPattern: userPattern("errorPattern"),
  busyPattern: userPattern("busyPattern"),
} as const;
