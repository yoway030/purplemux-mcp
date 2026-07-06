# Stage 2 · Agent 1 (Sonnet) Design — purplemux MCP Server

Recommendations only, one choice per decision point, based solely on `docs/01-cli-features.md`.

## 1. Runtime/language

**Node + TypeScript, official `@modelcontextprotocol/sdk`.** purplemux is Node-native (same
ecosystem, same `fetch`, no cross-language IPC), and the official SDK gives correct MCP
framing/lifecycle/schema validation for free instead of hand-rolling JSON-RPC. Python would add
a second runtime dependency for a tool whose target is already a Node CLI's user.

**Build step: yes, but invisible to the caller.** Author in TS, compile to `dist/index.js` with
`tsc` at publish/CI time (Stage 3), ship compiled JS in the package. End users never run `tsc`.
Launch command is a plain `node` invocation (or a `bin` shim), so `claude mcp add` / `codex mcp
add` just need a path/command — no on-the-fly compilation, no ts-node in production.

```json
"bin": { "purplemux-mcp": "dist/index.js" }
```
with `#!/usr/bin/env node` shebang — makes it runnable both as `npx purplemux-mcp` and as a
locally-installed binary.

## 2. Transport

**stdio — confirmed.** Both `claude mcp add` and `codex mcp add` default to launching a local
subprocess over stdio; no need for HTTP/SSE transport since this server always runs on the same
machine as purplemux (`localhost` only, per §1 of the extraction doc). Use
`StdioServerTransport` from the SDK.

## 3. Config/auth resolution

**Resolve PORT/TOKEN once at process start, matching the CLI's own model, with a cheap re-check
on failure — not per-call file reads on the happy path.**

- Resolution order identical to `cli.js`: `PMUX_PORT` env → `~/.purplemux/port` (trimmed, empty
  → null); `PMUX_TOKEN` env → `~/.purplemux/cli-token`.
- Read once and cache at server startup (mirrors CLI's "read once at module load"; avoids a
  filesystem stat on every tool call).
- **On any request failure that could indicate a stale value** — `ECONNREFUSED`/`ECONNRESET`
  (port changed / server restarted) or **403** (token rotated) — invalidate the cache, re-read
  `~/.purplemux/{port,cli-token}` (env vars are static so recheck those first if unset there),
  retry the request **once** transparently. If the retry also fails, surface a clear MCP error
  (see §4) rather than looping.
- If neither env nor file resolves PORT/TOKEN at startup, don't crash the whole server — start
  it, but have every tool call return a structured error ("purplemux server not detected — set
  PMUX_PORT/PMUX_TOKEN or start purplemux") rather than the process dying silently before the
  MCP handshake completes.

## 4. HTTP client + error mapping

**Thin shared client, direct `fetch` to `http://localhost:${PORT}/api/cli/...`,
`X-Pmux-Token` header on every call, `Content-Type: application/json` for JSON bodies.**

Error mapping — every tool funnels non-2xx / network errors through one translator that raises
an MCP tool error (`isError: true` content) with a structured, LLM-readable message:

| Condition | Surfaced as |
|---|---|
| `ECONNREFUSED` / fetch throws | "purplemux server not reachable at localhost:PORT — is it running?" (triggers the re-resolve-and-retry from §3) |
| 403 | "Forbidden — token invalid/stale" + re-check `~/.purplemux/cli-token` |
| 400 (`Invalid panelType`) | passthrough `error` **and** `validPanelTypes` array verbatim so the caller/LLM can self-correct |
| 404 | passthrough `error` (`Workspace not found` / `Tab not found` / `Response body unavailable`) |
| 405 | internal bug (wrong method in our own client) — log, don't expose as user-actionable |
| 409 | passthrough `error`; if body includes `suggestedCommand`/provider metadata (agent-not-installed), pass that through verbatim — it's actionable guidance for the calling agent |
| 500 / 503 | passthrough `error` as-is (503 browser-bridge case should hint "Electron-only, not headless") |

Never invent new error text — always forward the server's `error` string plus any extra fields
(`validPanelTypes`, `suggestedCommand`) so the calling LLM sees the same detail a human CLI user
would.

**Screenshots:** request `format=base64` from the server (not raw `image/png`, not file mode by
default) and return an MCP **`image` content block** (`type: "image", data: base64, mimeType:
"image/png"`) — this is the one place MCP has a native richer type than raw JSON, so use it
instead of stuffing base64 into a text/JSON field. Still accept an optional `savePath` input that
maps to the CLI's `-o FILE` disk-save mode for callers who explicitly want a file instead
(returns `{saved, bytes}` as plain JSON in that case).

**`api-guide`:** return the markdown as plain MCP **text** content, unmodified — it's
self-documentation, not something to restructure.

## 5. Final tool list (15 + 1 optional)

Shared conventions: `workspaceId`/`tabId` strings; `content`/`expression` exact strings (no
argv-splitting — this is one of the main reasons to go HTTP-direct per the extraction doc).

| Tool | Required in | Optional in | Output |
|---|---|---|---|
| `pmux_list_workspaces` | — | — | `{ workspaces:[{id,name,directories}] }` |
| `pmux_list_tabs` | — | `workspaceId` | `{ tabs:[…] }` |
| `pmux_create_tab` | `workspaceId` | `name`, `panelType` (enum: terminal\|claude-code\|codex-cli\|agent-sessions\|web-browser\|diff, default `terminal`) | created-tab object |
| `pmux_get_tab` | `workspaceId`, `tabId` | — | tab-info object |
| `pmux_send_input` | `workspaceId`, `tabId`, `content` | — | `{ status:"sent" }` |
| `pmux_tab_status` | `workspaceId`, `tabId` | — | status object (`agentSessionId`; `claudeSessionId` documented as legacy alias, same value — don't model as independent) |
| `pmux_capture_pane` | `workspaceId`, `tabId` | — | `{ content }` |
| `pmux_close_tab` | `workspaceId`, `tabId` | — | `{ ok: boolean }` (real body, not the CLI's hardcoded `ok`) |
| `pmux_browser_url` | `workspaceId`, `tabId` | — | `{ tabId, url, title }` |
| `pmux_browser_screenshot` | `workspaceId`, `tabId` | `full` (bool), `savePath` | MCP image content, or `{saved,bytes}` if `savePath` set |
| `pmux_browser_console` | `workspaceId`, `tabId` | `since`, `level` | `{ entries[] }` (≤500) |
| `pmux_browser_network` | `workspaceId`, `tabId` | `since`, `method`, `url`, `status` | `{ entries[] }` (≤500) |
| `pmux_browser_network_body` | `workspaceId`, `tabId`, `requestId` | — | `{ requestId, body }` |
| `pmux_browser_eval` | `workspaceId`, `tabId`, `expression` | — | `{ value }` (10s CDP timeout, surfaced as-is if exceeded → 409) |
| `pmux_api_guide` | — | — | markdown text |
| `pmux_connection_info` *(optional, recommend include)* | — | — | `{ baseUrl, portSource: "env"\|"file", tokenPresent: boolean }` — **never** the token value itself |

Include `pmux_connection_info`: it's cheap to build and is exactly the diagnostic an LLM needs
before blaming itself for a 403/ECONNREFUSED it can't otherwise introspect.

**`send` trailing-newline rule (critical, empirically confirmed):** the server auto-submits via
bracketed paste + its own Enter keypresses. `pmux_send_input` must **strip exactly one trailing
`\n` (or `\r\n`) from `content`** before sending, and must **never append its own newline**. This
avoids relying on the caller to know the server auto-submits, while not risking a
double-Enter for callers who did remember not to add one (idempotent either way).

## 6. Registration

**Claude Code:**
```bash
claude mcp add purplemux -- npx -y purplemux-mcp
```
or, for a locally-cloned/dev build:
```bash
claude mcp add purplemux -- node /path/to/purplemux-mcp/dist/index.js
```

**Codex:**
```bash
codex mcp add purplemux -- npx -y purplemux-mcp
```
Codex config equivalent (`~/.codex/config.toml`):
```toml
[mcp_servers.purplemux]
command = "npx"
args = ["-y", "purplemux-mcp"]
```

Neither registration needs `env` entries by default — the server inherits `PMUX_PORT`/
`PMUX_TOKEN` from the parent shell if set, and otherwise falls back to `~/.purplemux/*` files
exactly like the CLI. Document both env-var and file-based setups in the README since most users
will rely on the auto-generated `~/.purplemux/cli-token` file and never set env vars at all.

## 7. Repo/package layout

```
purplemux-mcp/
  package.json                # bin: dist/index.js; deps: @modelcontextprotocol/sdk
  tsconfig.json
  src/
    index.ts                  # server bootstrap, stdio transport, tool registration
    config.ts                 # PORT/TOKEN resolution + cache/invalidate (§3)
    httpClient.ts              # fetch wrapper, X-Pmux-Token header, error→MCP mapping (§4)
    errors.ts                  # translator: HTTP status + body -> MCP tool error content
    tools/
      workspaces.ts             # pmux_list_workspaces
      tabs.ts                   # list/create/get/status/send/close/capture
      browser.ts                # url/screenshot/console/network/network_body/eval
      apiGuide.ts               # pmux_api_guide
      connectionInfo.ts         # pmux_connection_info
    schemas.ts                  # zod (or SDK-native) input schemas per tool, incl. panelType enum
  test/
    unit/                       # error-mapping table, send-newline normalization, config resolution
    integration/                # against a live purplemux instance (or a lightweight mock HTTP server)
  docs/                         # (existing stage1/stage2 docs)
  README.md                     # registration commands from §6, env var reference
```

**Stage 3 build:** `npm run build` = `tsc -p tsconfig.json` → `dist/`; `prepublishOnly` runs
build so `npm publish` / `npx` always serve compiled JS; no runtime TS transpilation.

**Stage 5 tests must cover:**
1. Config resolution precedence (env vs file vs missing → both orders for PORT and TOKEN).
2. Cache invalidation + single retry on 403 and on `ECONNREFUSED`, and clean failure after retry
   also fails (no infinite loop).
3. Full HTTP status/error-mapping table (§4) — one test per status code including the extra
   passthrough fields (`validPanelTypes`, `suggestedCommand`, `Allow` header not leaked to user).
4. `pmux_send_input` newline normalization (`"foo\n"` → sent as `"foo"`; `"foo"` → unchanged;
   `"foo\r\n"` → `"foo"`).
5. `panelType` enum validation client-side mirrors server's 6 values + default `terminal`.
6. `tab close` returns the *real* `{ok}` body, not a hardcoded truthy value (regression test for
   the CLI bug this MCP must not repeat).
7. Screenshot: `format=base64` request produces MCP image content; `savePath` path produces
   `{saved,bytes}` JSON instead.
8. `agentSessionId`/`claudeSessionId` alias: schema doesn't require both, tolerates either
   present.
9. Integration smoke test against a real (or faithfully mocked) purplemux server for at least
   `list_workspaces` → `create_tab` → `send_input` → `capture_pane` → `close_tab` round trip.
