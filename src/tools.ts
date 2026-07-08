import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { callApi, type RawResult } from "./http.js";
import { ToolError } from "./errors.js";
import { resolvePort, resolveToken, isValidPort } from "./config.js";
import * as S from "./schemas.js";
import { registerAgentTools } from "./agents/index.js";
import { ORCHESTRATION_GUIDE } from "./guide.js";
import { guard, jsonResult, textResult } from "./tool-result.js";

/** Pull a base64 string out of the various screenshot shapes defensively. */
function extractBase64(payload: unknown): string | null {
  if (typeof payload === "string" && payload.length > 0) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.base64 === "string") return obj.base64;
    if (typeof obj.data === "string") return obj.data;
  }
  return null;
}

export function registerAll(server: McpServer): void {
  // 1. list workspaces
  server.registerTool(
    "pmux_list_workspaces",
    {
      description:
        "List purplemux workspaces: { workspaces:[{id,name,directories}] }. Start here to get workspaceId values for the other tools.",
      inputSchema: S.listWorkspacesShape,
    },
    guard(async () => jsonResult(await callApi("GET", "/api/cli/workspaces"))),
  );

  // 2. list tabs
  server.registerTool(
    "pmux_list_tabs",
    {
      description:
        "List tabs, optionally filtered by workspaceId. Omit workspaceId to list across all workspaces. Unknown workspaceId returns {tabs:[]}, not an error.",
      inputSchema: S.listTabsShape,
    },
    guard(async ({ workspaceId }) =>
      jsonResult(
        await callApi("GET", "/api/cli/tabs", { query: { workspaceId } }),
      ),
    ),
  );

  // 3. create tab
  server.registerTool(
    "pmux_create_tab",
    {
      description:
        "Create a tab in a workspace. panelType is one of terminal | claude-code | codex-cli | agent-sessions | web-browser | diff (default terminal); invalid → 400 with validPanelTypes. WARNING: claude-code/codex-cli panelType creates a UI panel, NOT a managed agent session — the pane may be an empty shell before the UI attaches, and sending prompts into it is unreliable. To run a subagent, use pmux_agent_start instead (it launches the CLI in a terminal tab under full protocol control). Creating claude-code/codex-cli without the CLI installed → 409 with suggestedCommand. Returns the created-tab object.",
      inputSchema: S.createTabShape,
    },
    guard(async ({ workspaceId, name, panelType }) =>
      jsonResult(
        await callApi("POST", "/api/cli/tabs", {
          body: { workspaceId, name, panelType },
        }),
      ),
    ),
  );

  // 4. get tab (API-only)
  server.registerTool(
    "pmux_get_tab",
    {
      description: "Get info for a single tab by id.",
      inputSchema: S.getTabShape,
    },
    guard(async ({ workspaceId, tabId }) =>
      jsonResult(
        await callApi("GET", `/api/cli/tabs/${encodeURIComponent(tabId)}`, {
          query: { workspaceId },
        }),
      ),
    ),
  );

  // 5. send input
  server.registerTool(
    "pmux_send_input",
    {
      description:
        "Low-level fallback for manual tab input; for agent orchestration prefer pmux_agent_* tools. Send text to a tab. The server AUTO-SUBMITS (delivers as a bracketed paste then presses Enter) — do NOT append a newline to submit. Exactly one trailing '\\n' is stripped from content; other whitespace is preserved. Returns { status:\"sent\" }. 409 'Tab session is not running' if the tmux session is dead.",
      inputSchema: S.sendInputShape,
    },
    guard(async ({ workspaceId, tabId, content }) => {
      // Strip exactly one trailing "\n"; never append one.
      const normalized = content.endsWith("\n")
        ? content.slice(0, -1)
        : content;
      return jsonResult(
        await callApi(
          "POST",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/send`,
          { query: { workspaceId }, body: { content: normalized } },
        ),
      );
    }),
  );

  // 6. tab status
  server.registerTool(
    "pmux_tab_status",
    {
      description:
        "Get tab runtime status. NOTE: for web-browser tabs alive:false is NORMAL (they are Electron webviews, not tmux) — probe health via the browser tools instead. claudeSessionId is a legacy alias of agentSessionId (same value).",
      inputSchema: S.tabStatusShape,
    },
    guard(async ({ workspaceId, tabId }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/status`,
          { query: { workspaceId } },
        ),
      ),
    ),
  );

  // 7. capture pane
  server.registerTool(
    "pmux_capture_pane",
    {
      description:
        "Low-level fallback for manual pane inspection; for agent orchestration prefer pmux_agent_* tools. Capture the current pane snapshot as { content }. Not meaningful for web-browser tabs. 409 'Tab session is not running' if the session is dead.",
      inputSchema: S.capturePaneShape,
    },
    guard(async ({ workspaceId, tabId }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/result`,
          { query: { workspaceId } },
        ),
      ),
    ),
  );

  // 8. close tab
  server.registerTool(
    "pmux_close_tab",
    {
      description:
        "Close a tab. Returns the real { ok:boolean } body (surfaced faithfully; the CLI would hide it). For web-browser tabs the tmux kill is skipped.",
      inputSchema: S.closeTabShape,
    },
    guard(async ({ workspaceId, tabId }) =>
      jsonResult(
        await callApi("DELETE", `/api/cli/tabs/${encodeURIComponent(tabId)}`, {
          query: { workspaceId },
        }),
      ),
    ),
  );

  // 9. browser url
  server.registerTool(
    "pmux_browser_url",
    {
      description:
        "Get the browser tab's { tabId, url, title }. Browser tools are Electron-only: 503 = not running under Electron (hard, don't retry); 409 'Browser tab not attached yet' = webview not dom-ready (transient, retry shortly). 400 'Tab is not a web-browser panel' on a non-browser tab.",
      inputSchema: S.browserUrlShape,
    },
    guard(async ({ workspaceId, tabId }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/url`,
          { query: { workspaceId } },
        ),
      ),
    ),
  );

  // 10. browser screenshot
  server.registerTool(
    "pmux_browser_screenshot",
    {
      description:
        "Screenshot a web-browser tab. Default: returns MCP image content (PNG). With savePath: writes raw PNG bytes to that path and returns { saved, bytes }. full=true captures beyond the viewport. Electron-only (503 hard / 409 'not attached yet' transient).",
      inputSchema: S.browserScreenshotShape,
    },
    guard(async ({ workspaceId, tabId, full, savePath }) => {
      const path = `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/screenshot`;
      if (savePath) {
        // File mode: caller must give an absolute path; never clobber.
        if (!isAbsolute(savePath)) {
          throw new ToolError(
            `savePath must be an absolute path (got "${savePath}").`,
          );
        }
        const raw = await callApi<RawResult>("GET", path, {
          query: { workspaceId, full: full ? 1 : undefined },
          raw: true,
        });
        try {
          // flag "wx" → fail if the file already exists (no arbitrary overwrite).
          await writeFile(savePath, raw.bytes, { flag: "wx" });
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "EEXIST") {
            throw new ToolError(
              `Refusing to overwrite existing file at ${savePath}; choose a new path.`,
            );
          }
          throw new ToolError(
            `Failed to write screenshot to ${savePath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return jsonResult({ saved: savePath, bytes: raw.bytes.byteLength });
      }
      // Default → MCP image content. Fetch raw and encode ourselves so we
      // handle BOTH server shapes: image/png bytes OR JSON {base64}. This
      // avoids UTF-8-decoding binary into a corrupt base64 string.
      const raw = await callApi<RawResult>("GET", path, {
        query: { workspaceId, full: full ? 1 : undefined, format: "base64" },
        raw: true,
      });
      const ct = (raw.contentType ?? "").toLowerCase();
      let base64: string | null;
      if (ct.includes("json")) {
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.from(raw.bytes).toString("utf8"));
        } catch {
          payload = null;
        }
        base64 = extractBase64(payload);
      } else if (ct.includes("image") || raw.bytes.byteLength > 0) {
        // Raw PNG bytes → encode to base64 directly.
        base64 = Buffer.from(raw.bytes).toString("base64");
      } else {
        base64 = null;
      }
      if (!base64) {
        throw new ToolError(
          "Screenshot succeeded but no image data was found in the response.",
          { details: { contentType: raw.contentType, bytes: raw.bytes.byteLength } },
        );
      }
      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
    }),
  );

  // 11. browser console
  server.registerTool(
    "pmux_browser_console",
    {
      description:
        "Get browser console entries { tabId, entries[] } (ring buffer, last 500). since=ms is an incremental polling cursor; level filters by console level. Electron-only (503/409).",
      inputSchema: S.browserConsoleShape,
    },
    guard(async ({ workspaceId, tabId, since, level }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/console`,
          { query: { workspaceId, since, level } },
        ),
      ),
    ),
  );

  // 12. browser network
  server.registerTool(
    "pmux_browser_network",
    {
      description:
        "Get browser network entries { tabId, entries[] } (ring buffer, last 500). Filters: since=ms cursor, method (upper-cased server-side), url (substring), status (exact int). Electron-only (503/409). Use pmux_browser_network_body for a single response body.",
      inputSchema: S.browserNetworkShape,
    },
    guard(async ({ workspaceId, tabId, since, method, url, status }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/network`,
          { query: { workspaceId, since, method, url, status } },
        ),
      ),
    ),
  );

  // 13. browser network body
  server.registerTool(
    "pmux_browser_network_body",
    {
      description:
        "Get a single network response body by requestId: { tabId, requestId, body }. Body is cached after the first call. 404 'Response body unavailable' if not cached/available. Electron-only (503/409).",
      inputSchema: S.browserNetworkBodyShape,
    },
    guard(async ({ workspaceId, tabId, requestId }) =>
      jsonResult(
        await callApi(
          "GET",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/network`,
          { query: { workspaceId, requestId } },
        ),
      ),
    ),
  );

  // 14. browser eval
  server.registerTool(
    "pmux_browser_eval",
    {
      description:
        "Evaluate a JavaScript expression in the page and return { tabId, value } (CDP Runtime.evaluate, returnByValue + awaitPromise, 10s timeout). A JS exception/timeout surfaces as 409. Electron-only: 503 = not under Electron (hard); 409 'Browser tab not attached yet' = webview not dom-ready (transient, retry shortly).",
      inputSchema: S.browserEvalShape,
    },
    guard(async ({ workspaceId, tabId, expression }) =>
      jsonResult(
        await callApi(
          "POST",
          `/api/cli/tabs/${encodeURIComponent(tabId)}/browser/eval`,
          { query: { workspaceId }, body: { expression } },
        ),
      ),
    ),
  );

  // 15. orchestration guide (local, static — no purplemux connection needed)
  server.registerTool(
    "pmux_guide",
    {
      description:
        "Return the orchestration guide for THIS MCP server as markdown: tool layers (agent_* primary vs low-level fallbacks), the golden path for running claude/codex subagents, boot verification semantics, fileOutput routing, failure modes and recovery patterns. Call this before orchestrating subagents for the first time, or whenever an agent_* result is unclear. (For the purplemux HTTP API reference, use pmux_api_guide instead.)",
      inputSchema: S.guideShape,
    },
    guard(async () => textResult(ORCHESTRATION_GUIDE)),
  );

  // 16. api guide
  server.registerTool(
    "pmux_api_guide",
    {
      description:
        "Return the purplemux application's HTTP API reference as markdown (fetched from the running purplemux). This documents the underlying REST endpoints, NOT how to use this MCP server's tools — for orchestration guidance use pmux_guide.",
      inputSchema: S.apiGuideShape,
    },
    guard(async () => {
      const md = await callApi<string>("GET", "/api/cli/api-guide");
      return textResult(typeof md === "string" ? md : JSON.stringify(md));
    }),
  );

  // 17. connection info (local, never leaks the token)
  server.registerTool(
    "pmux_connection_info",
    {
      description:
        "Local diagnostic: { baseUrl?, portSource, tokenSource, hasToken }. NEVER returns the token value. When port/token are missing it returns partial diagnostics (source \"none\", hasToken:false) rather than erroring.",
      inputSchema: S.connectionInfoShape,
    },
    guard(async () => {
      const port = resolvePort();
      const token = resolveToken();
      const portOk = port !== null && isValidPort(port.value);
      return jsonResult({
        baseUrl: portOk ? `http://localhost:${port.value}` : undefined,
        portSource: port ? port.source : "none",
        portValid: port ? portOk : undefined,
        tokenSource: token ? token.source : "none",
        hasToken: token !== null,
      });
    }),
  );
  registerAgentTools(server);
}
