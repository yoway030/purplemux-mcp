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
