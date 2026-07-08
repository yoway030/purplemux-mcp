/**
 * LLM-facing usage documentation — single source.
 *
 * Exposed twice:
 *  - SERVER_INSTRUCTIONS: concise version passed as the MCP server
 *    `instructions` field, so every connected client sees the tool layering
 *    and the golden path without calling anything.
 *  - ORCHESTRATION_GUIDE: full markdown returned by the pmux_guide tool.
 *
 * Keep the two consistent: SERVER_INSTRUCTIONS is a distillation of the
 * guide, never a different story. English on purpose — tool descriptions
 * are English and this text is consumed by models, not humans.
 */

export const SERVER_INSTRUCTIONS = `purplemux-mcp drives a local purplemux (tmux + LLM workspace manager): workspaces, tabs, terminals, Electron browser panels — and, as the primary use case, claude/codex CLI subagents running inside tabs.

TOOL LAYERS — pick the right one:
- Subagent orchestration (PRIMARY): pmux_agent_start → pmux_agent_wait_ready → pmux_agent_turn (or pmux_agent_send + pmux_agent_capture) → pmux_close_tab. pmux_agent_start creates the terminal tab, launches the CLI with hooks and boot verification, and manages readiness/completion evidence for you.
- Low-level tab/terminal tools (pmux_create_tab, pmux_send_input, pmux_capture_pane, ...) are for plain terminals and manual fallback ONLY. Do NOT run a subagent by creating a claude-code/codex-cli panelType tab and sending text into it — that panelType is a UI panel, not a managed agent session; it can be an empty shell, and nothing tracks readiness or recovers output.

Golden path for a subagent:
1. pmux_list_workspaces → workspaceId
2. Ask the user which model/effort (codex: sandbox, claude: permissionMode) to use, unless already specified
3. pmux_agent_start → returns tabId, bootId, recommendedFileOutput
4. pmux_agent_wait_ready {bootId, expectEcho:true} → agent_ready only on bootstrap-echo completion evidence
5. pmux_agent_turn from turn=1 (turn 0 was the bootstrap echo; do not pass expectPrevTurnEnd on turn 1). agentId is caller-chosen: pick a short id (e.g. "worker1"; not "boot" — reserved by the bootstrap echo) and reuse it for every turn of this tab. If recommendedFileOutput was false, pass fileOutput:false.
6. pmux_close_tab when the task is finished

For failure modes, recovery patterns, and full semantics call pmux_guide. For the purplemux HTTP API reference call pmux_api_guide. Browser tools need Electron (503 when headless); web-browser tabs always report alive:false — that is normal, not a dead tab.`;

export const ORCHESTRATION_GUIDE = `# purplemux-mcp orchestration guide

This server exposes a local purplemux instance (tmux + LLM workspace manager)
as MCP tools. Its primary use case: driving **claude/codex CLI subagents**
that run inside purplemux tabs (cross-LLM fan-out on flat-rate subscription
CLIs).

## 1. Tool layers — choose correctly

| Layer | Tools | Use for |
|---|---|---|
| **Agent orchestration (PRIMARY)** | pmux_agent_start · pmux_agent_wait_ready · pmux_agent_send · pmux_agent_capture · pmux_agent_status · pmux_agent_turn | Running claude/codex subagents. Handles tab creation, CLI launch, hook wiring, boot verification, readiness, and lossless output recovery. |
| Tab / terminal (low-level) | pmux_list_workspaces · pmux_list_tabs · pmux_create_tab · pmux_get_tab · pmux_send_input · pmux_tab_status · pmux_capture_pane · pmux_close_tab | Plain terminal work (run a build, tail a log) and manual fallback when agent tools report something ambiguous. |
| Browser (Electron only) | pmux_browser_url · _screenshot · _console · _network · _network_body · _eval | Inspecting web-browser tabs. 503 on headless purplemux (hard); 409 "not attached yet" right after creation (transient). |
| Meta | pmux_guide (this) · pmux_api_guide (purplemux HTTP API reference) · pmux_connection_info | Self-documentation and diagnostics. |

**Anti-pattern (the most common mistake):** \`pmux_create_tab\` with
panelType \`claude-code\`/\`codex-cli\` + \`pmux_send_input\`. That panelType
creates a **UI panel**, not a managed agent session — the pane may be an
empty shell before the UI attaches, your "prompt" may land in a bash prompt,
and nothing tracks readiness or recovers the response. Subagents go through
\`pmux_agent_start\`, which launches the CLI in a plain terminal tab under
full protocol control.

## 2. Golden path (one subagent, N turns)

1. \`pmux_list_workspaces\` → pick \`workspaceId\`.
2. **Ask the user** which model/effort each subagent should use (codex:
   also sandbox; claude: also permissionMode) — unless the user already
   specified them. Do not silently launch with defaults.
3. \`pmux_agent_start {workspaceId, provider, model?, effort?, sandbox?/permissionMode?}\`
   → returns \`tabId\`, \`bootId\`, \`hooksWired\`, \`recommendedFileOutput\`,
   \`bootstrapEcho\`. Non-blocking: the CLI is still booting.
4. \`pmux_agent_wait_ready {workspaceId, tabId, provider, bootId, expectEcho:true}\`
   → \`agent_ready\` is returned **only** when the bootstrap echo's DONE
   marker appears (completion evidence — the model demonstrably answered).
5. Work turns with \`pmux_agent_turn {workspaceId, tabId, provider, agentId, turn, prompt, ...}\`:
   - \`agentId\` is **caller-chosen**: invent a short id (\`^[a-z0-9][a-z0-9_-]{0,31}$\`,
     e.g. \`worker1\`; not \`boot\` — reserved by the bootstrap echo) and reuse
     it for every turn of this tab, so report-file paths and prev-turn
     markers line up.
   - **turn starts at 1** (the bootstrap echo consumed turn 0). Do not pass
     \`expectPrevTurnEnd\` on turn 1. On later turns it is optional strictness:
     \`pmux_agent_turn\` is already safe to call right after a previous turn;
     pass \`expectPrevTurnEnd\` + \`expectPrevRequestId\` only when you want the
     send to hard-fail unless the previous turn's completion marker is visible.
   - If \`recommendedFileOutput\` was \`false\` (codex read-only / claude plan
     mode: the agent cannot write files), pass \`fileOutput:false\`.
   - \`pmux_agent_turn\` = send → poll → recover in one call; for manual pacing
     use \`pmux_agent_send\` + \`pmux_agent_capture\`.
6. \`pmux_close_tab\` when the task is finished. Never leak tabs.

## 3. Boot verification semantics

\`pmux_agent_start\` wires two independent boot signals:

- **Boot file** (\`bootId\` → \`~/.purplemux/boot/<bootId>\`): a SessionStart
  hook writes it when the CLI *process* starts. Reported as \`boot.fileSeen\`
  by \`pmux_agent_wait_ready\`. **Diagnostic only** — never gates readiness.
  Check \`bootWired\` in the start response first: when it is \`false\` (hook
  wiring failed and the server degraded to a plain launch), no boot file
  will ever be written and \`fileSeen:false\` carries no signal.
- **Bootstrap echo** (\`bootstrapEcho\`, default true): a fixed initial prompt
  makes the *model* print a DONE marker (req=bootId). \`wait_ready\` with
  \`{bootId, expectEcho:true}\` returns \`agent_ready\` only on this evidence.
  Costs one tiny model turn; pass \`bootstrapEcho:false\` to skip (then
  readiness falls back to heuristics).

On an \`expectEcho\` timeout, the two bits diagnose the failure:

| fileSeen | echoSeen | Meaning |
|---|---|---|
| false | false | CLI never started (launch failure). On a codex first launch fileSeen:false alone is inconclusive (hook trust, below) — diagnose the echo failure from the pane |
| true | false | Process up, model never answered (auth/limit/hang) — check pane tail |
| any | true | Ready (echo evidence wins) |

**codex hook trust** (observed behavior, codex v0.142.5, 2026-07-08): the
FIRST launch that wires the boot hook requires a one-time interactive trust
approval in the codex TUI. Until approved, \`fileSeen:false\` +
\`echoSeen:true\` is a normal state on codex, not a failure.

## 4. Output recovery (fileOutput routing)

- \`fileOutput:true\` (default): the subagent writes its answer to a report
  file (\`workspaceDir/.pmux-agents/<agentId>/turn-<n>.md\`) with a request-id
  identity line and EOF commit marker; recovery is lossless regardless of
  pane scrollback. Use whenever the agent can write files.
- \`fileOutput:false\`: pane BEGIN/END marker fallback. **Required** when
  \`recommendedFileOutput\` was false (read-only/plan agents cannot write).
- \`pmux_agent_capture\` returning \`partial\`/\`working\` means the turn is
  still in flight — do **not** send the next turn yet.

## 5. State signals

- \`signalSource:"cliState"\` — deterministic hook-push channel (hooksWired
  sessions). Trust it. \`signalSource:"pane"\` — screen-text heuristics;
  if ambiguous, verify with \`pmux_capture_pane\`.
- \`agent_blocked\` — the CLI is waiting for interactive input (approval
  dialog, plan review). Read the returned \`tail\`, then answer via
  \`pmux_send_input\` if appropriate.
- \`runtimeError {match,line}\` — independent fact, not a readiness verdict.
  A ready session may have silently lost its last turn to a 529/rate-limit.
  If runtimeError is present AND there is no completion evidence (no DONE
  marker / report file), treat the turn as lost and re-send the same prompt.
  \`pmux_agent_turn\` already returns \`status:"agent_error"\` early in this case.
  Note: a pane that merely *quotes* an error string (e.g. code review of
  error handling) can also match — read \`{match,line}\` before reacting.

## 6. Recovery cheat-sheet

| Symptom | Action |
|---|---|
| pmux_agent_start state:"not_shell_ready" | The CLI command was NOT sent (shell prompt never appeared) → inspect via pmux_capture_pane, close the tab, retry start |
| wait_ready timeout, fileSeen:false | Launch/hook problem → pmux_capture_pane to see the real screen (meaningless if bootWired was false) |
| wait_ready timeout, fileSeen:true | Model not answering → check tail for auth/usage-limit dialogs |
| pmux_agent_turn timeout | Use pmux_agent_capture with the returned requestId/marker — the turn may still complete |
| pmux_agent_send {sent:false, reason:"busy"} | Previous turn still running → poll pmux_agent_status/pmux_agent_capture, do not re-send |
| agent_blocked | Read tail; approve/answer via pmux_send_input if appropriate |
| Anything ambiguous | pmux_capture_pane (screen truth) + pmux_tab_status (process truth) |

## 7. Low-level rules (when you do drop down)

- \`pmux_send_input\` **auto-submits** (the server presses Enter). Never
  append a newline to submit; one trailing \\n is stripped.
- \`pmux_capture_pane\` is a viewport snapshot — long output scrolls away;
  that is exactly why the agent layer uses report files.
- web-browser tabs always report \`alive:false\` (upstream purplemux behavior:
  they are Electron webviews, not tmux sessions) — normal, probe with the
  browser tools instead.

## 8. Lifecycle contract

Keep the tab open for the whole task (the CLI session holds the subagent's
context), then \`pmux_close_tab\`. One tab = one subagent session. Ask the
user before launching subagents with non-obvious model/effort choices, and
report which model each result came from when merging cross-LLM outputs.
`;
