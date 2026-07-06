# Agent 3 Design: purplemux MCP Server

## Decisions

1. Runtime/language: **Node + TypeScript + official `@modelcontextprotocol/sdk`**.
   Rationale: purplemux is Node, the MCP SDK is the canonical path, and a tiny compiled JS entrypoint is easy for both `claude mcp add` and `codex mcp add` to launch; a build step is acceptable as long as the published/checked package exposes `dist/index.js`.

2. Transport: **stdio only**.
   Rationale: both Claude and Codex MCP registrations can launch a local command over stdio, and purplemux itself already provides the localhost HTTP transport behind the MCP facade.

3. Config/auth resolution: **resolve `PMUX_PORT` and `PMUX_TOKEN` lazily per tool call, env first then `~/.purplemux/{port,cli-token}`; do not cache**.
   Rationale: the CLI reads per command intent, but MCP is long-lived, so per-call resolution handles purplemux restarts, port changes, and token regeneration without requiring an MCP server restart.

4. HTTP client: **use Node `fetch` directly with a small typed wrapper**.
   Rationale: Node 20 has built-in fetch, avoiding another runtime dependency while preserving exact JSON, text, and binary handling.

5. Error mapping: **throw MCP tool errors with structured JSON details containing `status`, `error`, and any server fields such as `validPanelTypes`, `suggestedCommand`, provider metadata, or `allow`**.
   Rationale: callers need the server's actionable recovery hints, especially for invalid panel types, missing agent CLIs, auth failures, transient browser attach, and Electron-only browser features.

6. Screenshot handling: **default to MCP image content from API base64 JSON; support optional `savePath` for disk writes returning `{ saved, bytes }`**.
   Rationale: screenshots are images, not plain JSON blobs; returning MCP image content lets clients display them while preserving a file-saving escape hatch.

7. `api-guide` handling: **return MCP text content with markdown unchanged**.
   Rationale: the endpoint is already `text/markdown` and is most useful as readable self-documentation.

8. Diagnostic tool: **include optional `pmux_connection_info`**.
   Rationale: a long-lived MCP server benefits from a safe troubleshooting tool that reports base URL, port source, token source/presence, and never the token value.

## Config And Auth

For every tool call, resolve:

1. `port = process.env.PMUX_PORT || trim(read ~/.purplemux/port)`.
2. `token = process.env.PMUX_TOKEN || read ~/.purplemux/cli-token`.
3. Missing port or token becomes an MCP tool error before HTTP: `PMUX_PORT not set and ~/.purplemux/port missing` or `PMUX_TOKEN not set and ~/.purplemux/cli-token missing`.
4. Base URL is `http://localhost:${port}` and every HTTP request sends `X-Pmux-Token: ${token}`.

On `ECONNREFUSED`, report "purplemux server not running or port changed" and include the resolved port/source. On HTTP 403, report auth failure and point to `PMUX_TOKEN` or `~/.purplemux/cli-token`; because resolution is per-call, the next invocation can recover automatically after the token is fixed.

## HTTP Error Mapping

- `400`: invalid request; include server `error` and `validPanelTypes` when present.
- `403`: auth failure; include source-aware token guidance, never token contents.
- `404`: not found or unavailable body; include server `error`.
- `405`: method bug; include `Allow` header for implementation diagnosis.
- `409`: typed conflict; include server `error`, provider metadata, and `suggestedCommand`; mark `Browser tab not attached yet` as transient/retryable.
- `500`: purplemux internal create/pane failure; include server `error`.
- `503`: Electron browser bridge unavailable; hard failure, not retryable.

All non-2xx responses should attempt JSON first, then text, then empty body. Tool errors should preserve the raw status and concise recovery text for LLM clients.

## Tool List

1. `pmux_list_workspaces`: inputs none; output `{ workspaces: [{ id, name, directories }] }`.
2. `pmux_list_tabs`: optional `workspaceId`; output `{ tabs: [...] }`.
3. `pmux_create_tab`: required `workspaceId`; optional `name`, `panelType`; output created tab object.
4. `pmux_get_tab`: required `workspaceId`, `tabId`; output tab info object.
5. `pmux_send_input`: required `workspaceId`, `tabId`, `content`; output `{ status: "sent" }`.
6. `pmux_tab_status`: required `workspaceId`, `tabId`; output status object, treating browser `alive:false` as normal.
7. `pmux_capture_pane`: required `workspaceId`, `tabId`; output `{ content }`.
8. `pmux_close_tab`: required `workspaceId`, `tabId`; output real `{ ok: boolean }`.
9. `pmux_browser_url`: required `workspaceId`, `tabId`; output `{ tabId, url, title }`.
10. `pmux_browser_screenshot`: required `workspaceId`, `tabId`; optional `full`, `savePath`; output MCP image content or `{ saved, bytes }`.
11. `pmux_browser_console`: required `workspaceId`, `tabId`; optional `since`, `level`; output `{ tabId, entries }`.
12. `pmux_browser_network`: required `workspaceId`, `tabId`; optional `since`, `method`, `url`, `status`; output `{ tabId, entries }`.
13. `pmux_browser_network_body`: required `workspaceId`, `tabId`, `requestId`; output `{ tabId, requestId, body }`.
14. `pmux_browser_eval`: required `workspaceId`, `tabId`, `expression`; output `{ tabId, value }`.
15. `pmux_api_guide`: inputs none; output markdown text content.
16. `pmux_connection_info` optional diagnostic: inputs none; output `{ baseUrl, portSource, tokenSource, hasToken }`.

`pmux_send_input` must preserve exact string content except for the Stage 1 safety rule: strip one trailing `\n` by default before sending JSON `{ content }`, because the server auto-submits with Enter.

## Registration

Preferred package entrypoint after build:

```bash
claude mcp add purplemux -- node /absolute/path/to/purplemux-mcp/dist/index.js
codex mcp add purplemux -- node /absolute/path/to/purplemux-mcp/dist/index.js
```

With explicit env:

```bash
claude mcp add purplemux -e PMUX_PORT=16500 -e PMUX_TOKEN=... -- node /absolute/path/to/purplemux-mcp/dist/index.js
codex mcp add purplemux -e PMUX_PORT=16500 -e PMUX_TOKEN=... -- node /absolute/path/to/purplemux-mcp/dist/index.js
```

Claude config shape:

```json
{
  "mcpServers": {
    "purplemux": {
      "command": "node",
      "args": ["/absolute/path/to/purplemux-mcp/dist/index.js"],
      "env": {
        "PMUX_PORT": "16500",
        "PMUX_TOKEN": "optional-if-file-exists"
      }
    }
  }
}
```

Codex config shape:

```toml
[mcp_servers.purplemux]
command = "node"
args = ["/absolute/path/to/purplemux-mcp/dist/index.js"]

[mcp_servers.purplemux.env]
PMUX_PORT = "16500"
PMUX_TOKEN = "optional-if-file-exists"
```

## Repo Layout And Build

Recommended Stage 3 layout:

```text
package.json
tsconfig.json
src/index.ts
src/config.ts
src/http.ts
src/tools.ts
src/schemas.ts
src/errors.ts
dist/index.js
```

Stage 3 should implement a small SDK stdio server in `src/index.ts`, centralize lazy auth resolution in `config.ts`, centralize fetch/response decoding in `http.ts`, keep tool registration in `tools.ts`, and define Zod schemas in `schemas.ts`. `package.json` should set `"type": "module"`, `"bin": { "purplemux-mcp": "dist/index.js" }`, scripts `build`, `typecheck`, and `test`, and depend on `@modelcontextprotocol/sdk` plus `zod`.

## Stage 5 Tests

1. Config resolution precedence: env beats files; missing port/token errors are clear.
2. Per-call re-read: changed port/token files affect the next call without process restart.
3. HTTP wrapper: headers, JSON bodies, text bodies, image/base64 handling, and `ECONNREFUSED`.
4. Error mapping for 400/403/404/405/409/500/503, preserving `validPanelTypes` and `suggestedCommand`.
5. Every canonical tool maps to the exact method/path/query/body from Stage 1.
6. `pmux_send_input` strips exactly one trailing newline and preserves other whitespace.
7. Browser transient vs hard failures: 409 attached-not-ready is retryable metadata; 503 is hard.
8. Screenshot returns MCP image content in base64 mode and `{ saved, bytes }` in save mode.
9. `pmux_connection_info` never leaks token contents.
