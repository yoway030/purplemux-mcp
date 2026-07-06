# Stage 2 · Canonical Design — purplemux MCP Server

Authoritative merged design from the 3-agent panel (Sonnet / Opus / Codex). Implementation
spec for Stage 3. Source of truth for behavior is `docs/01-cli-features.md`.

## 0. Decisions (all panel-unanimous unless noted)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Runtime | **Node ≥ 20 + TypeScript + official `@modelcontextprotocol/sdk`** | purplemux is Node; SDK is canonical; matches both clients |
| 2 | Build | **`tsc` → `dist/index.js`** (build step OK); launch `node dist/index.js` | tiny compiled entry, no runtime TS needed by `mcp add` |
| 3 | Transport | **stdio** | both Claude Code and Codex launch stdio MCP servers |
| 4 | HTTP client | **built-in Node `fetch`** + small typed wrapper | zero extra dep; exact JSON/text/binary handling |
| 5 | Config/auth | **lazy per-call resolution, no cache** (env → `~/.purplemux/{port,cli-token}`) | *(panel split: Sonnet startup-cache, Opus TTL, Codex per-call — consensus: per-call, no cache)* → two tiny file reads per call, negligible; absorbs purplemux restart / port change / token regen without restarting the MCP server |
| 6 | Screenshot | **MCP image content (base64 mode) by default; `savePath` → file mode `{saved,bytes}`** | screenshots are images; keep a disk escape hatch |
| 7 | api-guide | **MCP text content, markdown unchanged** | already `text/markdown`, best as self-doc |
| 8 | Diagnostic tool | **include `pmux_connection_info`** (never leaks token) | long-lived server needs safe troubleshooting |
| 9 | Schemas | **Zod** input schemas per tool | SDK-native validation |

## 1. Config / auth module (`src/config.ts`)

Resolve on **every tool call** (cheap file reads; robust to restarts):

```
port  = process.env.PMUX_PORT  || trim(read ~/.purplemux/port)   // else error
token = process.env.PMUX_TOKEN || trim(read ~/.purplemux/cli-token) // else error
baseUrl = `http://localhost:${port}`
```

- Missing port → tool error `PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)`.
- Missing token → analogous message.
- Track `portSource` / `tokenSource` (`env` | `file`) for `pmux_connection_info` and error hints.
- Never emit the token value anywhere in tool output.

## 2. HTTP + error module (`src/http.ts`)

One `callApi(method, path, { query, body, raw })`:
- Sends header `X-Pmux-Token: <token>`; JSON body → also `Content-Type: application/json`.
- Success: parse JSON when `content-type` includes `json`; raw/binary path for screenshot bytes; text for api-guide.
- Non-2xx: try JSON → text → empty; throw a structured MCP tool error preserving `status` +
  server `error` + any of `validPanelTypes`, `suggestedCommand`, provider metadata, `Allow`.

**Status → error mapping (from Stage 1 §3):**

| Status | Handling |
|---|---|
| 400 | invalid request; surface raw server `error` (e.g. `Tab is not a web-browser panel`, missing-field) and `validPanelTypes` when present (panelType case) |
| 403 | auth failure; guidance points at `PMUX_TOKEN` / `~/.purplemux/cli-token` (source-aware); **no token contents**; next call auto-recovers (per-call resolution) |
| 404 | not found / body unavailable; include `error` |
| 405 | method error; include `Allow` (implementation bug signal) |
| 409 | typed conflict; always include `error`. `provider metadata` + `suggestedCommand` exist **only** on `tab create`'s `agent-not-installed`/`agent-path-missing`; other 409 families (`Tab session is not running`, `Browser tab not attached yet`, capture/eval error text) carry only `error` — read fields defensively. **Mark `Browser tab not attached yet` transient/retryable** |
| 500 | purplemux internal (create/pane) failure; include `error` |
| 503 | Electron browser bridge unavailable; **hard failure, not retryable** |
| ECONNREFUSED | "purplemux server not running or port changed"; include resolved port + source |

## 3. Tool set (16) — `src/tools.ts` + `src/schemas.ts`

All map to the HTTP surface in `docs/01-cli-features.md §2`. `*` required.

| Tool | HTTP | Inputs | Output |
|---|---|---|---|
| `pmux_list_workspaces` | `GET /api/cli/workspaces` | — | `{workspaces:[{id,name,directories}]}` |
| `pmux_list_tabs` | `GET /api/cli/tabs[?workspaceId]` | `workspaceId?` | `{tabs:[…]}` (cross-workspace if omitted) |
| `pmux_create_tab` | `POST /api/cli/tabs` | `workspaceId*`,`name?`,`panelType?`(enum,default terminal) | created-tab obj |
| `pmux_get_tab` | `GET /api/cli/tabs/<id>?workspaceId` | `workspaceId*`,`tabId*` | tab-info obj |
| `pmux_send_input` | `POST …/send?workspaceId` | `workspaceId*`,`tabId*`,`content*` | `{status:"sent"}` — **strip one trailing `\n`; never append** |
| `pmux_tab_status` | `GET …/status?workspaceId` | `workspaceId*`,`tabId*` | status obj — **doc: browser `alive:false` is normal**; `claudeSessionId`≡`agentSessionId` |
| `pmux_capture_pane` | `GET …/result?workspaceId` | `workspaceId*`,`tabId*` | `{content}` |
| `pmux_close_tab` | `DELETE …?workspaceId` | `workspaceId*`,`tabId*` | `{ok:boolean}` (real body, not just HTTP status) |
| `pmux_browser_url` | `GET …/browser/url?workspaceId` | `workspaceId*`,`tabId*` | `{tabId,url,title}` |
| `pmux_browser_screenshot` | `GET …/browser/screenshot?workspaceId[&full][&format=base64]` | `workspaceId*`,`tabId*`,`full?`,`savePath?` | **default:** request `format=base64`, return MCP image content (read the base64 defensively — server shape may be `{tabId,format:"png",base64}` or `{base64}`). **`savePath` set:** request **raw** (no `format=base64`) `image/png` bytes and the **MCP server itself** `fs.writeFile`s them, returning `{saved,bytes}` (there is no server-side save param) |
| `pmux_browser_console` | `GET …/browser/console?workspaceId` | `workspaceId*`,`tabId*`,`since?`,`level?` | `{tabId,entries[]}` (≤500) |
| `pmux_browser_network` | `GET …/browser/network?workspaceId` | `workspaceId*`,`tabId*`,`since?`,`method?`,`url?`,`status?` | `{tabId,entries[]}` (≤500) |
| `pmux_browser_network_body` | `GET …/browser/network?workspaceId&requestId` | `workspaceId*`,`tabId*`,`requestId*` | `{tabId,requestId,body}` |
| `pmux_browser_eval` | `POST …/browser/eval?workspaceId` | `workspaceId*`,`tabId*`,`expression*` | `{tabId,value}` (CDP 10s) |
| `pmux_api_guide` | `GET /api/cli/api-guide` | — | markdown text content |
| `pmux_connection_info` | *(local)* | — | `{baseUrl?,portSource,tokenSource,hasToken}` — **never the token**; when port/token missing, returns **partial diagnostics** (source=`none`, `hasToken:false`), not a tool error |

Every tool description should note the relevant Stage-1 caveat inline (send auto-submit,
browser Electron-only 503, 409 transient attach, ring-buffer 500, panelType enum).

**Excluded (Stage 1 §5):** `help` (static text), `memory`/`mem` (dead — no route), `start`
(boots the app; the MCP server connects to an already-running purplemux).

## 4. Repo layout & package (`src/`)

```
package.json      # "type":"module", bin: purplemux-mcp -> dist/index.js; deps: @modelcontextprotocol/sdk, zod; scripts: build/typecheck/test
tsconfig.json     # NodeNext, strict, outDir dist
src/index.ts      # SDK stdio server bootstrap + registerAll(tools)
src/config.ts     # per-call port/token resolution + sources
src/http.ts       # callApi + response decoding
src/errors.ts     # status→error mapping helpers
src/schemas.ts    # zod input schemas + panelType enum
src/tools.ts      # 16 tool definitions -> callApi
test/             # unit (config/http/errors/newline) + live e2e (Stage 5)
```

## 5. Registration (Stage 5)

```bash
# Claude Code
claude mcp add purplemux -- node ~/workspace/purplemux-mcp/dist/index.js
# Codex
codex  mcp add purplemux -- node ~/workspace/purplemux-mcp/dist/index.js
```
PORT/TOKEN are auto-read from `~/.purplemux/{port,cli-token}`, so no `-e` needed on this host;
`-e PMUX_PORT=… -e PMUX_TOKEN=…` supported for overrides. Config shapes:

```json
// Claude ~/.claude.json (mcpServers)
{ "purplemux": { "command": "node", "args": ["…/dist/index.js"] } }
```
```toml
# Codex ~/.codex/config.toml
[mcp_servers.purplemux]
command = "node"
args = ["…/dist/index.js"]
```

## 6. Stage 5 test checklist

1. Config precedence (env beats file) + clear missing-port/token errors.
2. Per-call re-read: changed port/token file affects next call without restart.
3. HTTP wrapper: headers, JSON/text/binary, ECONNREFUSED.
4. Error mapping 400/403/404/405/409/500/503 preserving `validPanelTypes`/`suggestedCommand`.
5. Each tool → exact Stage-1 method/path/query/body.
6. `pmux_send_input` strips exactly one trailing `\n`, preserves other whitespace; **live: no-newline content still executes**.
7. Browser transient (409 attach) vs hard (503) distinction.
8. Screenshot: image content (base64) vs `{saved,bytes}` (savePath).
9. `pmux_connection_info` never leaks token.
10. Live e2e against running server: create→send→capture→close round-trip; `tab close` real `{ok}`.

*Panel drafts: `docs/panel/stage2/agent{1,2,3}-design.md`.*
