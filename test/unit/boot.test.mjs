// Unit tests for src/boot.ts (dist/ build).
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { assert, assertEqual, check, checkAsync, throws } from "./helpers.mjs";

import {
  BOOTSTRAP_ECHO_AGENT_ID,
  BOOTSTRAP_ECHO_TURN,
  buildBootstrapEchoPrompt,
  codexHookConfigs,
  tomlBasicStringEscape,
  writeClaudeBootSettings,
} from "../../dist/boot.js";
import { makeDoneMarker, parseDoneSignal } from "../../dist/pane.js";

// ---- boot.ts: bootstrap echo prompt (split-marker safety) ------------------

check("buildBootstrapEchoPrompt: single line, no complete DONE marker, and the split fragments reassemble to the exact parser marker", () => {
  const bootId = "boot-abc123";
  const prompt = buildBootstrapEchoPrompt(bootId);
  assert(!prompt.includes("\n"), "must be single-line (goes through the shell command line)");
  assert(!prompt.includes("<<<PMUX_DONE"), "prompt must never contain a complete DONE marker substring");

  // Reassembling exactly what the prompt instructs must equal the marker
  // wait_ready's expectEcho check parses (single-source guard).
  const m = /"(<<<PMUX_)" 바로 뒤에 "([^"]+)" 를/.exec(prompt);
  assert(m !== null, "prompt must carry the two quoted fragments");
  const assembled = `${m[1]}${m[2]}`;
  assertEqual(
    assembled,
    makeDoneMarker({
      agentId: BOOTSTRAP_ECHO_AGENT_ID,
      turn: BOOTSTRAP_ECHO_TURN,
      requestId: bootId,
      status: "complete",
    }),
  );

  // The prompt's own pane echo must not read as a DONE signal…
  const echoed = `› ${prompt}`;
  const notSignal = parseDoneSignal({
    pane: echoed,
    agentId: BOOTSTRAP_ECHO_AGENT_ID,
    turn: BOOTSTRAP_ECHO_TURN,
    requestId: bootId,
  });
  assertEqual(notSignal.found, false, "command/composer echo of the prompt must not be a signal");

  // …while the agent actually printing the assembled line must.
  const real = parseDoneSignal({
    pane: `• ${assembled}`,
    agentId: BOOTSTRAP_ECHO_AGENT_ID,
    turn: BOOTSTRAP_ECHO_TURN,
    requestId: bootId,
  });
  assertEqual(real.found, true);
  assertEqual(real.status, "complete");
});

check("buildBootstrapEchoPrompt: rejects a non-allowlisted bootId", () => {
  assert(throws(() => buildBootstrapEchoPrompt("BAD ID; rm -rf /")), "must reject shell metacharacters");
});

// ---- boot.ts: codex hook TOML assembly -------------------------------------

check("codexHookConfigs: app+boot hooks share ONE SessionStart array (never two -c values for the same key — last-wins, 합의)", () => {
  const configs = codexHookConfigs({
    appHookPath: "/home/u/.purplemux/codex-hook.sh",
    bootHookPath: "/home/u/.purplemux/pmux-boot-hook.sh",
  });
  const sessionStart = configs.filter((c) => c.startsWith("hooks.SessionStart="));
  assertEqual(sessionStart.length, 1, "exactly one SessionStart config");
  assert(sessionStart[0].includes("codex-hook.sh"), "app hook present");
  assert(sessionStart[0].includes("pmux-boot-hook.sh"), "boot hook present");
  // other five events wired app-only
  assertEqual(configs.length, 6);
});

check("codexHookConfigs: boot hook is wired even without the app hook; nothing wired when neither exists", () => {
  const bootOnly = codexHookConfigs({ bootHookPath: "/x/pmux-boot-hook.sh" });
  assertEqual(bootOnly.length, 1);
  assert(bootOnly[0].startsWith("hooks.SessionStart="));
  assertEqual(codexHookConfigs({}).length, 0);
});

check("tomlBasicStringEscape: escapes backslashes and double quotes", () => {
  assertEqual(tomlBasicStringEscape('a"b\\c'), 'a\\"b\\\\c');
});

check("codexHookConfigs: rejects hook paths outside the safe allowlist (shell-expansion defense, codex 리뷰 [BLOCKING])", () => {
  for (const bad of [
    '/home/u"/$(rm -rf ~)/hook.sh',
    "/home/u/`whoami`/hook.sh",
    "/home/u/with space/hook.sh",
    "/home/u/\\backslash/hook.sh",
  ]) {
    assert(
      throws(() => codexHookConfigs({ bootHookPath: bad })),
      `must reject unsafe hook path: ${bad}`,
    );
  }
  // normal homedir-style paths pass
  const ok = codexHookConfigs({ bootHookPath: "/home/user-1/.purplemux/pmux-boot-hook.sh" });
  assertEqual(ok.length, 1);
});

// ---- boot.ts: claude settings merge (real temp HOME) -----------------------

async function runBootSettingsTests() {
  const realHome = process.env.HOME;
  const fakeHome = await mkdtemp(join(tmpdir(), "pmux-boot-test-"));
  process.env.HOME = fakeHome;
  try {
    await checkAsync("writeClaudeBootSettings: missing hooks.json → boot-only settings, settingsMerge=boot_only_missing", async () => {
      const r = await writeClaudeBootSettings("bootid1", "/x/pmux-boot-hook.sh");
      assertEqual(r.settingsMerge, "boot_only_missing");
      assertEqual(r.appHooksWired, false);
      const written = JSON.parse(await readFile(r.path, "utf8"));
      assertEqual(written.hooks.SessionStart.length, 1);
      assert(written.hooks.SessionStart[0].hooks[0].command.includes("pmux-boot-hook.sh"));
    });

    await checkAsync("writeClaudeBootSettings: deep-merges — preserves statusLine and APPENDS to existing SessionStart (never replaces app entries)", async () => {
      await mkdir(join(fakeHome, ".purplemux"), { recursive: true });
      await writeFile(
        join(fakeHome, ".purplemux", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { matcher: "", hooks: [{ type: "command", command: "sh app-hook.sh", timeout: 3 }] },
            ],
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "sh app-hook.sh" }] }],
          },
          statusLine: { type: "command", command: "sh statusline.sh" },
        }),
      );
      const r = await writeClaudeBootSettings("bootid2", "/x/pmux-boot-hook.sh");
      assertEqual(r.settingsMerge, "merged");
      assertEqual(r.appHooksWired, true);
      const written = JSON.parse(await readFile(r.path, "utf8"));
      assertEqual(written.hooks.SessionStart.length, 2, "app entry kept + boot entry appended");
      assert(written.hooks.SessionStart[0].hooks[0].command.includes("app-hook.sh"));
      assert(written.hooks.SessionStart[1].hooks[0].command.includes("pmux-boot-hook.sh"));
      assertEqual(written.hooks.Stop.length, 1, "unrelated hook events preserved");
      assertEqual(written.statusLine.command, "sh statusline.sh", "non-hook top-level keys preserved");
      assert(r.path.includes("bootid2"), "per-bootId settings file (concurrency safety)");
    });

    await checkAsync("writeClaudeBootSettings: unparseable hooks.json → boot-only, settingsMerge=boot_only_parse_failed", async () => {
      await writeFile(join(fakeHome, ".purplemux", "hooks.json"), "{not json");
      const r = await writeClaudeBootSettings("bootid3", "/x/pmux-boot-hook.sh");
      assertEqual(r.settingsMerge, "boot_only_parse_failed");
      assertEqual(r.appHooksWired, false);
    });
  } finally {
    process.env.HOME = realHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
}

await runBootSettingsTests();
