# Stage 2 · Agent 2 (Opus) — purplemux MCP Server Design

Scope: one recommended choice per decision, grounded in `docs/01-cli-features.md`.
The server is a **thin HTTP proxy** to purplemux's localhost API (never shells out to
`purplemux` — avoids `stripFlags`/argv-join quirks and recovers discarded bodies, e.g.
`tab close`).

---

## 1. Runtime / language — **Node + TypeScript, official `@modelcontextprotocol/sdk`**
Rationale: purplemux is already Node ≥ 20, so the toolchain is present; the official SDK
gives correct stdio framing, schema validation, and image content types for free.

- **Build step: yes, acceptable** — `tsc` → `dist/index.js` with a `#!/usr/bin/env node`
  shebang and a `bin` entry. Ship compiled JS so end users launch with zero dev deps.
- **Launch:** primary = `npx -y purplemux-mcp` (works before/after publish via the `bin`);
  local/dev = `node /abs/dist/index.js` or `tsx src/index.ts`. All three are one-liners for
  `claude mcp add` / `codex mcp add`. Recommend `npx` in docs, `node dist` for pinned installs.
- No native deps: use the built-in `fetch` (Node ≥ 20) — no axios/undici to bundle.

## 2. Transport — **stdio (confirmed)**
Rationale: both Claude Code and Codex spawn stdio MCP servers as child processes; the server
is single-user, localhost, no network listener needed. `StdioServerTransport` from the SDK.
Do **not** write logs to stdout (corrupts JSON-RPC) — all diagnostics go to stderr.

## 3. Config / auth resolution — **lazy, re-read per call, no long-lived cache**
Resolve exactly as the CLI (§1): `PMUX_PORT` env → `~/.purplemux/port` (trim; empty→null);
`PMUX_TOKEN` env → `~/.purplemux/cli-token`. Header `X-Pmux-Token` on every request.

- **When:** resolve on the MCP `initialize` handshake *do not fail hard* — a missing
  port/token at startup must not crash the server (the purplemux app may boot later).
  Instead resolve **per tool call** and cache for a short TTL (~2 s) to avoid re-reading the
  file on every request in a burst, but always re-read after any failure.
- **Restart / port change:** because we re-read the file (not a startup snapshot), a server
  restart that rewrites `~/.purplemux/port` is picked up on the next call automatically —
  this is the key reason to re-read rather than snapshot-at-load like the CLI does.
- **403 handling:** invalidate the cached token immediately, re-read the file once, retry
  **once**; if still 403 return a typed error telling the user to check
  `PMUX_TOKEN`/`~/.purplemux/cli-token` (never echo the token value).
- **Missing PORT/TOKEN:** return a clean MCP error ("purplemux server not running? PMUX_PORT
  unset and ~/.purplemux/port missing"), not a thrown exception.

## 4. HTTP client + error mapping — **one shared `callApi()` + typed error table**
Single helper does: resolve config → build URL → `fetch` → branch on status/content-type.

- **Success JSON:** return as MCP text content (JSON-stringified) so agents can parse it.
- **Screenshot:** always request `format=base64` (JSON) unless `savePath` is given; return an
  **MCP image content block** (`{ type:"image", data:<base64>, mimeType:"image/png" }`) so the
  model can actually see it. `savePath` mode → return `{saved,bytes}` text only. Never request
  the raw `image/png` byte stream over stdio — base64→image block is the MCP-native path.
- **api-guide:** `text/markdown` → return as text content verbatim.
- **Error status → MCP tool error** (`isError:true`), message built from the server's own
  `error` field plus any structured hints, so the model can self-correct:

| HTTP | Surface as | Extra fields to include |
|---|---|---|
| 400 | `Bad request: <error>` | `validPanelTypes` (bad panelType), field-required msgs |
| 403 | `Forbidden — check PMUX_TOKEN / ~/.purplemux/cli-token` | (retry-once first, §3) |
| 404 | `Not found: <error>` | Workspace/Tab/Response-body-unavailable |
| 405 | `Method not allowed` | `Allow` header (internal bug guard) |
| 409 | `Conflict: <error>` | `suggestedCommand` (agent-not-installed), browser tiers |
| 500 | `Server error: <error>` | — |
| 503 | `Browser unavailable (Electron-only feature)` | mark non-retryable |
| ECONNREFUSED | `purplemux server not reachable at <baseUrl> — is it running?` | — |

Browser retry nuance: **409 "not attached yet"** is transient (advise retry / brief backoff);
**503** is hard (don't retry). Encode this hint in the message, don't auto-loop.

## 5. Final tool list — **15 canonical tools + `pmux_connection_info` (16th, recommended)**
Include the diagnostic tool: it's read-only, cheap, and the fastest way for an agent to
self-diagnose "is the server even up / which port" without leaking the token.

Names/inputs/outputs exactly per §5 of the canonical doc. Two behavioral rules baked in:
- **`pmux_send_input`**: strip **one** trailing `\n` from `content` by default (the server
  auto-submits via bracketed paste + Enter; appending our own newline risks a double-submit).
  Expose an optional `submit` boolean later if needed, but default = strip-one-trailing-`\n`.
  Document in the tool description: "content is auto-submitted; do not add a trailing newline".
- **`pmux_tab_status`**: description must warn `alive:false` is **normal for `web-browser`
  tabs** (Electron webviews, not tmux) — probe browser health via the browser tools instead.
- `pmux_close_tab` returns the **real `{ok:boolean}`** (not the CLI's always-`ok` string).
- Model `claudeSessionId` as a legacy alias of `agentSessionId` — pass through, don't split.
- Screenshot/eval enriched shapes (`{tabId,format,base64}` / `{tabId,value}`) are read
  **defensively** (may differ in headless) — return whatever the server sends.

Tools: `pmux_list_workspaces`, `pmux_list_tabs`, `pmux_create_tab`, `pmux_get_tab`,
`pmux_send_input`, `pmux_tab_status`, `pmux_capture_pane`, `pmux_close_tab`,
`pmux_browser_url`, `pmux_browser_screenshot`, `pmux_browser_console`,
`pmux_browser_network`, `pmux_browser_network_body`, `pmux_browser_eval`,
`pmux_api_guide`, + `pmux_connection_info`.

## 6. Registration commands
**Claude Code:**
```bash
claude mcp add purplemux -- npx -y purplemux-mcp
# or pinned local build:
claude mcp add purplemux -- node /abs/path/purplemux-mcp/dist/index.js
# pass config only if not using ~/.purplemux files:
claude mcp add purplemux -e PMUX_PORT=16500 -- npx -y purplemux-mcp
```
`~/.claude.json` (project or user scope) snippet:
```json
{ "mcpServers": { "purplemux": {
  "command": "npx", "args": ["-y", "purplemux-mcp"], "env": {} } } }
```
**Codex:**
```bash
codex mcp add purplemux -- npx -y purplemux-mcp
```
`~/.codex/config.toml` snippet:
```toml
[mcp_servers.purplemux]
command = "npx"
args = ["-y", "purplemux-mcp"]
# env = { PMUX_PORT = "16500" }
```
Both consume stdio; no transport flags needed. Env is optional because config resolves from
`~/.purplemux/{port,cli-token}` by default.

## 7. Repo / package layout + Stage 3 build + Stage 5 tests
```
purplemux-mcp/
  package.json          # "bin": {"purplemux-mcp":"dist/index.js"}, type:module, engines>=20
  tsconfig.json         # target ES2022, module NodeNext, outDir dist
  src/
    index.ts            # StdioServerTransport bootstrap, server metadata
    config.ts           # resolvePort/resolveToken (env → ~/.purplemux/*), TTL cache
    http.ts             # callApi(): fetch + status→typed-error mapping, ECONNREFUSED
    errors.ts           # PmuxApiError, message builders (validPanelTypes/suggestedCommand)
    tools/              # one module per tool group (workspaces, tabs, browser, meta)
    schemas.ts          # zod input schemas (shared workspaceId/tabId)
  test/
    unit/               # mocked fetch
    e2e/                # live server (PMUX_PORT=16500)
  README.md             # the §6 registration commands
```
**Stage 3 builds it as:** implement `config.ts`+`http.ts` first (the risk core), then register
the 16 tools via the SDK using zod schemas, then `tsc` build + shebang + `chmod +x dist`.

**Stage 5 tests must cover:**
- *Unit (mocked fetch):* config precedence (env vs file, empty→null); the send trailing-`\n`
  strip rule; each HTTP status → correct typed error incl. `validPanelTypes`/`suggestedCommand`
  passthrough; screenshot base64 → MCP image block; api-guide → text; 403 retry-once-then-fail;
  ECONNREFUSED message; `close_tab` real boolean; `alive:false` not treated as error.
- *Live e2e (against running server, port 16500):* `list_workspaces` → `create_tab` (terminal)
  → `send_input` (verify no double-submit) → `capture_pane`/`tab_status` → `close_tab` (real
  `ok`); bad `panelType` → 400 `validPanelTypes`; browser cmd on terminal tab → 400
  "not a web-browser panel"; `api_guide` returns markdown; `connection_info` reports port
  source without token. Browser image/eval e2e only where an Electron runtime is available;
  otherwise assert the 503/409 typed errors.
