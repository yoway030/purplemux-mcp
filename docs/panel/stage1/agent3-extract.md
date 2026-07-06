# Agent 3 Purplemux CLI Feature Extraction

Sources used:

- `docs/_source/cli.js` - CLI HTTP wrapper and usage text.
- `docs/_source/purplemux.js` - executable entrypoint and command routing.
- `docs/_source/api-guide.txt` - HTTP API reference served by `purplemux api-guide`.
- `docs/_source/help.txt` - captured usage output.
- `docs/_source/package.json` - package metadata and binary aliases.
- `docs/_source/runtime-env.txt` - captured runtime installation/port context.
- Installed package at `~/.npm-global/lib/node_modules/purplemux` for server-side route behavior not present in the source docs.

## 1. Entrypoint, Binaries, And Top-Level Commands

`docs/_source/package.json` exposes two binary names, `purplemux` and `pmux`, both pointing at `./bin/purplemux.js` ([package.json:27](../_source/package.json:27)-[29](../_source/package.json:29)). The package is `purplemux` version `0.3.2` and requires Node `>=20.0.0` ([package.json:2](../_source/package.json:2)-[23](../_source/package.json:23)).

The executable entrypoint sets `PURPLEMUX_CLI=1`, stores a pristine copy of inherited env in `__PMUX_PRISTINE_ENV`, and then routes based on `process.argv[2]` ([purplemux.js:3](../_source/purplemux.js:3)-[9](../_source/purplemux.js:9), [purplemux.js:23](../_source/purplemux.js:23)-[33](../_source/purplemux.js:33)).

Top-level command routing:

| Invocation | Entrypoint behavior | Notes |
|---|---|---|
| `purplemux` / `pmux` | Starts the production server by requiring `../dist/server.js`. | Triggered when no command is present ([purplemux.js:27](../_source/purplemux.js:27)-[30](../_source/purplemux.js:30)). |
| `purplemux start` / `pmux start` | Starts the production server. | Same server path as no-arg invocation ([purplemux.js:27](../_source/purplemux.js:27)-[30](../_source/purplemux.js:30)). |
| `purplemux workspaces` | Routes to `cli.js`. | `workspaces` is in `CLI_COMMANDS` ([purplemux.js:13](../_source/purplemux.js:13)-[15](../_source/purplemux.js:15)). |
| `purplemux tab ...` | Routes to `cli.js`. | `tab` is in `CLI_COMMANDS` ([purplemux.js:13](../_source/purplemux.js:13)-[15](../_source/purplemux.js:15)). |
| `purplemux api-guide` | Routes to `cli.js`. | `api-guide` is in `CLI_COMMANDS` ([purplemux.js:13](../_source/purplemux.js:13)-[15](../_source/purplemux.js:15)). |
| `purplemux help` | Routes to `cli.js` and prints usage. | `help` is in `CLI_COMMANDS`; `cli.js` handles it ([purplemux.js:13](../_source/purplemux.js:13)-[15](../_source/purplemux.js:15), [cli.js:312](../_source/cli.js:312)-[315](../_source/cli.js:315)). |
| `purplemux memory` / `purplemux mem` | Routes to `cli.js`, then fails as unknown command. | `purplemux.js` includes `memory`/`mem` in `CLI_COMMANDS`, but `cli.js` `main()` has no cases for them ([purplemux.js:13](../_source/purplemux.js:13)-[15](../_source/purplemux.js:15), [cli.js:295](../_source/cli.js:295)-[318](../_source/cli.js:318)). |
| `purplemux -h` / `purplemux --help` | Entrypoint treats as unknown command. | `cli.js` can handle `-h`/`--help`, but `purplemux.js` does not route those tokens into `cli.js` ([purplemux.js:25](../_source/purplemux.js:25)-[33](../_source/purplemux.js:33), [cli.js:312](../_source/cli.js:312)-[315](../_source/cli.js:315)). |
| Any other top-level command | Prints `unknown command: <cmd>\nRun 'purplemux help' for usage.` and exits 1. | Entrypoint behavior ([purplemux.js:31](../_source/purplemux.js:31)-[33](../_source/purplemux.js:33)). |

## 2. Auth And Connection Model

The CLI resolves:

- `PORT = process.env.PMUX_PORT || read ~/.purplemux/port`
- `TOKEN = process.env.PMUX_TOKEN || read ~/.purplemux/cli-token`
- `BASE = http://localhost:${PORT}`

This is implemented at [cli.js:19](../_source/cli.js:19)-[21](../_source/cli.js:21). File reads trim whitespace and return `null` for empty, missing, or unreadable files ([cli.js:11](../_source/cli.js:11)-[17](../_source/cli.js:17)).

Before every implemented HTTP-wrapper command, `requireEnv()` exits with:

- `PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)`
- `PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)`

See [cli.js:28](../_source/cli.js:28)-[31](../_source/cli.js:31).

JSON API requests include headers:

- `X-Pmux-Token: <TOKEN>`
- `Content-Type: application/json`

See [cli.js:37](../_source/cli.js:37)-[44](../_source/cli.js:44). Raw screenshot downloads include only `X-Pmux-Token` ([cli.js:55](../_source/cli.js:55)-[60](../_source/cli.js:60)). The API guide documents the same token header as lowercase `x-pmux-token`; HTTP header names are case-insensitive ([api-guide.txt:3](../_source/api-guide.txt:3)).

Server-side persistence observed in the installed package:

- The running server writes the actual listening port to `~/.purplemux/port` and removes it on shutdown.
- The CLI token is stored at `~/.purplemux/cli-token`; if missing, the server generates a 32-byte random hex token and writes it.
- `docs/_source/runtime-env.txt` records a runtime `PMUX_PORT=16500` and install path `~/.npm-global/lib/node_modules/purplemux` ([runtime-env.txt:1](../_source/runtime-env.txt:1)-[2](../_source/runtime-env.txt:2)).

CLI response handling:

- Successful JSON responses are printed with `JSON.stringify(body, null, 2)` plus newline ([cli.js:33](../_source/cli.js:33)-[35](../_source/cli.js:35)).
- For non-2xx JSON responses, the CLI exits with `body.error` if present, else `HTTP <status>` ([cli.js:44](../_source/cli.js:44)-[51](../_source/cli.js:51)).
- Raw non-2xx screenshot responses parse JSON error bodies when possible, else exit with `HTTP <status>` ([cli.js:61](../_source/cli.js:61)-[68](../_source/cli.js:68)).

## 3. Flag Parsing Semantics

The CLI parser is intentionally simple:

- `flagValue(args, name)` only recognizes separate-token flags, e.g. `--workspace WS`; it does not support `--workspace=WS` ([cli.js:239](../_source/cli.js:239)-[243](../_source/cli.js:243)).
- `stripFlags(args, names)` removes each listed flag and the immediately following token; it treats all listed flags as if they take a value ([cli.js:245](../_source/cli.js:245)-[257](../_source/cli.js:257)).
- Because `--full` is included in `stripFlags()` for browser subcommands, putting `--full` before `TAB_ID` consumes the tab id as the flag value. Usage shows `--full` after `TAB_ID`, which avoids that issue ([cli.js:164](../_source/cli.js:164)-[180](../_source/cli.js:180), [help.txt:13](../_source/help.txt:13)-[15](../_source/help.txt:15)).
- `--output` is accepted when choosing a screenshot output path, but it is not included in the browser `stripFlags()` list. It is safe after `TAB_ID`; before `TAB_ID` it can be misread as the tab id ([cli.js:164](../_source/cli.js:164)-[180](../_source/cli.js:180)).
- Positional `CONTENT...` and browser `EXPR` are reconstructed with `args.join(' ')`, so shell quoting controls grouping and original quote characters are not preserved ([cli.js:108](../_source/cli.js:108)-[117](../_source/cli.js:117), [cli.js:218](../_source/cli.js:218)-[221](../_source/cli.js:221)).

## 4. Commands And HTTP Mapping

### `purplemux workspaces`

Syntax: `purplemux workspaces`

Behavior: lists all workspaces. Requires port/token resolution. Calls `GET /api/cli/workspaces` and prints the JSON body ([cli.js:72](../_source/cli.js:72)-[75](../_source/cli.js:75)).

HTTP:

- Method/path: `GET /api/cli/workspaces`
- Query: none
- Body: none
- Response: `{ "workspaces": [{ "id": "...", "name": "...", "directories": [...] }] }` ([api-guide.txt:5](../_source/api-guide.txt:5)-[8](../_source/api-guide.txt:8)).

### `purplemux tab list`

Syntax: `purplemux tab list [-w WS]` or `purplemux tab list [--workspace WS]`

Behavior: lists tabs. If `-w/--workspace` is omitted, the API lists tabs across all workspaces ([cli.js:78](../_source/cli.js:78)-[83](../_source/cli.js:83), [api-guide.txt:12](../_source/api-guide.txt:12)-[14](../_source/api-guide.txt:14)).

HTTP:

- Method/path: `GET /api/cli/tabs`
- Query: optional `workspaceId=WS`
- Body: none
- Response: `{ "tabs": [{ "tabId", "workspaceId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId" }] }` ([api-guide.txt:12](../_source/api-guide.txt:12)-[14](../_source/api-guide.txt:14)).

Installed server behavior:

- Without `workspaceId`, iterates all known workspaces.
- With an unknown `workspaceId`, returns `{ "tabs": [] }`, not `404`.

### `purplemux tab create`

Syntax: `purplemux tab create -w WS [-n NAME] [-t TYPE]` or long flags `--workspace`, `--name`, `--type`.

Required:

- `-w WS` / `--workspace WS`

Optional:

- `-n NAME` / `--name NAME`
- `-t TYPE` / `--type TYPE`

Behavior: creates a tab in the first pane of the workspace. `--workspace` is enforced by the CLI before the HTTP request ([cli.js:86](../_source/cli.js:86)-[97](../_source/cli.js:97)). If `panelType` is omitted, the server default is `terminal`.

HTTP:

- Method/path: `POST /api/cli/tabs`
- Query: none
- Body: `{ "workspaceId": "WS", "name"?: "...", "panelType"?: "terminal" | "claude-code" | "codex-cli" | "agent-sessions" | "web-browser" | "diff" }` ([api-guide.txt:16](../_source/api-guide.txt:16)-[18](../_source/api-guide.txt:18)).
- Response: `{ "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType", "agentProviderId", "agentSessionId" }` ([api-guide.txt:19](../_source/api-guide.txt:19)-[20](../_source/api-guide.txt:20)).

Server-side constraints:

- Invalid `panelType` returns HTTP `400` with `{ "error": "Invalid panelType", "validPanelTypes": [...] }` ([api-guide.txt:16](../_source/api-guide.txt:16)-[18](../_source/api-guide.txt:18)).
- Allowed `panelType` values: `terminal`, `claude-code`, `codex-cli`, `agent-sessions`, `web-browser`, `diff` ([cli.js:267](../_source/cli.js:267), [api-guide.txt:17](../_source/api-guide.txt:17)).
- Agent-backed panels can return HTTP `409` if the required agent is unavailable. Observed installed-server error bodies include `agent-not-installed` and `agent-path-missing` with provider metadata.
- `web-browser` tabs are layout tabs, not tmux sessions. They do not create/kill a tmux session.

### `purplemux tab send`

Syntax: `purplemux tab send -w WS TAB_ID CONTENT...` or `--workspace WS`.

Required:

- `-w WS` / `--workspace WS`
- `TAB_ID`
- `CONTENT...`

Behavior: sends text input to a tab. The CLI joins all remaining positional tokens after `TAB_ID` with spaces and sends `{ content }` ([cli.js:106](../_source/cli.js:106)-[119](../_source/cli.js:119)). Required-arg errors are CLI-side: `tab ID is required`, `content is required`, and `--workspace is required` ([cli.js:111](../_source/cli.js:111)-[113](../_source/cli.js:113), [cli.js:100](../_source/cli.js:100)-[103](../_source/cli.js:103)).

HTTP:

- Method/path: `POST /api/cli/tabs/<tabId>/send`
- Query: required `workspaceId=WS`
- Body: `{ "content": "..." }` ([api-guide.txt:29](../_source/api-guide.txt:29)-[31](../_source/api-guide.txt:31)).
- Response: `{ "status": "sent" }` ([api-guide.txt:31](../_source/api-guide.txt:31)-[32](../_source/api-guide.txt:32)).

Semantics:

- The API guide explicitly says send uses bracketed paste ([api-guide.txt:29](../_source/api-guide.txt:29)-[31](../_source/api-guide.txt:31)).
- Installed server implementation sends literal tmux keys containing `ESC [ 200 ~`, the content, `ESC [ 201 ~`, then sends Enter, waits about 600ms, and sends Enter again. This matters for prompts that treat bracketed paste differently from typed characters.
- Server returns HTTP `409` if the target tmux session is not running.

### `purplemux tab status`

Syntax: `purplemux tab status -w WS TAB_ID` or `--workspace WS`.

Behavior: fetches liveness/status for one tab. Requires workspace and tab id ([cli.js:122](../_source/cli.js:122)-[132](../_source/cli.js:132)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>/status`
- Query: required `workspaceId=WS`
- Body: none
- Response: `{ "tabId", "workspaceId", "alive", "command", "cliState", "agentProviderId", "agentSessionId", "claudeSessionId" }` ([api-guide.txt:34](../_source/api-guide.txt:34)-[35](../_source/api-guide.txt:35)).

Semantics:

- For tmux-backed tabs, `alive` indicates whether the tmux session exists.
- For `web-browser` tabs, `alive` is normally `false`; generated purplemux context explicitly warns not to use `alive` as a web-browser health signal and to use browser endpoints directly.

### `purplemux tab result`

Syntax: `purplemux tab result -w WS TAB_ID` or `--workspace WS`.

Behavior: captures current pane content and prints `{ content }` ([cli.js:135](../_source/cli.js:135)-[145](../_source/cli.js:145)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>/result`
- Query: required `workspaceId=WS`
- Body: none
- Response: `{ "content": "..." }` ([api-guide.txt:37](../_source/api-guide.txt:37)-[39](../_source/api-guide.txt:39)).

Semantics:

- Captures the current pane content, not full scrollback ([api-guide.txt:37](../_source/api-guide.txt:37)-[39](../_source/api-guide.txt:39)).
- Installed server returns HTTP `409` if the tab session is not running.
- This endpoint is not useful for `web-browser` tabs because they are not tmux-backed.

### `purplemux tab close`

Syntax: `purplemux tab close -w WS TAB_ID` or `--workspace WS`.

Behavior: closes the tab. The API guide says this kills the tmux session and removes the tab from layout ([api-guide.txt:26](../_source/api-guide.txt:26)-[27](../_source/api-guide.txt:27)). The CLI ignores the JSON body and prints literal `ok\n` for any successful response ([cli.js:148](../_source/cli.js:148)-[158](../_source/cli.js:158)).

HTTP:

- Method/path: `DELETE /api/cli/tabs/<tabId>`
- Query: required `workspaceId=WS`
- Body: none
- Installed response: `{ "ok": true | false }`
- CLI output: `ok`

Semantics:

- For non-browser tabs, removing the tab kills the tmux session.
- For `web-browser` tabs, installed layout code skips tmux kill.

### API-only: `GET /api/cli/tabs/<tabId>`

There is no CLI wrapper command for tab info, but the API guide documents it ([api-guide.txt:22](../_source/api-guide.txt:22)-[24](../_source/api-guide.txt:24)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>`
- Query: required `workspaceId=WS`
- Body: none
- Response: `{ "tabId", "workspaceId", "paneId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId" }`

## 5. Browser Commands And HTTP Mapping

All browser CLI subcommands share the following preconditions:

- Target tab must have `panelType: "web-browser"`.
- Webview must be attached; the API guide says `dom-ready` must have fired at least once.
- Electron runtime is required; headless/remote mode returns `503`.

These constraints are documented in [api-guide.txt:41](../_source/api-guide.txt:41)-[45](../_source/api-guide.txt:45).

Common server errors observed for browser endpoints:

- `403 { "error": "Forbidden" }` for missing/invalid token.
- `400 { "error": "workspaceId is required" }`.
- `404 { "error": "Tab not found" }`.
- `400 { "error": "Tab is not a web-browser panel" }`.
- `503 { "error": "Browser bridge unavailable (Electron-only feature)" }`.
- `405 { "error": "Method not allowed" }` with `Allow`.

### `purplemux tab browser url`

Syntax: `purplemux tab browser url -w WS TAB_ID` or `--workspace WS`.

Behavior: returns the current URL and title for a web-browser tab ([cli.js:171](../_source/cli.js:171)-[175](../_source/cli.js:175)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>/browser/url`
- Query: required `workspaceId=WS`
- Body: none
- Response: `{ "tabId", "url", "title" }` ([api-guide.txt:47](../_source/api-guide.txt:47)-[49](../_source/api-guide.txt:49)).

Edge cases:

- Installed server returns HTTP `409 { "error": "Browser tab not attached yet" }` if the bridge has no URL for the tab yet.

### `purplemux tab browser screenshot`

Syntax:

- `purplemux tab browser screenshot -w WS TAB_ID`
- `purplemux tab browser screenshot -w WS TAB_ID -o FILE`
- `purplemux tab browser screenshot -w WS TAB_ID --output FILE`
- `purplemux tab browser screenshot -w WS TAB_ID --full`

Flags:

- `-o FILE` or `--output FILE`: save raw PNG bytes to file.
- `--full`: request full-page capture.

Behavior:

- CLI computes `full=1` when `--full` is present, else `full=0` ([cli.js:177](../_source/cli.js:177)-[180](../_source/cli.js:180)).
- With `-o/--output`, CLI performs a raw download, writes bytes to the requested path, and prints `{ "saved": "...", "bytes": N }` ([cli.js:181](../_source/cli.js:181)-[185](../_source/cli.js:185)).
- Without output, CLI requests `format=base64` and prints JSON ([cli.js:186](../_source/cli.js:186)-[188](../_source/cli.js:188)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>/browser/screenshot`
- Query: required `workspaceId=WS`; optional `full=1`; optional `format=base64`
- Body: none
- Default response: `image/png` bytes ([api-guide.txt:51](../_source/api-guide.txt:51)-[53](../_source/api-guide.txt:53)).
- Base64 response per guide: `{ "base64": "..." }`; installed server returns `{ "tabId": "...", "format": "png", "base64": "..." }`.

Edge cases:

- Server accepts `full=1` or `full=true`; CLI only sends `1` or `0`.
- Capture errors return HTTP `409 { "error": "<message>" }`.

### `purplemux tab browser console`

Syntax:

- `purplemux tab browser console -w WS TAB_ID`
- `purplemux tab browser console -w WS TAB_ID --since MS`
- `purplemux tab browser console -w WS TAB_ID --level LEVEL`

Flags:

- `--since MS`: filter entries at/after a timestamp in milliseconds.
- `--level LEVEL`: exact match on entry `level`.

Behavior: reads recent console entries from a browser tab ([cli.js:192](../_source/cli.js:192)-[199](../_source/cli.js:199)).

HTTP:

- Method/path: `GET /api/cli/tabs/<tabId>/browser/console`
- Query: required `workspaceId=WS`; optional `since=MS`; optional `level=LEVEL`
- Body: none
- Response: `{ "tabId", "entries": [{ "level", "text", "ts", "source"?, "url"?, "line"? }] }` ([api-guide.txt:55](../_source/api-guide.txt:55)-[57](../_source/api-guide.txt:57)).

Semantics:

- Ring buffer size is the last 500 console entries ([api-guide.txt:55](../_source/api-guide.txt:55)-[57](../_source/api-guide.txt:57)).
- Entries include console messages, log entries, and exceptions ([api-guide.txt:55](../_source/api-guide.txt:55)-[57](../_source/api-guide.txt:57)).
- Installed server parses invalid `since` as `0`; invalid/missing `level` means no level filter.
- `level` is not validated against an enum by the CLI or observed route; it is an exact string filter.

### `purplemux tab browser network`

Syntax:

- `purplemux tab browser network -w WS TAB_ID`
- `purplemux tab browser network -w WS TAB_ID --since MS`
- `purplemux tab browser network -w WS TAB_ID --method M`
- `purplemux tab browser network -w WS TAB_ID --url SUBSTR`
- `purplemux tab browser network -w WS TAB_ID --status CODE`
- `purplemux tab browser network -w WS TAB_ID --request ID`

Flags:

- `--since MS`: filter entries at/after a timestamp in milliseconds.
- `--method M`: HTTP method filter.
- `--url SUBSTR`: URL substring filter.
- `--status CODE`: numeric HTTP status filter.
- `--request ID`: fetch response body for one request instead of listing entries.

Behavior: reads recent network entries or fetches one cached response body ([cli.js:202](../_source/cli.js:202)-[215](../_source/cli.js:215)).

HTTP list mode:

- Method/path: `GET /api/cli/tabs/<tabId>/browser/network`
- Query: required `workspaceId=WS`; optional `since=MS`, `method=M`, `url=SUBSTR`, `status=CODE`
- Body: none
- Response: `{ "tabId", "entries": [{ "requestId", "method", "url", "status"?, "mimeType"?, "resourceType"?, "error"?, "ts", "endedAt"? }] }` ([api-guide.txt:59](../_source/api-guide.txt:59)-[62](../_source/api-guide.txt:62)).

HTTP body mode:

- Method/path: `GET /api/cli/tabs/<tabId>/browser/network`
- Query: required `workspaceId=WS`, `requestId=RID`
- Body: none
- Response: `{ "tabId", "requestId", "body" }` ([api-guide.txt:64](../_source/api-guide.txt:64)-[66](../_source/api-guide.txt:66)).

Semantics:

- Ring buffer size is the last 500 requests ([api-guide.txt:59](../_source/api-guide.txt:59)-[60](../_source/api-guide.txt:60)).
- Response bodies are cached after first call ([api-guide.txt:64](../_source/api-guide.txt:64)-[66](../_source/api-guide.txt:66)).
- Installed server uppercases `--method` before filtering.
- Installed server treats `--url` as substring match.
- Installed server parses invalid `since` as `0`.
- Installed server ignores invalid `status` filters rather than throwing.
- If `--request ID` is present, request body mode bypasses the list filters.
- Installed server returns HTTP `404 { "error": "Response body unavailable" }` when a body cannot be fetched.

### `purplemux tab browser eval`

Syntax: `purplemux tab browser eval -w WS TAB_ID EXPR` or `--workspace WS`.

Required:

- `-w WS` / `--workspace WS`
- `TAB_ID`
- `EXPR`

Behavior: evaluates a JavaScript expression inside the web-browser tab and prints the serialized result ([cli.js:218](../_source/cli.js:218)-[222](../_source/cli.js:222)).

HTTP:

- Method/path: `POST /api/cli/tabs/<tabId>/browser/eval`
- Query: required `workspaceId=WS`
- Body: `{ "expression": "..." }` ([api-guide.txt:68](../_source/api-guide.txt:68)-[70](../_source/api-guide.txt:70)).
- Response: `{ "tabId", "value" }` ([api-guide.txt:70](../_source/api-guide.txt:70)-[72](../_source/api-guide.txt:72)).

Semantics:

- API guide says evaluation uses CDP `Runtime.evaluate` with `returnByValue`, `awaitPromise`, and a 10 second timeout ([api-guide.txt:68](../_source/api-guide.txt:68)-[72](../_source/api-guide.txt:72)).
- CLI-side missing expression exits with `expression is required` ([cli.js:218](../_source/cli.js:218)-[221](../_source/cli.js:221)).
- Installed server returns HTTP `400 { "error": "expression is required" }` if the body expression is missing or non-string.
- Evaluation failures return HTTP `409 { "error": "<message>" }`.

### Browser Dispatcher Errors

The `tab browser` command requires a browser subcommand. Missing subcommand exits with `browser subcommand required (url | screenshot | console | network | eval)` ([cli.js:161](../_source/cli.js:161)-[167](../_source/cli.js:167)). Unknown browser subcommands exit with `unknown browser subcommand: <sub>. Use url | screenshot | console | network | eval` ([cli.js:225](../_source/cli.js:225)-[226](../_source/cli.js:226)).

## 6. `api-guide` And `help`

### `purplemux api-guide`

Syntax: `purplemux api-guide`

Behavior: fetches markdown text from the server and writes it to stdout ([cli.js:230](../_source/cli.js:230)-[236](../_source/cli.js:236)).

HTTP:

- Method/path: `GET /api/cli/api-guide`
- Query/body: none
- Request header: `X-Pmux-Token`
- Response: `text/markdown; charset=utf-8`
- Non-ok behavior: this command exits with only `HTTP <status>` and does not parse JSON error bodies ([cli.js:230](../_source/cli.js:230)-[236](../_source/cli.js:236)).

### `purplemux help`

Syntax: `purplemux help`

Behavior: prints usage text and does not require a running server. The usage text in `cli.js` matches `docs/_source/help.txt` ([cli.js:259](../_source/cli.js:259)-[286](../_source/cli.js:286), [help.txt:1](../_source/help.txt:1)-[26](../_source/help.txt:26)).

No HTTP endpoint.

## 7. Enums, Constraints, Defaults, And Status Codes

### Enums

`panelType` allowed values:

- `terminal`
- `claude-code`
- `codex-cli`
- `agent-sessions`
- `web-browser`
- `diff`

Cited in usage ([cli.js:267](../_source/cli.js:267), [help.txt:8](../_source/help.txt:8)) and the API guide ([api-guide.txt:16](../_source/api-guide.txt:16)-[18](../_source/api-guide.txt:18)).

### Defaults

| Surface | Default |
|---|---|
| Server command when no top-level command | Start server ([purplemux.js:27](../_source/purplemux.js:27)-[30](../_source/purplemux.js:30)). |
| Server command when top-level `start` | Start server ([purplemux.js:27](../_source/purplemux.js:27)-[30](../_source/purplemux.js:30)). |
| CLI base URL | `http://localhost:${PORT}` ([cli.js:19](../_source/cli.js:19)-[21](../_source/cli.js:21)). |
| `tab create` `panelType` | Server defaults to `terminal` when omitted. |
| `tab create` `name` | Optional. Installed layout code uses a panel-type default name for some panel types, otherwise empty. |
| `tab list` workspace | Omitted means all workspaces ([api-guide.txt:12](../_source/api-guide.txt:12)-[14](../_source/api-guide.txt:14)). |
| Browser screenshot `full` | CLI sends `full=0` unless `--full` is present ([cli.js:177](../_source/cli.js:177)-[180](../_source/cli.js:180)). |
| Browser screenshot output | Without `-o/--output`, CLI requests JSON base64; with output, raw PNG file ([cli.js:181](../_source/cli.js:181)-[188](../_source/cli.js:188)). |
| Browser console/network ring buffers | Last 500 entries/requests ([api-guide.txt:55](../_source/api-guide.txt:55)-[60](../_source/api-guide.txt:60)). |

### CLI-side required argument errors

| Condition | Error |
|---|---|
| Missing port | `PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)` ([cli.js:28](../_source/cli.js:28)-[30](../_source/cli.js:30)). |
| Missing token | `PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)` ([cli.js:28](../_source/cli.js:28)-[31](../_source/cli.js:31)). |
| `tab create` missing workspace | `--workspace is required` ([cli.js:86](../_source/cli.js:86)-[92](../_source/cli.js:92)). |
| Tab commands missing workspace | `--workspace is required` ([cli.js:100](../_source/cli.js:100)-[103](../_source/cli.js:103)). |
| `tab send/status/result/close` missing tab id | `tab ID is required` ([cli.js:111](../_source/cli.js:111), [cli.js:126](../_source/cli.js:126), [cli.js:139](../_source/cli.js:139), [cli.js:152](../_source/cli.js:152)). |
| `tab send` missing content | `content is required` ([cli.js:111](../_source/cli.js:111)-[112](../_source/cli.js:112)). |
| `tab browser` missing subcommand | `browser subcommand required (url | screenshot | console | network | eval)` ([cli.js:161](../_source/cli.js:161)-[167](../_source/cli.js:167)). |
| `tab browser ...` missing tab id | `tab ID is required` ([cli.js:164](../_source/cli.js:164)-[168](../_source/cli.js:168)). |
| `tab browser eval` missing expression | `expression is required` ([cli.js:218](../_source/cli.js:218)-[221](../_source/cli.js:221)). |
| Unknown tab command | `unknown tab command: <sub>. Run 'purplemux help' for usage.` ([cli.js:298](../_source/cli.js:298)-[307](../_source/cli.js:307)). |
| Unknown CLI command inside `cli.js` | `unknown command: <cmd>. Run 'purplemux help' for usage.` ([cli.js:316](../_source/cli.js:316)-[318](../_source/cli.js:318)). |
| Unknown entrypoint command | `unknown command: <cmd>\nRun 'purplemux help' for usage.` ([purplemux.js:31](../_source/purplemux.js:31)-[33](../_source/purplemux.js:33)). |

### HTTP status/error inventory

| Status | Error/body | Applies to |
|---|---|---|
| `200` | Normal JSON response | Most successful GET/POST actions. |
| `201` | Created tab JSON | `POST /api/cli/tabs`. |
| `200 image/png` | Raw PNG bytes | Browser screenshot without `format=base64` ([api-guide.txt:51](../_source/api-guide.txt:51)-[53](../_source/api-guide.txt:53)). |
| `400` | `workspaceId is required` | Workspace-scoped tab endpoints when query/body is missing. |
| `400` | `content is required` | Send endpoint body missing content. |
| `400` | `expression is required` | Browser eval body missing/non-string expression. |
| `400` | `Invalid panelType`, with `validPanelTypes` | `POST /api/cli/tabs` invalid type ([api-guide.txt:16](../_source/api-guide.txt:16)-[18](../_source/api-guide.txt:18)). |
| `400` | `Tab is not a web-browser panel` | Browser endpoints against non-browser tabs. |
| `403` | `Forbidden` | Missing/invalid `x-pmux-token`. |
| `404` | `Workspace not found` | `POST /api/cli/tabs` unknown workspace. |
| `404` | `Tab not found` | Workspace-scoped tab lookup failed. |
| `404` | `Response body unavailable` | Browser network `requestId` body unavailable. |
| `405` | `Method not allowed`, `Allow` header | Wrong HTTP method. |
| `409` | `Tab session is not running` | Send/result against dead tmux-backed tab. |
| `409` | `Browser tab not attached yet` | Browser URL before webview attach. |
| `409` | capture/evaluation failure message | Browser screenshot/eval failure. |
| `409` | `agent-not-installed` / `agent-path-missing` with provider metadata | Creating unavailable agent-backed panel. |
| `500` | `No pane available in workspace` | Create tab when layout has no pane. |
| `500` | `Failed to create tab` or thrown message | Create tab failure. |
| `503` | `Browser bridge unavailable (Electron-only feature)` | Browser endpoints in headless/non-Electron mode ([api-guide.txt:41](../_source/api-guide.txt:41)-[45](../_source/api-guide.txt:45)). |

## 8. Candidate MCP Tools

| CLI capability | Proposed MCP tool | Inputs | Output |
|---|---|---|---|
| Resolve connection/auth | `purplemux_connection_info` | none or `{ refresh?: boolean }` | `{ baseUrl, portSource, tokenSource, hasToken }`; never expose token unless explicitly needed by internal client. |
| `purplemux` / `purplemux start` | `purplemux_start_server` | `{ port?: number, host?: string }` | `{ started: boolean, port, baseUrl }`; optional because MCP may connect to an already running server. |
| `purplemux help` | `purplemux_help` | none | `{ text }` usage text. |
| `purplemux api-guide` | `purplemux_api_guide` | none | `{ text }` markdown API guide. |
| `purplemux workspaces` | `purplemux_list_workspaces` | none | `{ workspaces: [{ id, name, directories }] }`. |
| `purplemux tab list [-w WS]` | `purplemux_list_tabs` | `{ workspaceId?: string }` | `{ tabs: [{ tabId, workspaceId, name, sessionName, panelType, agentProviderId, agentSessionId }] }`. |
| API-only tab info | `purplemux_get_tab` | `{ workspaceId: string, tabId: string }` | `{ tabId, workspaceId, paneId, name, sessionName, panelType, agentProviderId, agentSessionId }`. |
| `purplemux tab create` | `purplemux_create_tab` | `{ workspaceId: string, name?: string, panelType?: "terminal" | "claude-code" | "codex-cli" | "agent-sessions" | "web-browser" | "diff" }` | `{ tabId, workspaceId, paneId, sessionName, name, panelType, agentProviderId, agentSessionId }`. |
| `purplemux tab send` | `purplemux_send_tab_input` | `{ workspaceId: string, tabId: string, content: string }` | `{ status: "sent" }`. |
| `purplemux tab status` | `purplemux_get_tab_status` | `{ workspaceId: string, tabId: string }` | `{ tabId, workspaceId, alive, command?, cliState?, agentProviderId, agentSessionId, claudeSessionId }`. |
| `purplemux tab result` | `purplemux_capture_tab_result` | `{ workspaceId: string, tabId: string }` | `{ content: string | null }`. |
| `purplemux tab close` | `purplemux_close_tab` | `{ workspaceId: string, tabId: string }` | `{ ok: boolean }`. |
| `purplemux tab browser url` | `purplemux_browser_get_url` | `{ workspaceId: string, tabId: string }` | `{ tabId, url, title }`. |
| `purplemux tab browser screenshot` | `purplemux_browser_screenshot` | `{ workspaceId: string, tabId: string, full?: boolean, outputMode?: "base64" | "bytes" | "file", path?: string }` | Base64 mode: `{ tabId, format: "png", base64 }`; file mode: `{ saved, bytes }`; bytes mode: PNG binary/resource. |
| `purplemux tab browser console` | `purplemux_browser_console` | `{ workspaceId: string, tabId: string, since?: number, level?: string }` | `{ tabId, entries: [{ level, text, ts, source?, url?, line? }] }`. |
| `purplemux tab browser network` list | `purplemux_browser_network` | `{ workspaceId: string, tabId: string, since?: number, method?: string, url?: string, status?: number }` | `{ tabId, entries: [{ requestId, method, url, status?, mimeType?, resourceType?, error?, ts, endedAt? }] }`. |
| `purplemux tab browser network --request` | `purplemux_browser_network_body` | `{ workspaceId: string, tabId: string, requestId: string }` | `{ tabId, requestId, body }`. |
| `purplemux tab browser eval` | `purplemux_browser_eval` | `{ workspaceId: string, tabId: string, expression: string }` | `{ tabId, value }`. |

## 9. MCP Design Notes

- Prefer HTTP API calls over shelling out to `purplemux` for structured MCP tools. The CLI is a thin wrapper over HTTP and loses some response bodies, especially `tab close`.
- Preserve token handling internally; never return the CLI token to model-visible output unless a diagnostic mode explicitly requires it.
- Validate `panelType` client-side using the enum above, but also surface server `validPanelTypes` on 400 because server is authoritative.
- Treat browser endpoints as Electron-only and expose `503` as a capability/runtime error rather than retrying blindly.
- Do not require `workspaceId` for tab listing; cross-workspace listing is documented behavior.
- Require `workspaceId` for all single-tab operations even if `tabId` appears globally unique; the API requires it.
- Expose browser screenshot output as either base64 JSON or binary/file resource; the CLI's `-o` behavior is local file writing, while the HTTP API can return raw PNG bytes.
- For send semantics, document bracketed paste explicitly because it can submit multi-line content differently than terminal keystroke simulation.
- Surface `web-browser` `alive: false` as normal; do not classify it as dead without querying browser-specific endpoints.
- Note the `memory`/`mem` command discrepancy as unsupported until `cli.js` implements cases.
