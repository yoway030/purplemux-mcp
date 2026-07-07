# purplemux-mcp

*[한국어](README.md) · English*

An MCP server that lets **Claude Code / Codex** drive a local
[purplemux](https://github.com/subicura/purplemux) instance (subicura's tmux + LLM
workspace manager) — controlling workspaces, tabs, terminals, and (Electron) browser panels
and **sub-agent orchestration** through **22 tools**.

purplemux's CLI is a thin wrapper over a localhost HTTP API, so this server exposes that API
directly as MCP tools (calling HTTP, not shelling out to the CLI). That lets an agent
orchestrate terminals and even **drive other AI-CLI sessions across LLM providers (cross-LLM)**.

Requires Node ≥ 20 and a running purplemux instance on the same host.

---

## Why — cross-LLM · subscription CLIs as sub-agents

The real purpose of this project is to **use the subscription-based CLIs (`claude-code`,
`codex-cli`) that run on top of tmux (purplemux) as cross-LLM sub-agents**.

- **Cross-LLM orchestration.** A single orchestrator can spin up **both Claude-family
  (`claude-code`) and GPT-family (`codex-cli`)** sessions as sub-agents at the same time —
  throwing the same problem at different models for **cross-verification / consensus**, or
  **routing** work to whichever model is strongest for it. You are not locked into one model
  family.
- **Leverage flat-rate subscriptions.** Wiring sub-agents over an API incurs **per-token
  billing**; Claude Code (Claude subscription) and Codex CLI (ChatGPT/Codex subscription) are
  interactive sessions that run under a **flat-rate subscription**. This reuses those sessions
  as workers.
- **The bridge.** purplemux hosts each subscription CLI in its own tmux pane (tab) and ships a
  local HTTP API to control them. **This MCP opens that API.** The orchestrator (e.g. this
  Claude Code) →
  1. `pmux_create_tab` to open a `claude-code` / `codex-cli` tab,
  2. `pmux_send_input` to push a task prompt (the server auto-submits with Enter),
  3. `pmux_tab_status` / `pmux_capture_pane` to poll progress and collect the result,
  4. `pmux_close_tab` to clean up.

In short: turn several LLMs' subscription CLI sessions into **callable worker agents** and run
**fan-out** orchestration — split work across tabs, run them in parallel, poll status, and merge
results from different models, all driven by natural language.

> Note: this repository was itself built in that spirit — its five stages (extract → design →
> build → review → test) were each gated by the **consensus of three cross-LLM sub-agents
> (Claude Sonnet / Claude Opus / Codex gpt-5.5-high)**. Cross-verification across models caught
> things a single model would have missed (e.g. the `send` auto-submit behavior, and a
> port-injection token leak).

---

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
read from `~/.purplemux/` **on every call** (no caching), so a purplemux restart / port change
is absorbed without restarting this server, and no env vars are needed on a normal host.

---

## Tools (22)

**Agent orchestration (v2 — recommended entry point):** `pmux_agent_start` · `pmux_agent_wait_ready` ·
`pmux_agent_send` · `pmux_agent_capture` · `pmux_agent_status` · `pmux_agent_turn`

> Boots claude/codex with purplemux's hooks injected (consuming the native `cliState`/`command`
> state channel) for deterministic readiness/busy detection, and retrieves responses losslessly
> via a file protocol (request-id identity + EOF commit double gate). `pmux_agent_turn` bundles
> send → poll → capture into one call per turn.
> Design & rationale: [docs/worklog-20260707-workflow/design-v2.md](docs/worklog-20260707-workflow/design-v2.md), [design-v22.md](docs/worklog-20260707-workflow/design-v22.md)

**Terminal/tab (works headless):** `pmux_list_workspaces` · `pmux_list_tabs` ·
`pmux_create_tab` · `pmux_get_tab` · `pmux_send_input` · `pmux_tab_status` ·
`pmux_capture_pane` · `pmux_close_tab`

**Browser (Electron only):** `pmux_browser_url` · `pmux_browser_screenshot` ·
`pmux_browser_console` · `pmux_browser_network` · `pmux_browser_network_body` ·
`pmux_browser_eval`

**Util:** `pmux_api_guide` · `pmux_connection_info` (never emits the token)

> `pmux_send_input` **auto-submits** (the server presses Enter) — do not append a newline; one
> trailing `\n` is stripped for you. Browser tools return **503** on a headless (non-Electron)
> purplemux, and **409 "not attached yet"** (transient) right after creating a `web-browser`
> tab.

Full features, install options, and usage examples: **[docs/USAGE.md](docs/USAGE.md)** (Korean).

---

## Develop / test

```bash
npm run build && npm run typecheck
npm run smoke     # handshake + 22 tools + a live list_workspaces
npm run unit      # pure-function unit tests (fixture-based)
npm run e2e       # live round-trip (12 checks) against a running purplemux
```

---

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

---

## How it was built

Five stages — extract → design → build → review → test — each gated by consensus of three
sub-agents (Claude Sonnet, Claude Opus, Codex gpt-5.5-high), with an orchestrator resolving
disputes empirically against the live server. See [docs/worklog/](docs/worklog/).

---

## License

MIT (this server). purplemux is a separate project by [subicura](https://github.com/subicura/purplemux).
