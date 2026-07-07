BLOCKED

## cworker v22-turn1 report

- Scope kept to tool layer files: `src/agents.ts`, `test/e2e.mjs`, plus this report.
- R0.1 implemented in `src/agents.ts`:
  - `pmux_agent_start` now appends Claude `--settings <home>/.purplemux/hooks.json` when present.
  - Codex keeps the existing command assembly and appends six fixed `hooks.<event>` `-c` args when `<home>/.purplemux/codex-hook.sh` exists.
  - Hook args interpolate only `os.homedir()`-derived fixed paths; model/effort/sandbox/permission inputs still pass existing allowlist/profile validation.
  - Start responses include `hooksWired`.
- R0.2 implemented in `src/agents.ts`:
  - `wait_ready`, `send`, and `status` read `tab_status.cliState` and `tab_status.command` before pane fallback.
  - `command in SHELL_NAMES` maps to `launch_failed` for `wait_ready`/`send`; `status` exposes neutral `shell_ready`.
  - `cliState` mapping uses the expected `mapCliState(provider, rawCliState)` profile helper; null/unknown falls back to existing pane classification.
  - Returns expose `signalSource`, `rawCliState`, and `command` where readiness/send/status decisions are surfaced.
  - `agent_blocked` is terminal in `wait_ready` and returns `sent:false, reason:"blocked"` from `send`.
  - `wait_ready` tracks `busySeen` and includes `rawCliState`, `command`, and `tail` on timeout.
- `test/e2e.mjs` updated:
  - `agent_start` now checks `hooksWired` and validates Codex hook command assembly against the local hook file presence.
  - `agent_status` shape check now requires `signalSource` and `rawCliState`.

## Verification

- `npm run typecheck` attempted.
- Blocked because sworker-side exports are not present yet:
  - `src/agents.ts`: missing `SHELL_NAMES` from `./profiles.js`
  - `src/agents.ts`: missing `mapCliState` from `./profiles.js`
- No edits were made to `src/profiles.ts`, `src/pane.ts`, unit tests, fixtures, or `package.json`.
