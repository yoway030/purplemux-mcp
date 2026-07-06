# purplemux-mcp

An MCP server that lets **Claude Code** and **Codex** drive a local
[purplemux](https://github.com/subicura/purplemux) instance — creating and controlling
workspaces, tabs, terminals, and (Electron) browser panels through 16 tools.

purplemux's CLI is a thin wrapper over a localhost HTTP API; this server exposes that API
as MCP tools (calling it directly rather than shelling out), so an agent can orchestrate
terminals and even drive *other* AI-CLI sessions (`claude-code` / `codex-cli` tabs).

Requires Node ≥ 20 and a running purplemux instance on the same host.

## Quick start

```bash
# 1. purplemux must be running (it writes ~/.purplemux/{port,cli-token})
# 2. build
npm install && npm run build            # -> dist/index.js

# 3. register (absolute path)
claude mcp add purplemux -s user -- node "$PWD/dist/index.js"
codex  mcp add purplemux        -- node "$PWD/dist/index.js"
```

Restart your Claude Code / Codex session and the `pmux_*` tools appear. Port and token are
read from `~/.purplemux/` **on every call** (no caching) — a purplemux restart / port change
is absorbed without restarting this server, and no env vars are needed on a normal host.

## Tools (16)

**Terminal/tab (works headless):** `pmux_list_workspaces` · `pmux_list_tabs` ·
`pmux_create_tab` · `pmux_get_tab` · `pmux_send_input` · `pmux_tab_status` ·
`pmux_capture_pane` · `pmux_close_tab`

**Browser (Electron only):** `pmux_browser_url` · `pmux_browser_screenshot` ·
`pmux_browser_console` · `pmux_browser_network` · `pmux_browser_network_body` ·
`pmux_browser_eval`

**Util:** `pmux_api_guide` · `pmux_connection_info` (never emits the token)

> `pmux_send_input` **auto-submits** (the server presses Enter) — do not append a newline;
> one trailing `\n` is stripped for you. Browser tools return **503** on a headless
> (non-Electron) purplemux, and **409 "not attached yet"** (transient) right after creating a
> `web-browser` tab.

Full features, install options (scopes, manual config, env overrides), and usage examples:
**[docs/USAGE.md](docs/USAGE.md)**.

## Develop / test

```bash
npm run build && npm run typecheck
node test/smoke.mjs    # handshake + 16 tools + a live list_workspaces
node test/e2e.mjs      # live round-trip (12 checks) against a running purplemux
```

## Layout

```
src/            # config, http, errors, schemas, tools, index (stdio bootstrap)
test/           # smoke + live e2e (Node, no framework)
docs/
  USAGE.md               # features · install · usage
  01-cli-features.md     # canonical CLI extraction
  02-mcp-design.md       # canonical MCP design
  worklog/               # per-stage work log (extract→design→build→review→test)
  panel/                 # 3-agent (Sonnet/Opus/Codex) stage drafts
  reference/             # frozen inputs used during extraction
```

## How it was built

Five stages — extract → design → build → review → test — each gated by consensus of three
sub-agents (Claude Sonnet, Claude Opus, Codex gpt-5.5-high), with an orchestrator resolving
disputes empirically against the live server (e.g. confirming `send` auto-submit; catching a
port-injection token-leak in review). See [docs/worklog/](docs/worklog/).

## License

MIT (this server). purplemux is a separate project by [subicura](https://github.com/subicura/purplemux).
