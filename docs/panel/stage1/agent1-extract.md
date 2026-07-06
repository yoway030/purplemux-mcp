# purplemux CLI — Exhaustive Feature Extraction (Agent 1 / Claude Sonnet)

Sources read in full:
- `docs/_source/purplemux.js` (34 lines) — bin entry point / command router
- `docs/_source/cli.js` (323 lines) — actual CLI implementation
- `docs/_source/api-guide.txt` (73 lines) — HTTP API reference text served by `purplemux api-guide`
- `docs/_source/help.txt`, `docs/_source/runtime-env.txt`, `docs/_source/package.json`
- Installed package `~/.npm-global/lib/node_modules/purplemux` (v0.3.2, confirmed byte-identical `bin/cli.js` and `bin/purplemux.js` vs `docs/_source` via `diff`). I additionally dug into the compiled Next.js route handlers under
  `.next/standalone/.next/server/pages/api/cli/**` and their shared chunks under
  `.next/standalone/.next/server/chunks/*.js` to confirm exact server-side status codes, error strings, and defaults that are not visible from the CLI/api-guide text alone. These files are turbopack-minified bundles with no meaningful line numbers, so those citations are given as `chunk:<filename>` instead of `file:line`.

---

## 1. Entry point & command routing

`bin/purplemux.js` (= `docs/_source/purplemux.js`):

- purplemux.js:5 — sets `process.env.PURPLEMUX_CLI = '1'` unconditionally.
- purplemux.js:7-9 — snapshots the pristine env into `__PMUX_PRISTINE_ENV` once (only if unset).
- purplemux.js:13-15 — `CLI_COMMANDS = new Set(['workspaces', 'tab', 'memory', 'mem', 'api-guide', 'help'])`.
- purplemux.js:17-21 — fires `update-notifier` (best-effort, errors swallowed) using the package's own `package.json`.
- purplemux.js:23-34 — routing logic:
  - `argv[2]` (`cmd`) is read.
  - If `cmd` is truthy **and** in `CLI_COMMANDS` → `require('./cli.js')` (delegates entirely to cli.js's own arg parsing, which re-reads `process.argv.slice(2)`).
  - Else if `cmd` is falsy or `cmd === 'start'` → sets `NODE_ENV=production` (if unset) and `__PMUX_APP_DIR`, then `require('../dist/server.js')` — this launches the actual purplemux server/app (Electron or headless Next.js server), **not** part of this CLI wrapper's scope.
  - Else → prints `unknown command: <cmd>` to stderr and `process.exit(1)`.

**Discrepancy (explicitly called out per task item 5):** `CLI_COMMANDS` includes `'memory'` and `'mem'` (purplemux.js:14), so `purplemux memory ...` / `purplemux mem ...` are routed into `cli.js`. However `cli.js`'s `main()` switch (cli.js:295-318) only handles `'workspaces'`, `'tab'`, `'api-guide'`, `'help'`/`-h`/`--help` — there is **no `case 'memory'` or `case 'mem'`**. Falling through to `default` (cli.js:316-317) prints `unknown command: memory. Run 'purplemux help' for usage.` and exits 1. I confirmed via the compiled server bundle that there is also **no `/api/cli/memory` (or `/api/cli/mem`) route anywhere** in `.next/standalone/.next/server/pages/api/cli/**` — the feature is entirely absent server-side too. Conclusion: `memory`/`mem` are dead/reserved command names — present in the router's allow-list but wired to nothing. An MCP tool should **not** be built for this; at most, note it as a stub for future purplemux versions.

---

## 2. Auth & connection model (task item 3)

cli.js:1-21:
```
const PORT = process.env.PMUX_PORT || readFileOrNull(path.join(os.homedir(), '.purplemux', 'port'));
const TOKEN = process.env.PMUX_TOKEN || readFileOrNull(path.join(os.homedir(), '.purplemux', 'cli-token'));
const BASE = `http://localhost:${PORT}`;
```
- **PORT resolution**: `PMUX_PORT` env var, else contents of `~/.purplemux/port` (trimmed; empty string treated as `null`). Confirmed by `runtime-env.txt:1`: `PMUX_PORT=16500` is what the running server actually wrote for this machine.
- **TOKEN resolution**: `PMUX_TOKEN` env var, else contents of `~/.purplemux/cli-token`.
- **Base URL**: always `http://localhost:${PORT}` — CLI only ever talks to localhost, never a remote host.
- `requireEnv()` (cli.js:28-31) is called at the top of every command handler except `api-guide` fetch path (which calls it too, cli.js:231) and dies with distinct messages if PORT or TOKEN is missing: `error: PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)` / same for token. Exit code 1.
- **Header**: every request sends `X-Pmux-Token: <TOKEN>` (cli.js:41, cli.js:59). api-guide.txt:3 documents the canonical lower-case form `x-pmux-token`; both cases work since HTTP headers are case-insensitive and the server reads `e.headers["x-pmux-token"]` (Node/Next normalizes header names to lowercase).
- Also sends `Content-Type: application/json` on JSON-bodied requests (cli.js:41).
- **Server-side token verification** (found in compiled bundle, e.g. `chunk:[root-of-the-server]__0mky_tj._.js`, `chunk:_04wz5fx._.js`, and every route handler): `verifyCliToken(req)`:
  - Reads `req.headers['x-pmux-token']`; if absent/non-string → `false`.
  - Lazily resolves the expected token: checks in-process cache `globalThis.__ptCliToken`; else reads `~/.purplemux/cli-token`; **if the file doesn't exist, the server auto-generates one** via `crypto.randomBytes(32).toString('hex')`, writes it to `~/.purplemux/cli-token` with file mode `384` (octal `0600`), and caches it.
  - Compares using `timingSafeEqual` (constant-time) after a length check — standard token-auth hardening.
  - On failure, **every** `/api/cli/*` route returns `HTTP 403 { "error": "Forbidden" }` (confirmed identically across workspaces/tabs/send/status/result/browser-* handlers).
- **Method mismatches**: routes that only support one HTTP verb return `405 { "error": "Method not allowed" }` with an `Allow` response header (e.g. send.js requires POST, status.js/result.js require GET, `[tabId].js` allows `GET, DELETE`).

---

## 3. Commands — exact CLI surface

All commands go through `main()` in cli.js:289-319, dispatching on `argv[2]` (cmd) and `argv[3]` (sub-command for `tab`). Output is always `JSON.stringify(body, null, 2)` to stdout (helper `out()`, cli.js:33-35) except: `tab close` prints literal `ok\n` on success (cli.js:158, no JSON body printed even though the server does return a JSON body `{ok: <bool>}` — the CLI discards it); `api-guide` prints raw markdown/text (not JSON).

Flag parsing helpers:
- `flagValue(args, name)` (cli.js:239-243): finds `name` in `args`, returns the **next token** verbatim (no `=` syntax support, e.g. `--type=foo` will NOT work — must be `--type foo`).
- `stripFlags(args, names)` (cli.js:245-257): removes each named flag **and its following token** (assumes every flag in `names` takes a value — this is important: `--full` is a boolean flag but when it appears in `stripFlags` calls (cmdTabBrowser only) it must be positioned so consumption is symmetric; in practice `--full` has no argument value consumed by `flagValue`, it's checked via `args.includes('--full')`, cli.js:179, but `stripFlags` (cli.js:164) also lists `--full` among the flags-with-values it strips, meaning **whatever token immediately follows `--full` on the command line is silently swallowed** as if it were `--full`'s value. This is a real CLI quirk/bug: `tab browser screenshot -w WS TABID --full` works, but `tab browser screenshot -w WS --full TABID` would eat `TABID` as `--full`'s "value" and misparse. Recommend documenting `--full` as **must come after the positional tab ID**, or better: MCP tool should always place `--full` last.)

### 3.1 `purplemux workspaces`
- Syntax: `purplemux workspaces` (no args parsed at all; cli.js:296-297 → `cmdWorkspaces()`, cli.js:72-76).
- HTTP: `GET /api/cli/workspaces` (cli.js:74; api-guide.txt:7-8).
- Response: `{ "workspaces": [{ "id", "name", "directories": [...] }] }` — confirmed exactly in compiled handler (`chunk:_04wz5fx._.js`): `r.map(e=>({id:e.id,name:e.name,directories:e.directories}))`.
- No auth/param errors beyond the global 403 (bad/missing token).

### 3.2 `purplemux tab list [-w WS | --workspace WS]`
- cli.js:300 → `cmdTabList(rest)` (cli.js:78-84).
- `wsId` optional; if present, query string `?workspaceId=<encoded>`, else no query.
- HTTP: `GET /api/cli/tabs[?workspaceId=WS]` (cli.js:82; api-guide.txt:12-14).
- **Cross-workspace listing (task item 5)**: confirmed in compiled handler (`chunk:[root-of-the-server]__0qslqkf._.js`): when `workspaceId` query param is absent, server does `(await getWorkspaces()).workspaces.map(e=>e.id)` and iterates **every** workspace, collecting tabs from all of them via `collectPanes` over each workspace's layout tree. When present, it scopes to `[workspaceId]` only (single-element loop) — and silently `continue`s (returns nothing, no error) if that workspace id doesn't exist (`if(!await getWorkspaceById(e)) continue`). So `tab list -w bogus-id` returns `{"tabs":[]}`, not a 404.
- Response per tab: `{ "tabId", "workspaceId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId" }` (api-guide.txt:14, confirmed in bundle). `agentProviderId`/`agentSessionId` are `null` when the tab's panelType has no registered provider (e.g. plain `terminal`, `web-browser`, `diff`) — only `claude-code`/`codex-cli` panels resolve a provider.

### 3.3 `purplemux tab create -w WS [-n NAME] [-t TYPE]`
- cli.js:301 → `cmdTabCreate(rest)` (cli.js:86-98).
- Required: `-w`/`--workspace WS`. Missing → client-side `die('--workspace is required')`, exit 1, **no HTTP call made**.
- Optional: `-n`/`--name NAME`, `-t`/`--type TYPE` (panelType).
- HTTP: `POST /api/cli/tabs` with body `{ workspaceId, name?, panelType? }` (cli.js:92-96; api-guide.txt:16-20).
- **Server-side validation order** (confirmed in `chunk:[root-of-the-server]__0qslqkf._.js`):
  1. `!workspaceId` → `400 { error: "workspaceId is required" }` (can't actually be hit via the CLI since the CLI already requires `-w`, but relevant for the MCP tool's own body validation / direct API use).
  2. `getWorkspaceById(workspaceId)` fails → `404 { error: "Workspace not found" }`.
  3. `resolveFirstPaneId(workspaceId)` fails (no pane in workspace layout) → `500 { error: "No pane available in workspace" }`.
  4. If `panelType` provided and not in the valid set → `400 { error: "Invalid panelType", validPanelTypes: [...] }`.
  5. **Valid panelType enum** (confirmed exactly): `["terminal", "claude-code", "codex-cli", "agent-sessions", "web-browser", "diff"]`. **Default panelType when omitted is `"terminal"`** (`let u=i||"terminal"`).
  6. `checkAgentAvailabilityForPanelType(panelType)` — only meaningful for `claude-code`/`codex-cli` (looks up a registered provider by panelType; other types have no provider → always `{ok:true, provider:null}`). If the provider's `preflight()` says the CLI binary isn't installed → **409** with `{ error: <code>, providerId, providerDisplayName, panelType, suggestedCommand }` where `code` is `"agent-not-installed"` or (for `claude` specifically, when a custom binary path was expected but missing) `"agent-path-missing"`, and `suggestedCommand` is `"claude"` / `"claude-path"` / `null`.
  7. `addTabToPane(...)` failure → `500 { error: "Failed to create tab" }`.
  8. Success → **201** `{ "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType", "agentProviderId", "agentSessionId" }` (api-guide.txt:20).
- Tabs are always created "in the first pane of the workspace" (api-guide.txt:19; `resolveFirstPaneId`).

### 3.4 `purplemux tab send -w WS TAB_ID CONTENT...`
- cli.js:302 → `cmdTabSend(rest)` (cli.js:106-120).
- Args after stripping `-w`/`--workspace`: `rest[0]` = tabId, `rest.slice(1).join(' ')` = content (so **multi-word unquoted content is rejoined with single spaces** — original inter-word whitespace/newlines from the shell are NOT preserved; only a single ASCII space is reinserted between argv tokens, cli.js:110). Missing tabId → `die('tab ID is required')`; missing content → `die('content is required')`. `-w` missing → `die('--workspace is required')` (via `resolveWsForTab`, cli.js:100-104).
- HTTP: `POST /api/cli/tabs/<tabId>/send?workspaceId=WS` with body `{ content }` (cli.js:114-118; api-guide.txt:29-32).
- **"bracketed-paste send" semantics (task item 5)**: server calls `sendBracketedPaste(tab.sessionName, content)` (confirmed in `chunk:_07g1_zx._.js`) — i.e. content is wrapped in terminal bracketed-paste escape sequences (`ESC[200~ ... ESC[201~`) before being written to the tmux pane's pty. This means the receiving program (shell, Claude Code, Codex CLI, vim, etc.) sees it as a single pasted blob rather than as individually "typed" keystrokes — critical for multi-line content and for programs that react differently to paste vs. type (e.g. auto-indent suppression, or apps that need an Enter keypress to submit). **Implication for MCP tool design**: sending content does not automatically press Enter/submit — bracketed paste alone does not equal pressing return. Callers likely need to include a trailing `\n` in content (or send a separate short "\r"/"\n" send) to submit, though this could not be independently confirmed from source; recommend testing at Stage 2.
- Response: `200 { "status": "sent" }` on success.
- **Error cases**: `400 workspaceId is required` (defense in depth) / `400 content is required` / `404 Tab not found` / **`409 { error: "Tab session is not running" }`** if `hasSession(tab.sessionName)` is false (tmux session died) — confirmed in `chunk:_07g1_zx._.js`.

### 3.5 `purplemux tab status -w WS TAB_ID`
- cli.js:303 → `cmdTabStatus` (cli.js:122-133).
- HTTP: `GET /api/cli/tabs/<tabId>/status?workspaceId=WS` (cli.js:128-131; api-guide.txt:34-35).
- Response shapes (confirmed in `chunk:[root-of-the-server]__0an3.o.._.js`), two variants depending on whether the tmux session is alive:
  - Dead session: `{ tabId, workspaceId, alive: false, agentProviderId, agentSessionId, claudeSessionId }` (no `command`/`cliState` fields).
  - Alive session: `{ tabId, workspaceId, alive: true, command, cliState, agentProviderId, agentSessionId, claudeSessionId }` where `command` = `getPaneCurrentCommand(sessionName)` (the foreground process name in the pane) and `cliState` = `tab.cliState ?? null` (an app-internal state field, e.g. tracking agent CLI lifecycle — exact enum not resolvable from this bundle).
  - `claudeSessionId` is always identical to `agentSessionId` in the current implementation (`d` reused for both) — apparent legacy/back-compat alias; MCP tool should treat them as one field (prefer `agentSessionId`, keep `claudeSessionId` for compatibility with tools expecting the old name).
  - `404 { error: "Tab not found" }` if tab id / workspace mismatch.

### 3.6 `purplemux tab result -w WS TAB_ID`
- cli.js:304 → `cmdTabResult` (cli.js:135-146).
- HTTP: `GET /api/cli/tabs/<tabId>/result?workspaceId=WS` (api-guide.txt:37-39). "Capture the current pane content."
- Response: `200 { "content": "<captured pane text>" }` via `capturePaneContent(sessionName)` (tmux `capture-pane` equivalent — full visible scrollback/viewport snapshot as plain text, ANSI likely stripped or preserved depending on tmux capture flags used internally; not independently verifiable from this bundle without capturePaneContent's source).
- Errors: `404 Tab not found`; **`409 { error: "Tab session is not running" }`** if the tmux session is dead (confirmed `chunk:_0_7my__._.js`) — same semantics as send.

### 3.7 `purplemux tab close -w WS TAB_ID`
- cli.js:305 → `cmdTabClose` (cli.js:148-159).
- HTTP: `DELETE /api/cli/tabs/<tabId>?workspaceId=WS` (api-guide.txt:26-27: "Close the tab (kills tmux session and removes from layout)").
- CLI behavior: only checks `resp.ok` (any 2xx) and prints literal `ok\n` — **discards the actual JSON body**. Server actually returns `200 { "ok": <boolean> }` where the boolean is the result of `removeTabFromPane(...)` (confirmed `chunk:[root-of-the-server]__108dnsu._.js`) — i.e. it is possible to get HTTP 200 with `{"ok": false}` (removal didn't actually find/remove anything) and the current CLI would still print `ok` misleadingly. **MCP tool should read the actual `ok` boolean from the body rather than trusting HTTP status**, to avoid propagating this CLI-level bug.
- Errors: `404 Tab not found`.

### 3.8 `purplemux tab browser <sub> -w WS TAB_ID [...]`
- cli.js:306 → `cmdTabBrowser(rest)` (cli.js:161-228). Sub-command required (`url | screenshot | console | network | eval`); unknown sub → `die('unknown browser subcommand: ...')`.
- **All** browser endpoints share a server-side guard (`withBrowserTab`, confirmed in `chunk:_0rh64c3._.js` and reused by every browser sub-route): 
  1. `workspaceId` missing → `400 { error: "workspaceId is required" }`.
  2. Tab not found → `404 { error: "Tab not found" }`.
  3. **`tab.panelType !== "web-browser"`** → `400 { error: "Tab is not a web-browser panel" }` — i.e. calling any `tab browser *` command against a `terminal`/`claude-code`/etc. tab is a 400, not silently ignored.
  4. `globalThis.__ptBrowserBridge` (set only by the Electron main process when a webview attaches) is `null` → **`503 { error: "Browser bridge unavailable (Electron-only feature)" }`** — this is the exact headless/non-Electron error (task item 4). Confirms api-guide.txt:43-45's "Electron runtime required; 503 is returned in headless/remote mode."

#### 3.8.1 `tab browser url -w WS TAB_ID`
- HTTP: `GET /api/cli/tabs/<tabId>/browser/url?workspaceId=WS` (cli.js:172-176; api-guide.txt:47-49).
- Response: `200 { tabId, url, title }`.
- **dom-ready requirement (task item 5)**: if the webview hasn't fired `dom-ready` yet (`getUrl()` returns `null` internally), server returns **`409 { error: "Browser tab not attached yet" }`** (confirmed `chunk:_0_wofwd._.js`) — distinct from the 503 "no Electron at all" case. So there are two failure modes to model in the MCP tool: 503 = wrong runtime, 409 = right runtime but webview not ready/attached yet (race condition right after `tab create -t web-browser`).

#### 3.8.2 `tab browser screenshot -w WS TAB_ID [-o FILE | --output FILE] [--full]`
- cli.js:177-191.
- If `-o`/`--output FILE` given: does a **raw** (non-JSON) `GET` via `apiRaw()` to `/api/cli/tabs/<tabId>/browser/screenshot?workspaceId=WS&full=<0|1>`, writes the raw PNG bytes to `FILE`, prints `{ saved: FILE, bytes: N }`.
- Else: same path plus `&format=base64`, expects JSON, prints `{ tabId, format: "png", base64: "<...>" }` directly to stdout (confirmed exact response shape in `chunk:_0rh64c3._.js`: `t.status(200).json({tabId:r,format:"png",base64:e})`).
- `--full` flag (boolean, `args.includes('--full')`, cli.js:179) maps to `full=1` query param → `fullPage: true` in the internal `capture()` call — captures beyond the visible viewport (full scrollable page). Default `full=0`/`fullPage:false`.
- **Watch the `stripFlags` quirk** noted in §3 above: `--full` is included in the value-stripping flag list (cli.js:164) even though it takes no value — place `--full` after the positional `TAB_ID` on the command line.
- Errors: standard `withBrowserTab` guard errors (400/404/503) plus **`409 { error: <capture error message> }`** if the internal `capture()` call throws (confirmed `chunk:_0rh64c3._.js` catch block, message is whatever `Error.message` the capture backend produced — not a fixed string).
- When no `-o`, default (non-base64) request path would return raw `image/png` bytes with `Content-Type: image/png` / `Content-Length` headers set (cli.js's `api()` helper would fail to parse this as JSON body since `content-type` isn't `json` — but cli.js always requests `format=base64` in this branch, so raw-binary is only reachable via the `-o FILE` path which uses `apiRaw` and writes bytes directly).

#### 3.8.3 `tab browser console -w WS TAB_ID [--since MS] [--level LEVEL]`
- cli.js:192-201.
- HTTP: `GET /api/cli/tabs/<tabId>/browser/console?workspaceId=WS[&since=MS][&level=LEVEL]`.
- `--since MS`: passed through as-is (not validated client-side); server does `parseInt(since,10)`, falls back to `0` if `!Number.isFinite`. Semantics: only entries with timestamp > `since` (ms epoch, presumably) — i.e. incremental polling cursor.
- `--level LEVEL`: exact string match filter against `entry.level` (confirmed in `chunk:_0y9vgfm._.js`: `s&&(o=o.filter(e=>e.level===s))`) — case-sensitive, no enum validation server-side (so an invalid level like `"warn"` vs `"warning"` just yields empty results, no error).
- Response: `{ tabId, entries: [{ level, text, ts, source?, url?, line? }] }` (api-guide.txt:56-57).
- **Ring buffer**: last 500 entries per tab (api-guide.txt:56 — "Ring buffer (last 500 entries)"). Captures console messages, page `Log` entries, and uncaught exceptions (api-guide.txt:56).

#### 3.8.4 `tab browser network -w WS TAB_ID [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]`
- cli.js:202-217.
- Two distinct modes via the same endpoint, disambiguated server-side by presence of `requestId` query param (confirmed `chunk:_0swnrzn._.js`):
  - **List mode** (no `--request`): `GET .../browser/network?workspaceId=WS[&since=MS][&method=M][&url=SUBSTR][&status=CODE]`. `method` is upper-cased server-side before filtering (`e.query.method.toUpperCase()`); `url` is substring match (`entries.filter(e=>e.url.includes(urlFilter))`); `status` parsed via `parseInt` and exact-matched. Response: `{ tabId, entries: [{ requestId, method, url, status?, mimeType?, resourceType?, error?, ts, endedAt? }] }` (api-guide.txt:61-62). Ring buffer of last 500 requests.
  - **Body-fetch mode** (`--request ID`): `GET .../browser/network?workspaceId=WS&requestId=RID` (note: cli.js sends both `requestId` and any other filters together, but server checks `requestId` first and short-circuits — other filters are ignored in this mode). Calls `getResponseBody(tabId, requestId)`; if `null` → **`404 { error: "Response body unavailable" }`** (e.g., body was never captured, or request too old / evicted from cache); else `200 { tabId, requestId, body }`. api-guide.txt:64-66 notes the body is "cached after first call."

#### 3.8.5 `tab browser eval -w WS TAB_ID EXPR`
- cli.js:218-224. `expression` = `rest.slice(1).join(' ')` (same multi-word-rejoin-with-single-space caveat as `tab send`). Missing → `die('expression is required')`.
- HTTP: `POST /api/cli/tabs/<tabId>/browser/eval?workspaceId=WS` body `{ expression }`.
- Server: also validates `expression` is a non-empty string → `400 { error: "expression is required" }` (defense in depth, confirmed `chunk:_0zym6f2._.js`).
- Evaluates via CDP `Runtime.evaluate` with `returnByValue: true`, `awaitPromise: true`, and a **10-second timeout** (api-guide.txt:70-71).
- Response: `200 { tabId, value: <serialized result> }`.
- Errors: standard guard (400/404/503) plus **`409 { error: <evaluation error message> }`** on JS exceptions / timeout (message is the underlying `Error.message`, not a fixed string) — confirmed `chunk:_0zym6f2._.js`.

### 3.9 `purplemux api-guide`
- cli.js:310-311 → `cmdApiGuide()` (cli.js:230-237).
- HTTP: `GET /api/cli/api-guide` with just the token header (no JSON accept, raw text fetch). Server responds `Content-Type: text/markdown; charset=utf-8` with the full text reproduced in `docs/_source/api-guide.txt` (confirmed `chunk:[root-of-the-server]__0mky_tj._.js`). Requires `requireEnv()` (PORT+TOKEN) same as everything else, then just prints the raw text body + trailing `\n`.
- Only error path: non-2xx HTTP → `die('HTTP <status>')` (no JSON error body parsed on this path, cli.js:235); auth failure still yields the generic `403 Forbidden` JSON but cli.js's `cmdApiGuide` does NOT parse it as JSON (`resp.ok` check only), so on a 403 it would just print `error: HTTP 403` rather than the `Forbidden` message — a minor inconsistency vs other commands' `die(body?.error || ...)` pattern.

### 3.10 `purplemux help` / `-h` / `--help`
- cli.js:312-315, and also reachable with **no args at all is NOT this** — note: bare `purplemux` (no cmd) is intercepted by `purplemux.js`'s router (which treats `!cmd` as `start` → launches the app server, cli.js is never invoked). Only `purplemux help`/`-h`/`--help` explicitly reach `cli.js`'s `usage()` (cli.js:259-287), which prints the same text as `docs/_source/help.txt`. No HTTP call, no auth required (no `requireEnv()` call in this branch).

### 3.11 `purplemux memory` / `purplemux mem`
- Routed to `cli.js` per purplemux.js:14, but **unimplemented** — falls to `default: die('unknown command: memory...')` in `main()`'s switch (cli.js:316-317). Exit code 1, stderr message. See discrepancy note in §1. No HTTP endpoint exists.

### 3.12 Any other `argv[2]` value
- Not in `CLI_COMMANDS` and not `start`/empty → purplemux.js:31-33 prints `unknown command: <cmd>` to stderr, exit 1. (This never reaches cli.js at all.)

---

## 4. Enums & constants summary (task item 4)

| Constant | Value | Source |
|---|---|---|
| Valid `panelType` values | `terminal`, `claude-code`, `codex-cli`, `agent-sessions`, `web-browser`, `diff` | `chunk:[root-of-the-server]__0qslqkf._.js` (`f=["terminal","claude-code","codex-cli","agent-sessions","web-browser","diff"]`); help.txt:8 lists the same 6 (minus noting default) |
| Default `panelType` on create | `terminal` | `chunk:[root-of-the-server]__0qslqkf._.js` (`u=i||"terminal"`) |
| Invalid panelType error | `400 { error: "Invalid panelType", validPanelTypes: [...] }` | same chunk; api-guide.txt:18 |
| Browser-endpoint headless error | `503 { error: "Browser bridge unavailable (Electron-only feature)" }` | `chunk:_0rh64c3._.js`; api-guide.txt:44-45 |
| Webview not yet attached | `409 { error: "Browser tab not attached yet" }` (url endpoint specifically) | `chunk:_0_wofwd._.js` |
| Tab is wrong type for browser cmd | `400 { error: "Tab is not a web-browser panel" }` | `chunk:_0rh64c3._.js` |
| Tab session dead (send/result) | `409 { error: "Tab session is not running" }` | `chunk:_07g1_zx._.js`, `chunk:_0_7my__._.js` |
| Auth failure | `403 { error: "Forbidden" }` on every `/api/cli/*` route | all route chunks |
| Wrong HTTP method | `405 { error: "Method not allowed" }` + `Allow` header | send/status/result/`[tabId]` handlers |
| Tab/workspace not found | `404 { error: "Tab not found" }` / `404 { error: "Workspace not found" }` | multiple |
| Missing required field | `400 { error: "workspaceId is required" }` / `"content is required"` / `"expression is required"` | multiple |
| Agent binary missing (claude-code/codex-cli create) | `409 { error: "agent-not-installed" \| "agent-path-missing", providerId, providerDisplayName, panelType, suggestedCommand }` | `chunk:[root-of-the-server]__0j.h25r._.js` |
| Console/network ring buffer size | 500 entries per tab | api-guide.txt:56, 60 |
| Eval timeout | 10 seconds (CDP `Runtime.evaluate`) | api-guide.txt:70-71 |
| Screenshot capture failure | `409 { error: <message> }` | `chunk:_0rh64c3._.js` |
| Eval exception/timeout | `409 { error: <message> }` | `chunk:_0zym6f2._.js` |
| Network body unavailable | `404 { error: "Response body unavailable" }` | `chunk:_0swnrzn._.js` |
| cli-token file mode | `0600` (auto-generated 32-byte hex if missing) | `chunk:[root-of-the-server]__0mky_tj._.js` |

---

## 5. Additional edge cases / semantics (task item 5, beyond what's covered above)

- **Bracketed-paste send**: see §3.4 — content is pasted as a block via terminal bracketed-paste sequences (`sendBracketedPaste`), not typed key-by-key. No implicit Enter/submit.
- **Ring buffer sizes**: 500 for both console and network entry buffers, per tab, presumably FIFO-evicting oldest entries first (standard ring buffer semantics; eviction policy not independently verified beyond the "last 500" framing in api-guide.txt).
- **base64 vs. file screenshot output**: `-o FILE` writes raw PNG bytes to disk and reports `{saved, bytes}`; omitting `-o` fetches `format=base64` and returns `{tabId, format:"png", base64}` inline in stdout JSON — no way via the CLI to get raw PNG bytes to stdout directly (only via `-o`). An MCP tool wrapping this should expose both an "output path" mode and an "inline base64" mode, mirroring the CLI.
- **`--full` flag**: fullpage screenshot capture beyond viewport; see the `stripFlags` positional-argument-eating quirk in §3 / §3.8.2 — recommend the MCP tool always appends `--full` last in the constructed argv, or (better) call the HTTP API directly rather than shelling out to the CLI, sidestepping this parsing bug entirely.
- **Electron/webview requirement (dom-ready)**: two-tier failure — `503` if not running under Electron at all (headless/remote server mode), `409 "Browser tab not attached yet"` if running under Electron but the specific tab's webview hasn't fired `dom-ready` yet (e.g., immediately after `tab create -t web-browser`, before the page has loaded). MCP tool should treat 503 as a hard capability-unavailable error and 409 (for url/eval/etc.) as a transient "retry shortly" condition.
- **Cross-workspace tab listing without `workspaceId`**: `tab list` with no `-w` iterates **all** workspaces server-side and aggregates every tab from every workspace's pane layout tree; with `-w` for a non-existent workspace id, it silently returns an empty list rather than 404 (see §3.2).
- **`memory`/`mem` discrepancy**: see §1 and §3.11 — present in the top-level command allow-list (`purplemux.js` `CLI_COMMANDS`) but wired to nothing in either `cli.js`'s command switch or the server's route table. Treat as vaporware/reserved; do not build an MCP tool for it (or build a stub that returns "not implemented" if the panel wants completeness).
- **`tab close` swallows the real body**: HTTP response is `{ok: <boolean>}` but the CLI only checks `resp.ok` (HTTP status) and always prints literal `ok`, discarding a possible `{"ok": false}` logical failure. MCP layer should call the HTTP API directly and surface the real `ok` boolean, not replicate the CLI's behavior.
- **Content/expression word-joining**: both `tab send`'s `CONTENT...` and `tab browser eval`'s `EXPR` are the shell's argv tokens rejoined with single spaces (`rest.slice(n).join(' ')`) — meaning any original multi-space runs, tabs, or newlines in an unquoted shell invocation are collapsed to single spaces. Callers needing exact whitespace/newlines (e.g. multi-line JS to eval, or multi-line content to paste) must pass the content as a single quoted shell argument, or (recommended) the MCP tool should call the HTTP API directly with the JSON body containing the exact string, bypassing this argv-joining lossiness entirely.
- **`update-notifier` side effect**: every CLI invocation (any command) triggers an async, best-effort check for package updates (purplemux.js:17-21) — this is fire-and-forget and does not block or affect command output/exit code, but could add stderr noise or a network call in sandboxed/offline environments; effectively harmless but worth knowing for reproducible/offline test runs.
- **No `=`-style flags**: `flagValue()` only recognizes `--flag value` (space-separated), not `--flag=value`. All MCP tool argument construction (if shelling out to the CLI rather than hitting HTTP directly) must use two separate argv tokens.
- **PORT/TOKEN are read once at module load** (`cli.js` top-level `const PORT =`, `const TOKEN =`), so changing env vars mid-process has no effect (not relevant to MCP design since each CLI invocation is a fresh process, but relevant if wrapping cli.js's internals directly instead of shelling out).

---

## 6. Candidate MCP tools (task item 6)

Recommendation: implement the MCP server by calling the **HTTP API directly** (same headers `X-Pmux-Token`, base `http://localhost:$PMUX_PORT`) rather than shelling out to the `purplemux` CLI binary, to avoid the argv-joining/`stripFlags` quirks noted above (§5) while still resolving PORT/TOKEN via the same `PMUX_PORT`/`PMUX_TOKEN` env vars or `~/.purplemux/{port,cli-token}` fallback files (cli.js:19-20).

| # | CLI capability | Proposed MCP tool name | Inputs | Output |
|---|---|---|---|---|
| 1 | `workspaces` | `pmux_list_workspaces` | *(none)* | `{ workspaces: [{id, name, directories}] }` |
| 2 | `tab list` | `pmux_list_tabs` | `workspaceId?: string` | `{ tabs: [{tabId, workspaceId, name, sessionName, panelType, agentProviderId, agentSessionId}] }` |
| 3 | `tab create` | `pmux_create_tab` | `workspaceId: string (required)`, `name?: string`, `panelType?: enum[terminal,claude-code,codex-cli,agent-sessions,web-browser,diff] (default terminal)` | `{tabId, workspaceId, paneId, sessionName, name, panelType, agentProviderId, agentSessionId}`; surfaces 400/404/409/500 as tool errors with the server's `error` message (and `validPanelTypes`/`suggestedCommand` when present) |
| 4 | `tab send` | `pmux_send_input` | `workspaceId: string`, `tabId: string`, `content: string (required, exact string incl. newlines — no argv rejoining)` | `{status:"sent"}`; error on 404/409 (session not running) |
| 5 | `tab status` | `pmux_tab_status` | `workspaceId: string`, `tabId: string` | `{tabId, workspaceId, alive, command?, cliState?, agentProviderId, agentSessionId, claudeSessionId}` |
| 6 | `tab result` | `pmux_capture_pane` | `workspaceId: string`, `tabId: string` | `{content: string}`; 409 if session not running |
| 7 | `tab close` | `pmux_close_tab` | `workspaceId: string`, `tabId: string` | `{ok: boolean}` — read actual body, don't just trust HTTP status (fixes CLI's swallowed-body bug) |
| 8 | `tab browser url` | `pmux_browser_url` | `workspaceId: string`, `tabId: string` | `{tabId, url, title}`; 400 (wrong panel type) / 503 (headless) / 409 (not attached yet) |
| 9 | `tab browser screenshot` | `pmux_browser_screenshot` | `workspaceId: string`, `tabId: string`, `full?: boolean (default false)`, `outputPath?: string` (if given, save PNG to path & return `{saved, bytes}`; else return `{tabId, format:"png", base64}`) | see Inputs; 400/503/409(capture error) |
| 10 | `tab browser console` | `pmux_browser_console` | `workspaceId: string`, `tabId: string`, `since?: number (ms cursor)`, `level?: string` | `{tabId, entries:[{level,text,ts,source?,url?,line?}]}` (max 500, ring buffer) |
| 11 | `tab browser network` (list) | `pmux_browser_network_list` | `workspaceId: string`, `tabId: string`, `since?: number`, `method?: string`, `urlContains?: string`, `status?: number` | `{tabId, entries:[{requestId,method,url,status?,mimeType?,resourceType?,error?,ts,endedAt?}]}` (max 500) |
| 12 | `tab browser network --request` (body fetch) | `pmux_browser_network_body` | `workspaceId: string`, `tabId: string`, `requestId: string` | `{tabId, requestId, body}`; 404 if unavailable |
| 13 | `tab browser eval` | `pmux_browser_eval` | `workspaceId: string`, `tabId: string`, `expression: string` | `{tabId, value}`; 400 (empty expr)/409 (eval error/10s timeout)/503/400(wrong panel) |
| 14 | `api-guide` | `pmux_api_guide` | *(none)* | raw markdown/text string — useful as an introspection/self-doc tool for the MCP client itself |
| 15 | *(n/a — not implemented upstream)* | — | — | `memory`/`mem` intentionally **excluded**: no server route exists; see §1/§3.11 |

Cross-cutting concerns every tool must handle: 403 Forbidden (bad/missing token → surface as an auth-config error, point user at `PMUX_PORT`/`PMUX_TOKEN` or `~/.purplemux/{port,cli-token}`), 404 Tab/Workspace not found, and connection refused (server not running — `PMUX_PORT`/`~/.purplemux/port` present but nothing listening).
