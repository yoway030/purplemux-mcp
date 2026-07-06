# purplemux CLI — Exhaustive Feature Extraction (Agent 2 / Opus)

Source of truth for an MCP server that drives purplemux from Claude Code / Codex.
All citations are `file:line` against `docs/_source/` unless noted. Installed package
(`~/.npm-global/lib/node_modules/purplemux@0.3.2`) `bin/cli.js` is
byte-identical to `docs/_source/cli.js` (verified: empty `diff`), so line numbers
below apply to both. Version **0.3.2** (`package.json:3`).

---

## 1. Auth & Connection Model

- **Port resolution** (`cli.js:19`): `PMUX_PORT` env var, else first non-empty line of
  `~/.purplemux/port`, else unset. If unset → `die` before any request
  (`cli.js:29`): `PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)`.
- **Token resolution** (`cli.js:20`): `PMUX_TOKEN` env var, else `~/.purplemux/cli-token`,
  else unset → `die` (`cli.js:30`): `PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)`.
- **Base URL** (`cli.js:21`): `http://localhost:${PORT}` — always localhost, HTTP, no HTTPS.
- **Auth header** (`cli.js:41`, `cli.js:59`): `X-Pmux-Token: <TOKEN>` on every request.
  API guide documents it lowercase `x-pmux-token` (`api-guide.txt:3`); HTTP headers are
  case-insensitive so both are equivalent.
- **Content-Type**: JSON requests send `Content-Type: application/json` (`cli.js:41`).
  The raw-download path (screenshot to file) omits it (`cli.js:59`).
- **`requireEnv()`** (`cli.js:28-31`) runs at the start of *every* command handler, so a
  missing port/token fails fast regardless of subcommand.
- **Reachability check used in this extraction**: live server on `PMUX_PORT=16500`
  (`runtime-env.txt:1`); `purplemux workspaces` returned 2 workspaces successfully.

### Response handling semantics
- `api()` (`cli.js:37-53`): parses body as JSON only if response `content-type` includes
  `json`, else `body = null`. On `!resp.ok`, dies with `body.error` if present, else
  `HTTP <status>` (`cli.js:48-51`).
- `apiRaw()` (`cli.js:55-70`): used for binary (screenshot-to-file); no JSON body parse on
  success. On error, dies with JSON `error` field if content-type is json, else `HTTP <status>`.
- Success output: all JSON commands pretty-print with 2-space indent + newline (`out`, `cli.js:33-35`).
- Top-level `main().catch` (`cli.js:321-323`) converts any thrown error (e.g. `fetch`
  connection refused) to `error: <message>` and exit 1.

---

## 2. Command Routing

Two-layer routing:

1. **`purplemux.js` (entry point)** decides CLI vs. server:
   - Sets `PURPLEMUX_CLI=1`, snapshots pristine env (`purplemux.js:5-9`).
   - `CLI_COMMANDS = { 'workspaces', 'tab', 'memory', 'mem', 'api-guide', 'help' }` (`purplemux.js:13-15`).
   - If `argv[2]` is in that set → `require('./cli.js')` (`purplemux.js:25-26`).
   - If no command or `start` → boots server `../dist/server.js` (`purplemux.js:27-30`).
   - Else → stderr `unknown command: <cmd>` + exit 1 (`purplemux.js:31-34`).
   - Also fires `update-notifier` (`purplemux.js:17-21`).
2. **`cli.js` main()** (`cli.js:289-319`) switch on `argv[2]`: `workspaces`, `tab` (with
   subcommand switch), `api-guide`, `help`/`-h`/`--help`. Unknown → `die` (`cli.js:317`).

### The `memory` / `mem` discrepancy — RESOLVED: NOT reachable
`purplemux.js` lists `memory`/`mem` in `CLI_COMMANDS`, so it hands them to `cli.js`.
But `cli.js` `main()` has **no `case 'memory'` / `case 'mem'`** — they fall through to the
`default` branch and `die('unknown command: memory. Run 'purplemux help' for usage.')`
(`cli.js:316-317`). **Empirically verified on the live 0.3.2 install:**
```
$ purplemux memory  → error: unknown command: memory. Run 'purplemux help' for usage.
$ purplemux mem     → error: unknown command: mem. Run 'purplemux help' for usage.
```
So `memory`/`mem` are **dead entries** — recognized by the dispatcher (they avoid the
"boot the server" and the `purplemux.js`-level unknown-command paths) but immediately
rejected by `cli.js`. **Do NOT expose a memory tool in the MCP server.** It is vestigial
(likely a planned/removed feature). The only user-visible effect is a *different* error
message than a truly-unknown command: `purplemux foo` errors at `purplemux.js:32`
(`unknown command: foo` to stderr, no `error:` prefix), whereas `purplemux memory` errors
at `cli.js:317` (`error: unknown command: memory`, with prefix, via `die`).

---

## 3. Commands & Subcommands (full reference)

Global flag parsing helpers:
- `flagValue(args, name)` (`cli.js:239-243`): returns the token *after* the first
  occurrence of `name`; `null` if absent or trailing. So flags are `--flag VALUE` style
  (space-separated), **not** `--flag=VALUE`.
- `stripFlags(args, names)` (`cli.js:245-257`): removes each listed flag **and its following
  value** (consumes 2 tokens), leaving positional args. Note: it strips a fixed name list;
  a value that happens to equal a flag name could be mis-stripped (edge case).

### 3.1 `workspaces`
- **Invocation:** `purplemux workspaces` (no args/flags).
- **Handler:** `cmdWorkspaces` (`cli.js:72-76`).
- **HTTP:** `GET /api/cli/workspaces`.
- **Response:** `{ "workspaces": [{ "id", "name", "directories": [...] }] }` (`api-guide.txt:7-8`).
  Live sample: `{"id":"ws-UJm6NN","name":"purplemux-mcp","directories":["/home/.../purplemux-mcp"]}`.

### 3.2 `tab list`
- **Invocation:** `purplemux tab list [-w|--workspace WS]`.
- **Handler:** `cmdTabList` (`cli.js:78-84`).
- **Flags:** `--workspace`/`-w` optional (`cli.js:80`).
- **HTTP:** `GET /api/cli/tabs[?workspaceId=WS]`. Without `workspaceId`, lists tabs across
  **all** workspaces (`api-guide.txt:12-13`). Confirmed live: 2 tabs from 2 different
  workspaces returned with no `-w`.
- **Response:** `{ "tabs": [{ "tabId", "workspaceId", "name", "sessionName", "panelType",
  "agentProviderId", "agentSessionId" }] }` (`api-guide.txt:14`). `name` may be `""`,
  `agentProviderId`/`agentSessionId` may be `null` (live sample).

### 3.3 `tab create`
- **Invocation:** `purplemux tab create -w|--workspace WS [-n|--name NAME] [-t|--type TYPE]`.
- **Handler:** `cmdTabCreate` (`cli.js:86-98`).
- **Required:** `--workspace`/`-w` → else `die('--workspace is required')` (`cli.js:91`).
- **Optional:** `--name`/`-n`, `--type`/`-t` (panelType). Omitted keys are not sent
  (`cli.js:92-96`).
- **HTTP:** `POST /api/cli/tabs`, body `{ "workspaceId", "name"?, "panelType"? }`
  (`api-guide.txt:16-17`). Creates the tab in the **first pane** of the workspace
  (`api-guide.txt:19`).
- **Response:** `{ "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType",
  "agentProviderId", "agentSessionId" }` (`api-guide.txt:20`).
- **Errors:** invalid `panelType` → **HTTP 400** with `validPanelTypes` in body
  (`api-guide.txt:18`).

### 3.4 `tab send`
- **Invocation:** `purplemux tab send -w|--workspace WS TAB_ID CONTENT...`.
- **Handler:** `cmdTabSend` (`cli.js:106-120`).
- **Positional:** after stripping `-w`/`--workspace`, `rest[0]` = tabId, `rest.slice(1).join(' ')`
  = content (`cli.js:108-110`). **Content is space-joined across all remaining args** — multi-word
  content need not be quoted, but internal whitespace collapses to single spaces.
- **Required:** tabId → `die('tab ID is required')` (`cli.js:111`); content →
  `die('content is required')` (`cli.js:112`); workspace via `resolveWsForTab`
  → `die('--workspace is required')` (`cli.js:100-104`).
- **HTTP:** `POST /api/cli/tabs/<tabId>/send?workspaceId=WS`, body `{ "content" }`
  (`api-guide.txt:29-31`).
- **Semantics:** sent as **bracketed paste** (`api-guide.txt:31`, cli usage `cli.js:106`
  header). Bracketed-paste means the receiving terminal/agent treats the content as pasted
  text, not keystroke-by-keystroke — a trailing newline / Enter is not implied by the paste
  itself; include it in `content` if a submit is required.
- **Response:** `{ "status": "sent" }` (`api-guide.txt:32`).

### 3.5 `tab status`
- **Invocation:** `purplemux tab status -w|--workspace WS TAB_ID`.
- **Handler:** `cmdTabStatus` (`cli.js:122-133`).
- **HTTP:** `GET /api/cli/tabs/<tabId>/status?workspaceId=WS` (`api-guide.txt:34`).
- **Response:** `{ "tabId", "workspaceId", "alive", "command", "cliState",
  "agentProviderId", "agentSessionId", "claudeSessionId" }` (`api-guide.txt:35`).
  `alive` = process liveness; `cliState`/`command` describe the running foreground.

### 3.6 `tab result`
- **Invocation:** `purplemux tab result -w|--workspace WS TAB_ID`.
- **Handler:** `cmdTabResult` (`cli.js:135-146`).
- **HTTP:** `GET /api/cli/tabs/<tabId>/result?workspaceId=WS` (`api-guide.txt:37`).
- **Semantics:** captures **current pane content** (visible tmux pane buffer snapshot)
  (`api-guide.txt:38`).
- **Response:** `{ "content": "..." }` (`api-guide.txt:39`).

### 3.7 `tab close`
- **Invocation:** `purplemux tab close -w|--workspace WS TAB_ID`.
- **Handler:** `cmdTabClose` (`cli.js:148-159`).
- **HTTP:** `DELETE /api/cli/tabs/<tabId>?workspaceId=WS` (`api-guide.txt:26`).
- **Semantics:** kills the tmux session and removes the tab from the layout
  (`api-guide.txt:27`).
- **Output:** prints plain `ok` (not JSON) on success (`cli.js:158`). This is the only
  non-JSON success output besides `api-guide` and screenshot-to-file.
- **Note:** the DELETE endpoint doubles as "tab info" GET (`api-guide.txt:22-24`, response
  `{ tabId, workspaceId, paneId, name, sessionName, panelType, agentProviderId, agentSessionId }`)
  — but the CLI exposes **no** `tab info`/`tab get` command; only DELETE is wired.
  (An MCP `tab_info` tool could map to `GET /api/cli/tabs/<tabId>` even though the CLI lacks it.)

### 3.8 `tab browser <sub>` (web-browser tabs only)
- **Handler:** `cmdTabBrowser` (`cli.js:161-228`).
- **Parsing:** `sub = args[0]` (`cli.js:163`); positional tabId from `rest[0]` after
  stripping the full flag set `['--workspace','-w','-o','--since','--level','--method',
  '--url','--status','--request','--full']` (`cli.js:164`). Note `--full` is included in
  the strip list even though it takes no value — `stripFlags` will still consume the token
  **after** `--full` (bug-adjacent), so put `--full` **last** or before non-positional
  tokens to be safe.
- **Required:** `sub` → `die('browser subcommand required (url | screenshot | console | network | eval)')`
  (`cli.js:166`); tabId → `die('tab ID is required')` (`cli.js:167`); workspace via
  `resolveWsForTab` (`cli.js:168`).
- **Preconditions (all browser subs):** tab `panelType` must be `web-browser` **and** the
  webview must have attached — `dom-ready` must have fired ≥ once (`api-guide.txt:43-44`).
  Requires the **Electron runtime**; in headless/remote mode these return **HTTP 503**
  (`api-guide.txt:45`).
- **Unknown sub** → `die('unknown browser subcommand: ...')` (`cli.js:226`).

#### 3.8.1 `tab browser url -w WS TAB_ID`
- `cli.js:172-176`. **HTTP:** `GET /api/cli/tabs/<tabId>/browser/url?workspaceId=WS`.
- **Response:** `{ "tabId", "url", "title" }` (`api-guide.txt:47-49`).

#### 3.8.2 `tab browser screenshot -w WS TAB_ID [-o|--output FILE] [--full]`
- `cli.js:177-191`. **Flags:** `-o`/`--output` (save path), `--full` (boolean,
  `full=1` else `0`, `cli.js:179`).
- **HTTP base:** `GET /api/cli/tabs/<tabId>/browser/screenshot?workspaceId=WS&full=<0|1>`.
- **Two output modes:**
  - **With `-o FILE`** (`cli.js:181-185`): calls `apiRaw` (binary), writes raw PNG bytes to
    FILE via `fs.writeFileSync`, prints `{ "saved": FILE, "bytes": <n> }`. Server returns
    `image/png` (`api-guide.txt:52-53`).
  - **Without `-o`** (`cli.js:186-189`): appends `&format=base64`, server returns
    `{ "base64": "..." }` JSON (`api-guide.txt:53`), printed as JSON.
- **`--full`:** captures beyond the viewport (full-page) (`api-guide.txt:54`).
- **MCP note:** for MCP, prefer base64 mode (no filesystem dependency) OR save-to-file then
  return path; the flag `--full`+`format` combine independently.

#### 3.8.3 `tab browser console -w WS TAB_ID [--since MS] [--level LEVEL]`
- `cli.js:192-201`. **Flags:** `--since` (ms timestamp filter), `--level` (severity filter);
  both optional query params (`cli.js:193-196`).
- **HTTP:** `GET /api/cli/tabs/<tabId>/browser/console?workspaceId=WS[&since=MS][&level=LEVEL]`.
- **Semantics:** **ring buffer, last 500 entries** of console messages, `Log` entries, and
  exceptions (`api-guide.txt:55-56`, usage `cli.js:275`).
- **Response:** `{ "tabId", "entries": [{ "level", "text", "ts", "source"?, "url"?, "line"? }] }`
  (`api-guide.txt:57`).

#### 3.8.4 `tab browser network -w WS TAB_ID [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]`
- `cli.js:202-217`. **Flags (all optional):** `--request` (requestId — switches to
  single-body mode), `--since`, `--method`, `--url` (substring), `--status` (code)
  (`cli.js:203-213`).
- **HTTP (list):** `GET /api/cli/tabs/<tabId>/browser/network?workspaceId=WS[&since][&method][&url][&status]`
  — **ring buffer, last 500 requests** (`api-guide.txt:59-60`).
  - **List response:** `{ "tabId", "entries": [{ "requestId", "method", "url", "status"?,
    "mimeType"?, "resourceType"?, "error"?, "ts", "endedAt"? }] }` (`api-guide.txt:61-62`).
- **HTTP (single body):** with `--request RID` → `...network?workspaceId=WS&requestId=RID`
  — fetches the **response body** for one request; **cached after first call**
  (`api-guide.txt:64-65`).
  - **Body response:** `{ "tabId", "requestId", "body" }` (`api-guide.txt:66`).
- **Note:** CLI adds `requestId` first (`cli.js:209`), then the other filters; when
  `--request` is present the server returns the single-body shape regardless of other filters.

#### 3.8.5 `tab browser eval -w WS TAB_ID EXPR...`
- `cli.js:218-224`. **Positional:** `expression = rest.slice(1).join(' ')` (`cli.js:219`);
  empty → `die('expression is required')` (`cli.js:220`). Multi-word EXPR is space-joined.
- **HTTP:** `POST /api/cli/tabs/<tabId>/browser/eval?workspaceId=WS`, body `{ "expression" }`
  (`api-guide.txt:68-69`).
- **Semantics:** evaluated in the webview via **CDP `Runtime.evaluate`** with
  `returnByValue`, `awaitPromise`, **10s timeout** (`api-guide.txt:70-71`). Only serializable
  values return.
- **Response:** `{ "tabId", "value" }` (`api-guide.txt:72`).

### 3.9 `api-guide`
- **Invocation:** `purplemux api-guide`.
- **Handler:** `cmdApiGuide` (`cli.js:230-237`). Uses raw `fetch` (not `api()`),
  `GET /api/cli/api-guide`, prints response **text** (markdown, not JSON) (`cli.js:236`).
  On `!resp.ok` → `die('HTTP <status>')`.

### 3.10 `help` / `-h` / `--help`
- **Invocation:** `purplemux help` (or `-h`, `--help`). Handler: `usage()` (`cli.js:259-287`),
  prints static usage to stdout, no HTTP call, no `requireEnv`.

---

## 4. Enums & Constraints

### 4.1 `panelType` allowed values (6)
From `tab create` usage (`cli.js:267`), help (`help.txt:8`), and api-guide (`api-guide.txt:17`):
```
terminal | claude-code | codex-cli | agent-sessions | web-browser | diff
```
- Invalid `panelType` → **HTTP 400**, body includes `validPanelTypes` array
  (`api-guide.txt:18`). The CLI surfaces the server's `error` field via `die` (`cli.js:49`).
- Default when omitted: server-decided (CLI simply omits the key, `cli.js:95`). Live default
  observed is `terminal`.
- **Browser subcommands require `panelType === "web-browser"`** (`api-guide.txt:43`).

### 4.2 Status / error codes
| Code | Condition | Source |
|------|-----------|--------|
| 400 | invalid `panelType` on `tab create` (body has `validPanelTypes`) | `api-guide.txt:18` |
| 503 | any `tab browser *` endpoint in headless / non-Electron / remote mode | `api-guide.txt:45` |
| (any non-2xx) | surfaced as `error: <body.error>` or `error: HTTP <status>` | `cli.js:48-51`, `cli.js:64-67` |

### 4.3 CLI-side required-arg / validation errors (all via `die`, exit 1, `error:` prefix)
| Message | Where | Trigger |
|---------|-------|---------|
| `PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)` | `cli.js:29` | no port |
| `PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)` | `cli.js:30` | no token |
| `--workspace is required` | `cli.js:91`, `cli.js:103` | create/send/status/result/close/browser missing `-w` |
| `tab ID is required` | `cli.js:111,127,139,153,167` | missing positional tabId |
| `content is required` | `cli.js:112` | `tab send` no content |
| `expression is required` | `cli.js:220` | `tab browser eval` no EXPR |
| `browser subcommand required (url \| screenshot \| console \| network \| eval)` | `cli.js:166` | `tab browser` no sub |
| `unknown browser subcommand: <sub>...` | `cli.js:226` | bad browser sub |
| `unknown tab command: <sub>...` | `cli.js:307` | bad `tab` sub |
| `unknown command: <cmd>...` | `cli.js:317` | bad top-level cmd (incl. `memory`/`mem`) |

### 4.4 Ring buffer sizes
- Console: **last 500 entries** (`api-guide.txt:56`, `cli.js:275`).
- Network: **last 500 requests** (`api-guide.txt:60`, `cli.js:278`).

---

## 5. Edge Cases & Semantics (summary)

1. **Bracketed-paste send** — `tab send` delivers content as a bracketed paste
   (`api-guide.txt:31`). Content is `args.slice(1).join(' ')` so multi-word is fine but
   whitespace normalizes; embed `\n` explicitly to submit. No auto-Enter.
2. **Ring buffers = 500** for both console and network (§4.4). Old entries are dropped;
   use `--since MS` to page by timestamp.
3. **Screenshot base64-vs-file** — with `-o FILE` → raw PNG saved, prints
   `{saved,bytes}`; without → `&format=base64`, prints `{base64}` (`cli.js:177-190`,
   `api-guide.txt:52-54`).
4. **`--full` flag** — boolean, maps to `full=1` (else `full=0`); full-page capture beyond
   viewport (`cli.js:179`, `api-guide.txt:54`). Caveat: it is in `stripFlags`' name list,
   so a token *after* `--full` can be wrongly consumed — order `--full` carefully.
5. **Electron/webview requirement (dom-ready)** — all `tab browser *` need `web-browser`
   panelType + webview attached (dom-ready fired ≥ once) + Electron runtime; else **503**
   in headless/remote (`api-guide.txt:43-45`).
6. **Cross-workspace tab listing** — `tab list` without `-w` lists tabs across all
   workspaces (`api-guide.txt:13`); every other tab command **requires** `-w`
   (workspaceId query param). Verified live: no-`-w` list returned tabs from `ws-Soe0km`
   and `ws-UJm6NN`.
7. **`memory`/`mem` unreachable** — recognized by `purplemux.js` dispatcher but dies in
   `cli.js` default case (§2). Not an MCP tool. Empirically confirmed on 0.3.2.
8. **Network single-body caching** — `--request RID` response body is cached after first
   fetch (`api-guide.txt:65`); repeated calls are cheap/stable.
9. **eval limits** — CDP `Runtime.evaluate`, 10s timeout, `returnByValue` + `awaitPromise`;
   non-serializable values won't round-trip (`api-guide.txt:70-71`).
10. **`tab close` output** is literal `ok`, not JSON (`cli.js:158`). `api-guide` output is
    markdown text, not JSON (`cli.js:236`). All other commands emit pretty JSON.
11. **Flag syntax is space-separated** (`--flag VALUE`), never `--flag=VALUE` (`flagValue`,
    `cli.js:239-243`).
12. **Undocumented GET tab-info endpoint** — `GET /api/cli/tabs/<tabId>?workspaceId=WS`
    exists server-side (`api-guide.txt:22-24`) but has no CLI command; usable directly by
    the MCP server for a richer `tab_info`.

---

## 6. Candidate MCP Tools

One row per CLI capability. Inputs marked `*` are required. All map to
`http://localhost:$PMUX_PORT` with header `X-Pmux-Token`. Base env: `PMUX_PORT`,
`PMUX_TOKEN` (resolve like §1).

| MCP tool | CLI equivalent | HTTP | Inputs | Output |
|----------|----------------|------|--------|--------|
| `list_workspaces` | `workspaces` | `GET /api/cli/workspaces` | — | `{workspaces:[{id,name,directories[]}]}` |
| `list_tabs` | `tab list [-w]` | `GET /api/cli/tabs[?workspaceId]` | `workspaceId?` | `{tabs:[{tabId,workspaceId,name,sessionName,panelType,agentProviderId,agentSessionId}]}` |
| `create_tab` | `tab create` | `POST /api/cli/tabs` | `workspaceId*`, `name?`, `panelType?`(enum, §4.1) | `{tabId,workspaceId,paneId,sessionName,name,panelType,agentProviderId,agentSessionId}`; 400 on bad panelType |
| `get_tab` | *(none — undocumented)* | `GET /api/cli/tabs/<tabId>?workspaceId` | `workspaceId*`, `tabId*` | `{tabId,workspaceId,paneId,name,sessionName,panelType,agentProviderId,agentSessionId}` |
| `send_to_tab` | `tab send` | `POST /api/cli/tabs/<tabId>/send?workspaceId` | `workspaceId*`, `tabId*`, `content*` | `{status:"sent"}` (bracketed paste) |
| `get_tab_status` | `tab status` | `GET .../status?workspaceId` | `workspaceId*`, `tabId*` | `{tabId,workspaceId,alive,command,cliState,agentProviderId,agentSessionId,claudeSessionId}` |
| `capture_tab` | `tab result` | `GET .../result?workspaceId` | `workspaceId*`, `tabId*` | `{content}` (pane snapshot) |
| `close_tab` | `tab close` | `DELETE /api/cli/tabs/<tabId>?workspaceId` | `workspaceId*`, `tabId*` | ok (kills tmux session) |
| `browser_get_url` | `tab browser url` | `GET .../browser/url?workspaceId` | `workspaceId*`, `tabId*` | `{tabId,url,title}`; 503 non-Electron |
| `browser_screenshot` | `tab browser screenshot` | `GET .../browser/screenshot?workspaceId&full&format` | `workspaceId*`, `tabId*`, `full?`(bool), `format?`(`base64`\|`png`), `savePath?` | `{base64}` or saved-file `{saved,bytes}`; 503 |
| `browser_console` | `tab browser console` | `GET .../browser/console?workspaceId` | `workspaceId*`, `tabId*`, `since?`(ms), `level?` | `{tabId,entries:[{level,text,ts,source?,url?,line?}]}` (≤500); 503 |
| `browser_network` | `tab browser network` | `GET .../browser/network?workspaceId` | `workspaceId*`, `tabId*`, `since?`, `method?`, `url?`(substr), `status?` | `{tabId,entries:[{requestId,method,url,status?,mimeType?,resourceType?,error?,ts,endedAt?}]}` (≤500); 503 |
| `browser_network_body` | `tab browser network --request` | `GET .../browser/network?workspaceId&requestId` | `workspaceId*`, `tabId*`, `requestId*` | `{tabId,requestId,body}` (cached); 503 |
| `browser_eval` | `tab browser eval` | `POST .../browser/eval?workspaceId` | `workspaceId*`, `tabId*`, `expression*` | `{tabId,value}` (CDP, 10s, returnByValue); 503 |
| `api_guide` | `api-guide` | `GET /api/cli/api-guide` | — | markdown text (reference doc) |

**Not exposed:** `help`/`usage` (static text, no server value); `memory`/`mem` (dead —
§2). `browser_screenshot` merges CLI's two output modes into one tool via a `format`/
`savePath` parameter.

**Recommended MCP design notes:**
- Prefer hitting the HTTP API directly (not shelling out to `purplemux`) for structured
  errors and to avoid JSON-reparse; replicate `X-Pmux-Token` + port/token resolution (§1).
- Surface HTTP 400 `validPanelTypes` and 503 (headless) as typed errors so agents can react.
- Split screenshot base64 vs. file at the tool boundary; default to base64 for portability.
