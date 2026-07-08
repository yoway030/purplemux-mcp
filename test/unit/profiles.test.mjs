// Unit tests for src/profiles.ts (dist/ build).
import { assert, assertEqual, check, throws } from "./helpers.mjs";

import {
  buildAgentCommand,
  compileUserPattern,
  mapCliState,
  SHELL_NAMES,
} from "../../dist/profiles.js";

// ---- buildAgentCommand ------------------------------------------------

check("buildAgentCommand: codex normal", () => {
  const { command } = buildAgentCommand({
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
    sandbox: "workspace-write",
  });
  assertEqual(
    command,
    "codex --no-alt-screen -s workspace-write -m gpt-5.5 -c model_reasoning_effort=high",
  );
});

check("buildAgentCommand: codex defaults (no model/effort)", () => {
  const { command } = buildAgentCommand({ provider: "codex" });
  assertEqual(command, "codex --no-alt-screen -s read-only");
});

check("buildAgentCommand: claude normal", () => {
  const { command } = buildAgentCommand({
    provider: "claude",
    model: "claude-sonnet-5",
    permissionMode: "acceptEdits",
  });
  assertEqual(
    command,
    "claude --model claude-sonnet-5 --permission-mode acceptEdits",
  );
});

check("buildAgentCommand: claude effort → --effort flag (claude >=2.1.202, 실측 2026-07-08)", () => {
  const { command } = buildAgentCommand({
    provider: "claude",
    effort: "xhigh",
  });
  assertEqual(command, "claude --permission-mode plan --effort xhigh");
});

check("buildAgentCommand: rejects command-injection attempts in model", () => {
  const attempts = [
    "gpt-5.5; rm -rf /",
    "gpt-5.5 && echo pwned",
    "gpt-5.5`whoami`",
    "gpt-5.5 --dangerously-skip",
    "gpt-5.5\ninjected",
    "",
  ];
  for (const model of attempts) {
    let threw = false;
    try {
      buildAgentCommand({ provider: "codex", model });
    } catch (e) {
      threw = true;
      assert(e && e.name === "ToolError", `expected ToolError for model=${JSON.stringify(model)}`);
    }
    assert(threw, `expected buildAgentCommand to reject model=${JSON.stringify(model)}`);
  }
});

check("buildAgentCommand: rejects invalid sandbox/permissionMode enums", () => {
  assert(
    throws(() => buildAgentCommand({ provider: "codex", sandbox: "danger-full-access" })),
    "must reject non-allowlisted sandbox",
  );
  assert(
    throws(() => buildAgentCommand({ provider: "claude", permissionMode: "bypassPermissions" })),
    "must reject bypassPermissions (excluded from v1 enum per design §0.3)",
  );
});

// ---- compileUserPattern -------------------------------------------------

check("compileUserPattern: rejects >200 chars", () => {
  const long = "a".repeat(201);
  assert(throws(() => compileUserPattern(long, "readyPattern")), "must reject overlong pattern");
});

check("compileUserPattern: accepts exactly 200 chars", () => {
  const ok = "a".repeat(200);
  const re = compileUserPattern(ok, "readyPattern");
  assert(re instanceof RegExp, "should compile");
});

check("compileUserPattern: rejects invalid regex source as ToolError", () => {
  let threw = false;
  try {
    compileUserPattern("(unclosed", "errorPattern");
  } catch (e) {
    threw = true;
    assert(e && e.name === "ToolError", "must throw ToolError, not raw SyntaxError");
  }
  assert(threw, "expected compileUserPattern to throw on bad regex");
});

check("compileUserPattern: valid regex compiles and matches", () => {
  const re = compileUserPattern("^ready\\$", "readyPattern");
  assert(re.test("ready$"), "compiled regex should match its own literal source");
});

// ---- mapCliState (design v22 R0.1b) --------------------------------------

check("mapCliState: common busy/notification mappings (both providers)", () => {
  assertEqual(mapCliState("codex", "busy"), "agent_busy");
  assertEqual(mapCliState("claude", "busy"), "agent_busy");
  assertEqual(mapCliState("codex", "notification"), "agent_blocked");
  assertEqual(mapCliState("claude", "notification"), "agent_blocked");
});

check("mapCliState: needs-input → agent_ready for both providers", () => {
  assertEqual(mapCliState("codex", "needs-input"), "agent_ready");
  assertEqual(mapCliState("claude", "needs-input"), "agent_ready");
});

check("mapCliState: ready-for-review is provider-specific (no blanket mapping)", () => {
  assertEqual(mapCliState("codex", "ready-for-review"), "agent_ready");
  // claude: 실측 2026-07-08 — ready-for-review appears after a NORMAL
  // completed turn in acceptEdits mode too, so the old agent_blocked
  // mapping permanently blocked every subsequent send. Degraded to null
  // (pane heuristic decides; approval dialogs are caught there).
  assertEqual(mapCliState("claude", "ready-for-review"), null);
});

check("mapCliState: idle/unknown/未支持 values fall back to null (pane heuristic)", () => {
  for (const provider of ["codex", "claude"]) {
    assertEqual(mapCliState(provider, "idle"), null);
    assertEqual(mapCliState(provider, "unknown"), null);
    assertEqual(mapCliState(provider, "some-future-cli-state"), null);
    assertEqual(mapCliState(provider, ""), null);
  }
});

// ---- SHELL_NAMES ----------------------------------------------------------

check("SHELL_NAMES: contains exactly bash/zsh/fish/sh/dash", () => {
  const names = Array.from(SHELL_NAMES);
  for (const n of ["bash", "zsh", "fish", "sh", "dash"]) {
    assert(names.includes(n), `SHELL_NAMES must include ${n}`);
  }
  assertEqual(names.length, 5, "SHELL_NAMES must not carry extra entries");
});
