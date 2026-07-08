// Pure-function unit tests for src/profiles.ts, src/pane.ts and src/paths.ts
// (dist/ build). No framework — plain node, fails with exit 1 on any
// assertion failure.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

import {
  buildAgentCommand,
  compileUserPattern,
  mapCliState,
  SHELL_NAMES,
} from "../dist/profiles.js";
import {
  buildSentinelFooter,
  classifyReadiness,
  detectRuntimeError,
  extractMarkerBlock,
  hasPriorTurnCompletion,
  makeDoneMarker,
  makeMarkers,
  parseDoneSignal,
} from "../dist/pane.js";
import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "../dist/paths.js";
import {
  BOOTSTRAP_ECHO_AGENT_ID,
  BOOTSTRAP_ECHO_TURN,
  buildBootstrapEchoPrompt,
  codexHookConfigs,
  tomlBasicStringEscape,
  writeClaudeBootSettings,
} from "../dist/boot.js";
import { ORCHESTRATION_GUIDE, SERVER_INSTRUCTIONS } from "../dist/guide.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(e instanceof Error ? e.stack : e);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(e instanceof Error ? e.stack : e);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

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

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

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

// ---- extractMarkerBlock --------------------------------------------------

const ID = { agentId: "codex1", turn: 3 };

check("extractMarkerBlock: complete", () => {
  const { begin, end } = makeMarkers(ID);
  const pane = ["some prior output", begin, "hello world", "line two", end, "$ "].join("\n");
  const r = extractMarkerBlock({ pane, ...ID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "hello world\nline two");
});

check("extractMarkerBlock: partial (BEGIN only, still generating)", () => {
  const { begin } = makeMarkers(ID);
  const pane = ["some prior output", begin, "partial line 1", "partial line 2"].join("\n");
  const r = extractMarkerBlock({ pane, ...ID });
  assertEqual(r.status, "partial");
  assertEqual(r.contentSoFar, "partial line 1\npartial line 2");
});

check("extractMarkerBlock: missing (no markers at all)", () => {
  const pane = ["nothing to see here", "just a normal pane"].join("\n");
  const r = extractMarkerBlock({ pane, ...ID });
  assertEqual(r.status, "missing");
});

check("extractMarkerBlock: distinguishes requestId (different rid → missing)", () => {
  const withRid = makeMarkers({ ...ID, requestId: "req1" });
  const pane = [withRid.begin, "content for req1", withRid.end].join("\n");
  const rWrongRid = extractMarkerBlock({ pane, ...ID, requestId: "req2" });
  assertEqual(rWrongRid.status, "missing");
  const rNoRid = extractMarkerBlock({ pane, ...ID });
  assertEqual(rNoRid.status, "missing");
  const rRightRid = extractMarkerBlock({ pane, ...ID, requestId: "req1" });
  assertEqual(rRightRid.status, "complete");
  assertEqual(rRightRid.content, "content for req1");
});

check("extractMarkerBlock: distinguishes turn (different turn → missing)", () => {
  const t3 = makeMarkers({ agentId: "codex1", turn: 3 });
  const pane = [t3.begin, "turn 3 content", t3.end].join("\n");
  const r4 = extractMarkerBlock({ pane, agentId: "codex1", turn: 4 });
  assertEqual(r4.status, "missing");
});

check("extractMarkerBlock: prompt-echo instruction line + real marker pair coexist (§4.5-1)", () => {
  const footer = buildSentinelFooter({ ...ID, maxResponseLines: 40 });
  const { begin, end } = makeMarkers(ID);
  // The echoed sentinel instruction contains BOTH markers on one line (and
  // surrounding Korean instruction text) — must NOT be mistaken for a real
  // marker line. The real, standalone marker pair below it is the one that
  // should be extracted.
  const pane = [
    "> " + footer,
    begin,
    "actual response body",
    end,
  ].join("\n");
  const r = extractMarkerBlock({ pane, ...ID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "actual response body");
  assert(!r.content.includes("사이에만"), "echoed instruction text must not leak into content");
});

check("extractMarkerBlock: last valid pair wins when a dangling BEGIN follows a complete pair", () => {
  const { begin, end } = makeMarkers(ID);
  const pane = [begin, "old content", end, begin, "new in-progress content"].join("\n");
  const r = extractMarkerBlock({ pane, ...ID });
  assertEqual(r.status, "partial");
  assertEqual(r.contentSoFar, "new in-progress content");
});

// ---- classifyReadiness ---------------------------------------------------

check("classifyReadiness: codex ready", () => {
  const pane = ["codex", "", "› ", "  (workspace-write)"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
});

check("classifyReadiness: claude ready", () => {
  const pane = ["claude", "", "❯ "].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_ready");
});

check("classifyReadiness: launch_failed via command-not-found", () => {
  const pane = ["$ codex --no-alt-screen -s read-only", "bash: codex: command not found", "$ "].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "launch_failed");
});

check("classifyReadiness: launch_failed via unexpected-argument", () => {
  const pane = ["$ claude --model bogus --permission-mode plan", "error: unexpected argument '--model'", "$ "].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "launch_failed");
});

check("classifyReadiness: launch_failed via silent shell-prompt return (codex)", () => {
  // Command echoed, then silently exits straight back to a shell prompt —
  // no ready pattern, no explicit error text (Opus's "조용한 부팅 실패").
  const pane = ["$ codex --no-alt-screen -s read-only", "$ "].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "launch_failed");
});

check("classifyReadiness: agent_starting (echo present, no ready/error/shell-return yet)", () => {
  const pane = ["$ codex --no-alt-screen -s read-only", "Loading codex..."].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
});

check("classifyReadiness: stale ready glyph earlier + recent command-not-found → launch_failed", () => {
  // Old "›" sits way up in scrollback (e.g. leftover from a prior tab use),
  // but the actual outcome of THIS launch is a failure at the bottom.
  const pane = [
    "› some unrelated old codex line from a previous session",
    ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
    "$ codex --no-alt-screen -s read-only",
    "bash: codex: command not found",
    "$ ",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "launch_failed");
});

check("classifyReadiness: stale ready glyph earlier + recent shell-prompt return → launch_failed", () => {
  const pane = [
    "› stale glyph from way earlier",
    ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
    "$ codex --no-alt-screen -s read-only",
    "$ ",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "launch_failed");
});

check("classifyReadiness: agent_busy (esc to interrupt in tail)", () => {
  const pane = ["codex", "working on it...", "esc to interrupt"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_busy");
});

check("classifyReadiness: busy takes priority over ready when both present in tail", () => {
  const pane = ["claude", "❯ some prior prompt line", "generating response", "esc to interrupt"].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_busy");
});

check("classifyReadiness: errorPattern is tail-scoped (v2 regression) — a quoted error string that scrolled out of view no longer sticks", () => {
  // The agent's OWN response body quoted "command not found" many turns
  // ago (Opus 턴4 B1: multi-turn collaboration citing an error string).
  // With v1's full-pane errorPattern check this pinned launch_failed
  // forever; v2/v22 scope errorPattern to tail(30) same as busy/ready — the
  // filler here (40 lines, SYNTHETIC) must exceed that widened window so
  // the quoted line still scrolls out.
  const pane = [
    "assistant: earlier in this session I saw: bash: codex: command not found",
    ...Array.from({ length: 40 }, (_, i) => `filler line ${i}`),
    "codex",
    "› ",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
});

// ---- parseDoneSignal ------------------------------------------------------

check("parseDoneSignal: found, standalone line, last match wins", () => {
  const pane = [
    "some earlier noise",
    "<<<PMUX_DONE agent=codex1 turn=3 req=reqA status=complete>>>",
    "more output after (should not matter)",
    "<<<PMUX_DONE agent=codex1 turn=3 req=reqA status=blocked>>>",
  ].join("\n");
  const r = parseDoneSignal({ pane, agentId: "codex1", turn: 3, requestId: "reqA" });
  assertEqual(r.found, true);
  assertEqual(r.status, "blocked");
});

check("parseDoneSignal: requestId gate — mismatched req does not match", () => {
  const pane = "<<<PMUX_DONE agent=codex1 turn=3 req=reqA status=complete>>>";
  const r = parseDoneSignal({ pane, agentId: "codex1", turn: 3, requestId: "reqB" });
  assertEqual(r.found, false);
});

check("parseDoneSignal: requestId omitted only matches a signal with NO req field (pane-block fallback)", () => {
  const withReq = "<<<PMUX_DONE agent=codex1 turn=3 req=reqA status=complete>>>";
  const noReq = "<<<PMUX_DONE agent=codex1 turn=3 status=complete>>>";
  assertEqual(parseDoneSignal({ pane: withReq, agentId: "codex1", turn: 3 }).found, false);
  assertEqual(parseDoneSignal({ pane: noReq, agentId: "codex1", turn: 3 }).found, true);
});

check("parseDoneSignal: echo-safe — makeFileFooter never contains a complete marker, so an echoed footer never matches", () => {
  const footer = makeFileFooter({
    workspaceDir: "/tmp/ws",
    agentId: "codex1",
    turn: 3,
    requestId: "reqA",
  });
  assert(!footer.includes("<<<PMUX_DONE"), "footer must never contain a complete DONE marker substring");
  assert(!footer.includes("<<<PMUX_EOF"), "footer must never contain a complete EOF marker substring");
  // Even a verbatim, prompt-prefixed echo of the footer (every line prefixed
  // "> ", as a CLI would render pasted multi-line input) must not satisfy
  // the standalone-line DONE regex.
  const pane = footer
    .split("\n")
    .map((l) => "> " + l)
    .join("\n");
  const r = parseDoneSignal({ pane, agentId: "codex1", turn: 3, requestId: "reqA" });
  assertEqual(r.found, false);
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

// ---- classifyReadiness: R1 real-capture fixtures (design v22 R1/G7) -------
//
// These two files are REAL pane captures (prepared by the task author, not
// synthesized) of an idle/ready claude-code and codex-cli session — see
// test/fixtures/*.txt. Per G7, fixture-driven readiness tests must be
// extracted from real captures, not invented text.
//
// 턴2 update (Codex review C1): both captures happen to show the composer
// glyph (›/❯) followed by trailing text ("Explain this codebase" / the
// echoed "REPORT_READY ..." message), with only a blank line + status bar
// after it — structurally identical to a genuinely queued/unsent composer
// draft, so C1's fix (at the time) reported agent_starting/"input_queued"
// for both.
//
// 턴4 resolution: a live discovery showed composer text alone can't
// distinguish "queued" from a CLI-placeholder/history-bubble in general —
// codex redisplays placeholder ghost text in the composer after every turn,
// not just at boot, and neither of these two captures' trailing composer
// text carries OUR protocol's own signature (`PMUX_`/`[응답 규약]`, which
// pmux_agent_send always injects into anything it genuinely queues). Per
// that corrected rule, non-signature composer text is a ready candidate —
// so both fixtures are back to agent_ready, which happens to match the
// original turn1 expectation. See sworker-v22-turn{2,4}.md for the history;
// the takeaway is that pane-only disambiguation of "is this really queued"
// depends on OUR OWN footer signature, not just "is there text after the
// glyph".

async function runFixtureTests() {
  await checkAsync("classifyReadiness: real claude-code idle capture → agent_ready (턴4 — composer trailing text has no protocol signature, so it's a ready candidate, not queued)", async () => {
    const pane = await readFile(join(FIXTURES_DIR, "claude-idle-real.txt"), "utf8");
    const r = classifyReadiness({ pane, provider: "claude" });
    assertEqual(r.state, "agent_ready");
  });
  await checkAsync("classifyReadiness: real codex-cli idle capture → agent_ready (턴4 — composer trailing text has no protocol signature, so it's a ready candidate, not queued)", async () => {
    const pane = await readFile(join(FIXTURES_DIR, "codex-idle-real.txt"), "utf8");
    const r = classifyReadiness({ pane, provider: "codex" });
    assertEqual(r.state, "agent_ready");
  });
  await checkAsync("detectRuntimeError: real 529-observed capture → found with match+line populated, AND classifyReadiness still reports agent_ready on the same capture (design R6 orthogonality)", async () => {
    const tail = await readFile(join(FIXTURES_DIR, "claude-529-observed.txt"), "utf8");
    const r = detectRuntimeError(tail);
    assertEqual(r.found, true);
    assert(typeof r.match === "string" && r.match.length > 0, "match must be populated");
    assert(
      typeof r.line === "string" && r.line.includes(r.match),
      "line must contain the matched text",
    );

    // The same capture's composer is a bare "❯" with a fully-formed status
    // frame below it — classifyReadiness correctly reports this as ready.
    // That's the whole point of R6: the task silently died, but the
    // session genuinely IS ready to be re-prompted, so runtimeError must
    // stay an orthogonal fact rather than forcing not-ready/launch_failed.
    const readiness = classifyReadiness({ pane: tail, provider: "claude" });
    assertEqual(readiness.state, "agent_ready");
  });
}

// ---- classifyReadiness: R1 synthetic fixtures (SYNTHETIC — hand-built, not
// extracted from a real capture; G7 requires this to be called out
// explicitly since only the two real-capture tests above satisfy the
// "extracted from real pane" bar) -------------------------------------------

check("classifyReadiness: SYNTHETIC fresh bare composer (codex) → agent_ready via bare-composer path", () => {
  const pane = ["some prior output", "", "› "].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
  assertEqual(r.reason, "bare composer");
});

check("classifyReadiness: SYNTHETIC response complete, glyph scrolled out of tail → agent_ready via frameSeen (no bare ›)", () => {
  const pane = [
    "assistant: here is the finished response body.",
    "",
    "gpt-5.5 high · ~/workspace/demo · main · 2h left · Read Only",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
  assertEqual(r.reason, "frame signature matched");
});

check("classifyReadiness: SYNTHETIC Working busy variant (no 'esc to interrupt')", () => {
  const pane = ["codex", "Working (3s · ↑ 128 tokens)", ""].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_busy");
});

check("classifyReadiness: SYNTHETIC approval prompt (y/n) → not ready, not busy (agent_starting)", () => {
  const pane = ["codex", "Allow codex to run `rm -rf ./tmp`?", "(y/n)"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
});

// 턴4 라이브 발견: codex redisplays a placeholder in the composer whenever
// it's empty, not only at boot but after every turn ("› Implement
// {feature}") — so non-blank composer text is NOT reliably "genuinely
// queued" unless it carries OUR OWN protocol signature (pmux_agent_send
// always injects a footer containing "<<<PMUX_...>>>" or "[응답 규약]").
// The two tests below were rewritten from turn1/turn2 (which used
// signature-free text and asserted input_queued) to use signature-bearing
// text instead — that's the only shape genuinely-queued input from this
// system can take.
check("classifyReadiness: SYNTHETIC queued/composer-dirty text (carries our protocol signature) → agent_starting/input_queued (not ready)", () => {
  const pane = ["codex", "", "› still typing PMUX_ draft, not submitted yet"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
  assertEqual(r.reason, "input_queued");
});

// 턴2 Codex review C1: the pane's last non-blank line is not necessarily
// the composer — a status-bar redraw can land below a dirty composer in
// --no-alt-screen scrolling output. Checking only the last non-blank line
// missed the queued state entirely, and the old fast glyph path
// (readyPattern.test(tail), which just checks "is › anywhere in tail")
// then wrongly promoted this to ready. This is the REJECT regression case
// (updated in 턴4 to use signature-bearing composer text — see note above).
check("classifyReadiness: SYNTHETIC REJECT — signature-bearing composer text with a status bar rendered below it must still be input_queued, not promoted to ready", () => {
  const pane = [
    "codex",
    "› draft mentioning PMUX_ marker, not yet submitted",
    "",
    "gpt-5.5 high · ~/workspace/demo · main · Read Only",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
  assertEqual(r.reason, "input_queued");
});

check("classifyReadiness: SYNTHETIC placeholder composer text (turn4 live discovery — codex re-shows a placeholder after every turn, not just at boot) → treated as a ready candidate, not queued", () => {
  const pane = ["codex", "", "› Implement {feature}"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
  assertEqual(r.reason, "placeholder composer");
});

check("classifyReadiness: SYNTHETIC composer text containing a PMUX_ marker fragment → input_queued", () => {
  const pane = ["codex", "", "› <<<PMUX_BEGIN agent=x turn=1>>>"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
  assertEqual(r.reason, "input_queued");
});

check("classifyReadiness: SYNTHETIC composer text containing the [응답 규약] footer instruction → input_queued", () => {
  const pane = ["codex", "", "› [응답 규약] 응답을 모두 완성한 뒤 저장하세요"].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_starting");
  assertEqual(r.reason, "input_queued");
});

// Companion positive case: a genuinely BARE composer followed by the same
// kind of status-bar redraw below it must still resolve to ready — the C1
// fix (scanning tail for the last composer-glyph line) must not regress
// this, only the non-bare/queued case above.
check("classifyReadiness: SYNTHETIC bare composer with a status bar rendered below it → still agent_ready", () => {
  const pane = [
    "codex",
    "› ",
    "",
    "gpt-5.5 high · ~/workspace/demo · main · Read Only",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
  assertEqual(r.reason, "bare composer");
});

check("classifyReadiness: SYNTHETIC shell return still fires when frame is not seen (unaffected baseline)", () => {
  const pane = ["$ codex --no-alt-screen -s read-only", "$ "].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "launch_failed");
  assertEqual(r.reason, "shell prompt returned");
});

check("classifyReadiness: SYNTHETIC body/status line ending in '$' is NOT mistaken for shell-return when frameSeen (codex)", () => {
  const pane = [
    "assistant output here",
    "gpt-5.5 · workspace value: $",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "codex" });
  assertEqual(r.state, "agent_ready");
  assert(r.reason !== "shell prompt returned", "frameSeen must suppress the shell-return false positive");
});

check("classifyReadiness: SYNTHETIC status line ending in '$' is NOT mistaken for shell-return when frameSeen (claude)", () => {
  const pane = [
    "some assistant output",
    "──────────",
    "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents $",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_ready");
  assert(r.reason !== "shell prompt returned", "frameSeen must suppress the shell-return false positive");
});

// ---- R2: marker shortening (requestId path) + legacy/wrap acceptance ------

const RID = { agentId: "codex1", turn: 3, requestId: "reqShort" };

check("makeMarkers: requestId path is shortened to req-only (agent/turn dropped)", () => {
  const { begin, end } = makeMarkers(RID);
  assertEqual(begin, "<<<PMUX_BEGIN req=reqShort>>>");
  assertEqual(end, "<<<PMUX_END req=reqShort>>>");
});

check("makeMarkers: requestId omitted keeps the original agent/turn form", () => {
  const { begin, end } = makeMarkers({ agentId: "codex1", turn: 3 });
  assertEqual(begin, "<<<PMUX_BEGIN agent=codex1 turn=3>>>");
  assertEqual(end, "<<<PMUX_END agent=codex1 turn=3>>>");
});

check("makeDoneMarker: requestId path is shortened to req-only (agent/turn dropped)", () => {
  const marker = makeDoneMarker({ ...RID, status: "complete" });
  assertEqual(marker, "<<<PMUX_DONE req=reqShort status=complete>>>");
});

check("makeDoneMarker: requestId omitted keeps the original agent/turn form", () => {
  const marker = makeDoneMarker({ agentId: "codex1", turn: 3, status: "blocked" });
  assertEqual(marker, "<<<PMUX_DONE agent=codex1 turn=3 status=blocked>>>");
});

check("parseDoneSignal: new short form (req-only) is recognized", () => {
  const pane = "<<<PMUX_DONE req=reqShort status=complete>>>";
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, true);
  assertEqual(r.status, "complete");
});

check("parseDoneSignal: legacy long form (agent+turn+req) is still recognized (구형 호환)", () => {
  const pane = "<<<PMUX_DONE agent=codex1 turn=3 req=reqShort status=blocked>>>";
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, true);
  assertEqual(r.status, "blocked");
});

check("parseDoneSignal: mixed pane — legacy form earlier, short form later → short form (last) wins", () => {
  const pane = [
    "<<<PMUX_DONE agent=codex1 turn=3 req=reqShort status=blocked>>>",
    "some more output",
    "<<<PMUX_DONE req=reqShort status=complete>>>",
  ].join("\n");
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, true);
  assertEqual(r.status, "complete");
});

check("extractMarkerBlock: legacy long-form BEGIN/END (agent+turn+req) still recognized (구형 호환)", () => {
  const legacyBegin = "<<<PMUX_BEGIN agent=codex1 turn=3 req=reqShort>>>";
  const legacyEnd = "<<<PMUX_END agent=codex1 turn=3 req=reqShort>>>";
  const pane = [legacyBegin, "legacy-format body", legacyEnd].join("\n");
  const r = extractMarkerBlock({ pane, ...RID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "legacy-format body");
});

check("extractMarkerBlock: new short-form BEGIN/END round-trips through makeMarkers", () => {
  const { begin, end } = makeMarkers(RID);
  const pane = [begin, "short-format body", end].join("\n");
  const r = extractMarkerBlock({ pane, ...RID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "short-format body");
});

check("parseDoneSignal: SYNTHETIC wrap-tolerant match — marker split across 2 physical lines with no separator", () => {
  const marker = makeDoneMarker({ ...RID, status: "complete" });
  // Simulate a narrow pane wrapping the marker mid-string (terminal wrap
  // never inserts a separator — it just breaks the character stream).
  const splitAt = Math.floor(marker.length / 2);
  const pane = [
    "some prior output",
    marker.slice(0, splitAt),
    marker.slice(splitAt),
  ].join("\n");
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, true);
  assertEqual(r.status, "complete");
});

check("parseDoneSignal: SYNTHETIC wrap-tolerant match does not fire on an unrelated 2-line coincidence", () => {
  const pane = ["totally unrelated line one", "totally unrelated line two"].join("\n");
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, false);
});

check("extractMarkerBlock: SYNTHETIC wrap-tolerant BEGIN/END — both markers split across physical lines", () => {
  const { begin, end } = makeMarkers(RID);
  const beginSplit = Math.floor(begin.length / 2);
  const endSplit = Math.floor(end.length / 2);
  const pane = [
    begin.slice(0, beginSplit),
    begin.slice(beginSplit),
    "wrapped body",
    end.slice(0, endSplit),
    end.slice(endSplit),
  ].join("\n");
  const r = extractMarkerBlock({ pane, ...RID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "wrapped body");
});

check("parseDoneSignal: echo-safe holds under wrap-tolerant matching too — split footer fragments never assemble into a marker", () => {
  const footer = makeFileFooter({
    workspaceDir: "/tmp/ws",
    agentId: "codex1",
    turn: 3,
    requestId: "reqShort",
  });
  // Even splitting the (already marker-free) footer into narrow chunks and
  // feeding it through must not accidentally assemble a real marker.
  const narrow = footer
    .split("\n")
    .flatMap((line) => line.match(/.{1,20}/g) ?? [""])
    .join("\n");
  const r = parseDoneSignal({ pane: narrow, agentId: "codex1", turn: 3, requestId: "reqShort" });
  assertEqual(r.found, false);
});

// ---- hasPriorTurnCompletion (design v22 턴2, Opus review B1) --------------
//
// Replaces agents.ts's old hand-rolled hasPriorTurnEnd/hasPriorDoneSignal
// regexes, which required a literal "agent=...turn=..." prefix and so could
// never match an R2 short-form marker (req-only, no agent/turn at all) —
// a prior-turn check against a fileOutput=true multi-turn session would
// always report "not complete" once R2 shipped, permanently blocking
// expectPrevTurnEnd. This function is derived from makeMarkers/makeDoneMarker
// (never a hand-copied literal) and recognizes both the legacy long form
// (agent+turn, any/no req) and, when requestId is supplied, the R2 short
// form for that exact req.

const HPC = { agentId: "codex1", turn: 7 };

check("hasPriorTurnCompletion: short-form DONE recognized when requestId is supplied", () => {
  const marker = makeDoneMarker({ ...HPC, requestId: "reqPrev", status: "complete" });
  const pane = ["some prior output", marker, "more output"].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC, requestId: "reqPrev" }),
    "short-form DONE with matching requestId must count as prior completion",
  );
});

check("hasPriorTurnCompletion: requestId omitted only recognizes the legacy (no-req) form, not a short-form marker present in the pane", () => {
  const shortForm = makeDoneMarker({ ...HPC, requestId: "reqPrev", status: "complete" });
  const paneWithShortFormOnly = ["some output", shortForm].join("\n");
  assert(
    !hasPriorTurnCompletion({ pane: paneWithShortFormOnly, ...HPC }),
    "a short-form marker cannot be recognized without the requestId that produced it",
  );

  const legacyNoReq = makeDoneMarker({ ...HPC, status: "blocked" });
  const paneWithLegacy = ["some output", legacyNoReq].join("\n");
  assert(
    hasPriorTurnCompletion({ pane: paneWithLegacy, ...HPC }),
    "the legacy no-req form must still be recognized when requestId is omitted",
  );
});

check("hasPriorTurnCompletion: legacy form with an arbitrary/unknown req still counts (wildcard, matches pre-R2 semantics)", () => {
  const legacyWithSomeOtherReq = `<<<PMUX_DONE agent=${HPC.agentId} turn=${HPC.turn} req=some-earlier-turns-req status=complete>>>`;
  assert(
    hasPriorTurnCompletion({ pane: legacyWithSomeOtherReq, ...HPC }),
    "legacy agent+turn form must count regardless of its req value, since a caller checking an older turn generally doesn't know its req",
  );
});

check("hasPriorTurnCompletion: short-form END recognized (fileOutput=false / pane-fallback path)", () => {
  const end = makeMarkers({ ...HPC, requestId: "reqPrev" }).end;
  const pane = ["prior turn body", end].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC, requestId: "reqPrev" }),
    "short-form END with matching requestId must count as prior completion",
  );
});

check("hasPriorTurnCompletion: legacy END form (no req) recognized too", () => {
  const end = makeMarkers(HPC).end;
  const pane = ["prior turn body", end].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC }),
    "legacy no-req END must count as prior completion",
  );
});

check("hasPriorTurnCompletion: SYNTHETIC wrap-tolerant — a prior marker split across physical lines is still recognized", () => {
  const marker = makeDoneMarker({ ...HPC, requestId: "reqPrev", status: "complete" });
  const splitAt = Math.floor(marker.length / 2);
  const pane = [
    "some prior output",
    marker.slice(0, splitAt),
    marker.slice(splitAt),
  ].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC, requestId: "reqPrev" }),
    "a wrapped short-form DONE marker must still be recognized",
  );
});

check("hasPriorTurnCompletion: contamination guard — a different requestId does not satisfy the short-form check", () => {
  const marker = makeDoneMarker({ ...HPC, requestId: "reqOther", status: "complete" });
  const pane = ["some prior output", marker].join("\n");
  assert(
    !hasPriorTurnCompletion({ pane, ...HPC, requestId: "reqMine" }),
    "a short-form marker for a different requestId must not count",
  );
});

check("hasPriorTurnCompletion: contamination guard — a different turn number does not satisfy the legacy form", () => {
  const marker = makeDoneMarker({ agentId: HPC.agentId, turn: HPC.turn + 1, status: "complete" });
  const pane = ["some prior output", marker].join("\n");
  assert(
    !hasPriorTurnCompletion({ pane, ...HPC }),
    "a legacy marker for a different turn must not count",
  );
});

check("hasPriorTurnCompletion: contamination guard — a different agentId does not satisfy the legacy form", () => {
  const marker = makeDoneMarker({ agentId: "otherAgent", turn: HPC.turn, status: "complete" });
  const pane = ["some prior output", marker].join("\n");
  assert(
    !hasPriorTurnCompletion({ pane, ...HPC }),
    "a legacy marker for a different agentId must not count",
  );
});

check("hasPriorTurnCompletion: no marker at all → false", () => {
  assert(
    !hasPriorTurnCompletion({ pane: "nothing relevant here\njust output", ...HPC }),
    "a pane with no completion marker must not count as prior completion",
  );
});

// ---- decoration-prefix tolerance (design v22 턴3, live discovery) ---------
//
// Live capture showed codex's TUI prefixing each printed agent-output line
// with a decorative bullet ("• <<<PMUX_DONE req=... status=complete>>>"),
// which broke every exact standalone-line marker check in this file
// (doneSignal:false, hasPriorTurnCompletion false negatives) since none of
// them tolerated anything before the marker. normalizeMarkerCandidate
// (trim, then strip ONE leading decoration prefix) is now the single
// source all of parseDoneSignal/extractMarkerBlock/hasPriorTurnCompletion
// and their wrap-tolerant paths go through.

for (const bullet of ["•", "●", "◦", "▪", "∙", "*", "-"]) {
  check(`parseDoneSignal: decoration prefix "${bullet} " on the short-form DONE line is tolerated`, () => {
    const marker = makeDoneMarker({ ...RID, status: "complete" });
    const pane = ["some prior output", `${bullet} ${marker}`, "more output"].join("\n");
    const r = parseDoneSignal({ pane, ...RID });
    assertEqual(r.found, true);
    assertEqual(r.status, "complete");
  });
}

check("extractMarkerBlock: decoration-prefixed BEGIN/END (short form) still extracts the body", () => {
  const { begin, end } = makeMarkers(RID);
  const pane = [`• ${begin}`, "decorated body", `• ${end}`].join("\n");
  const r = extractMarkerBlock({ pane, ...RID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "decorated body");
});

check("extractMarkerBlock: decoration-prefixed legacy long-form BEGIN/END still recognized", () => {
  const legacyBegin = "<<<PMUX_BEGIN agent=codex1 turn=3 req=reqShort>>>";
  const legacyEnd = "<<<PMUX_END agent=codex1 turn=3 req=reqShort>>>";
  const pane = [`- ${legacyBegin}`, "legacy decorated body", `● ${legacyEnd}`].join("\n");
  const r = extractMarkerBlock({ pane, ...RID });
  assertEqual(r.status, "complete");
  assertEqual(r.content, "legacy decorated body");
});

check("hasPriorTurnCompletion: decoration-prefixed short-form DONE recognized", () => {
  const marker = makeDoneMarker({ ...HPC, requestId: "reqPrev", status: "complete" });
  const pane = ["some output", `• ${marker}`].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC, requestId: "reqPrev" }),
    "a decoration-prefixed short-form DONE must still count as prior completion",
  );
});

check("hasPriorTurnCompletion: decoration-prefixed legacy END recognized", () => {
  const end = makeMarkers(HPC).end;
  const pane = ["prior turn body", `• ${end}`].join("\n");
  assert(
    hasPriorTurnCompletion({ pane, ...HPC }),
    "a decoration-prefixed legacy END must still count as prior completion",
  );
});

check("parseDoneSignal: SYNTHETIC wrap + decoration combination — bullet on the first physical line of a wrapped marker", () => {
  const marker = makeDoneMarker({ ...RID, status: "blocked" });
  const decorated = `• ${marker}`;
  const splitAt = Math.floor(decorated.length / 2);
  const pane = [
    "some prior output",
    decorated.slice(0, splitAt),
    decorated.slice(splitAt),
  ].join("\n");
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, true);
  assertEqual(r.status, "blocked");
});

check("parseDoneSignal: decoration tolerance is still strict on the TRAILING side — nothing may follow the marker", () => {
  const marker = makeDoneMarker({ ...RID, status: "complete" });
  const pane = `• ${marker} trailing junk`;
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, false);
});

check("parseDoneSignal: decoration tolerance strips AT MOST ONE prefix — a doubled bullet does not match", () => {
  const marker = makeDoneMarker({ ...RID, status: "complete" });
  const pane = `• • ${marker}`;
  const r = parseDoneSignal({ pane, ...RID });
  assertEqual(r.found, false);
});

check("parseDoneSignal: echo-safety holds with decoration prefixes too — a decorated echo of the split-string footer never assembles a marker", () => {
  const footer = makeFileFooter({
    workspaceDir: "/tmp/ws",
    agentId: "codex1",
    turn: 3,
    requestId: "reqShort",
  });
  const decoratedEcho = footer
    .split("\n")
    .map((l) => `• ${l}`)
    .join("\n");
  const r = parseDoneSignal({ pane: decoratedEcho, agentId: "codex1", turn: 3, requestId: "reqShort" });
  assertEqual(r.found, false);
});

// ---- detectRuntimeError (design R6, v22-턴5 live discovery) ---------------
//
// Live discovery: sworker(claude) hit "API Error: 529 Overloaded" mid-turn
// and silently returned to the prompt — every readiness signal (cliState
// needs-input, pane bare composer) still reported the session as genuinely
// ready, so nothing in the R0/R1 state model ever noticed the task had
// died. detectRuntimeError is a deliberately separate, orthogonal fact —
// it never feeds into classifyReadiness/launch_failed, and a session it
// flags can simultaneously be reported agent_ready by classifyReadiness
// (see the real-capture test in runFixtureTests below, which asserts both).

check("detectRuntimeError: default pattern matches each documented keyword", () => {
  for (const sample of [
    "API Error: 500",
    "Overloaded",
    "you have hit the rate limit",
    "usage limit reached",
    "stream disconnected unexpectedly",
    "connection error: ECONNRESET",
  ]) {
    const r = detectRuntimeError(sample);
    assert(r.found, `expected a match for: ${sample}`);
  }
});

check("detectRuntimeError: no match in an ordinary completed-turn tail → found:false", () => {
  const tail = ["codex", "", "› ", "  (workspace-write)"].join("\n");
  const r = detectRuntimeError(tail);
  assertEqual(r.found, false);
  assertEqual(r.match, undefined);
  assertEqual(r.line, undefined);
});

// Known limitation (documented in the function's own docstring, not fixed):
// a response body that merely QUOTES one of these phrases — e.g. reviewing
// error-handling code, or a design doc discussing this very feature — also
// reports found:true. This is the same class of limitation as
// classifyReadiness's errorPattern; the LLM consumer is expected to judge
// from {match, line} in context, not treat found:true as unconditionally
// "the task died".
check("detectRuntimeError: SYNTHETIC citation case — a response body merely quoting \"API Error\" still reports found:true (known limitation, consumer judges)", () => {
  const tail = [
    "Sure — if the upstream returns \"API Error: 529 Overloaded\", the retry",
    "wrapper should back off and try again. Here's the handler I added:",
  ].join("\n");
  const r = detectRuntimeError(tail);
  assertEqual(r.found, true);
  // narrowed pattern (2026-07-08) captures the status code too when present
  assertEqual(r.match, "API Error: 529");
  assert(
    r.line.includes("API Error: 529 Overloaded"),
    "line must be handed back so the consumer can see this is a citation, not a live failure",
  );
});

check("detectRuntimeError: caller-supplied override pattern replaces the default", () => {
  const r1 = detectRuntimeError("totally custom failure token", /totally custom failure token/);
  assertEqual(r1.found, true);
  const r2 = detectRuntimeError("API Error: 500", /totally custom failure token/);
  assertEqual(r2.found, false, "the default vocabulary must not leak through when an override is supplied");
});

check("detectRuntimeError: is stateless across repeated calls even with a global-flag override", () => {
  const globalPattern = /Overloaded/g;
  const tail = "Overloaded";
  const r1 = detectRuntimeError(tail, globalPattern);
  const r2 = detectRuntimeError(tail, globalPattern);
  assertEqual(r1.found, true);
  assertEqual(r2.found, true, "a global-flag pattern must not skip matches on a second call via lastIndex creep");
});

await runFixtureTests();

// ---- paths.ts: agentReportPath / path isolation --------------------------

check("agentReportPath: rejects path-traversal / slash agentId", () => {
  assert(
    throws(() => agentReportPath("/some/workspace", "../x", 1)),
    "must reject ../x as agentId",
  );
  assert(
    throws(() => agentReportPath("/some/workspace", "a/b", 1)),
    "must reject agentId containing a slash",
  );
});

// ---- paths.ts: readReportFile (async, real temp filesystem) --------------

async function writeReportFile(workspaceDir, agentId, turn, lines) {
  const path = agentReportPath(workspaceDir, agentId, turn);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n"));
}

// ---- roundtrip helpers: extract instructions FROM makeFileFooter's own
// output (never hardcode expected marker text) so this test breaks if the
// footer format ever drifts from what the parsers accept (턴4 리뷰 요구).

function extractReportPathFromFooter(footer) {
  const m = /완성한 뒤 (.+) 에 저장하세요\./.exec(footer);
  if (!m) throw new Error("could not extract report path from footer");
  return m[1];
}

function extractLine1TemplateFromFooter(footer) {
  const m = /- 1줄차: (status=\S+ req=\S+)/.exec(footer);
  if (!m) throw new Error("could not extract line-1 template from footer");
  return m[1];
}

// Generic: find the footer line containing `anchor`, then assemble the two
// double-quoted fragments on it exactly like the footer instructs the agent
// to ("<frag1>" 뒤에 "<frag2>" 를 이어붙인 한 줄) — i.e. frag1 + frag2.
function extractAssembledFragmentsFromFooter(footer, anchor) {
  const line = footer.split("\n").find((l) => l.includes(anchor));
  if (!line) throw new Error(`no footer line contains ${JSON.stringify(anchor)}`);
  const m = /"([^"]*)"\s*뒤에\s*"([^"]*)"/.exec(line);
  if (!m) throw new Error(`could not extract quoted fragments from: ${line}`);
  return m[1] + m[2];
}

async function runReportFileTests() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "pmux-unit-"));
  try {
    await checkAsync("readReportFile: valid file → status/content/bytes", async () => {
      const requestId = "req-valid1";
      await writeReportFile(workspaceDir, "codex1", 10, [
        `status=complete req=${requestId}`,
        "line one of the body",
        "line two of the body",
        `<<<PMUX_EOF req=${requestId}>>>`,
      ]);
      const r = await readReportFile(workspaceDir, "codex1", 10, requestId);
      assertEqual(r.state, "valid");
      assertEqual(r.status, "complete");
      assertEqual(r.content, "line one of the body\nline two of the body");
      assert(typeof r.bytes === "number" && r.bytes > 0, "bytes should be reported");
    });

    await checkAsync("readReportFile: missing file → state:missing (not a violation)", async () => {
      const r = await readReportFile(workspaceDir, "codex1", 999, "whatever-req");
      assertEqual(r.state, "missing");
    });

    await checkAsync("readReportFile: malformed line 1 → invalid/status_line", async () => {
      const requestId = "req-bad-status";
      await writeReportFile(workspaceDir, "codex1", 11, [
        "not a status line at all",
        "body",
        `<<<PMUX_EOF req=${requestId}>>>`,
      ]);
      const r = await readReportFile(workspaceDir, "codex1", 11, requestId);
      assertEqual(r.state, "invalid");
      assertEqual(r.reason, "status_line");
    });

    await checkAsync("readReportFile: req mismatch (stale session file) → invalid/req_mismatch", async () => {
      await writeReportFile(workspaceDir, "codex1", 12, [
        "status=complete req=old-session-req",
        "stale body from a previous session",
        "<<<PMUX_EOF req=old-session-req>>>",
      ]);
      const r = await readReportFile(workspaceDir, "codex1", 12, "new-session-req");
      assertEqual(r.state, "invalid");
      assertEqual(r.reason, "req_mismatch");
    });

    await checkAsync("readReportFile: no EOF marker (mid-write) → invalid/eof_missing", async () => {
      const requestId = "req-midwrite";
      await writeReportFile(workspaceDir, "codex1", 13, [
        `status=complete req=${requestId}`,
        "body written so far, still generating...",
      ]);
      const r = await readReportFile(workspaceDir, "codex1", 13, requestId);
      assertEqual(r.state, "invalid");
      assertEqual(r.reason, "eof_missing");
    });

    await checkAsync("readReportFile: body quoting an EOF marker mid-file — only the LAST line commits", async () => {
      const requestId = "req-quoted-eof";
      await writeReportFile(workspaceDir, "codex1", 14, [
        `status=complete req=${requestId}`,
        "The protocol footer says the last line should read:",
        `<<<PMUX_EOF req=${requestId}>>>`,
        "...but this is just body text quoting it, not the real end.",
        `<<<PMUX_EOF req=${requestId}>>>`,
      ]);
      const r = await readReportFile(workspaceDir, "codex1", 14, requestId);
      assertEqual(r.state, "valid");
      assertEqual(
        r.content,
        [
          "The protocol footer says the last line should read:",
          `<<<PMUX_EOF req=${requestId}>>>`,
          "...but this is just body text quoting it, not the real end.",
        ].join("\n"),
      );
    });

    await checkAsync(
      "roundtrip: a virtual agent following makeFileFooter's split-string instructions verbatim produces output readReportFile/parseDoneSignal accept (턴4 리뷰 blocking regression guard)",
      async () => {
        const agentId = "codex1";
        const turn = 20;
        const requestId = "req-roundtrip";
        const footer = makeFileFooter({ workspaceDir, agentId, turn, requestId });

        // Nothing in the footer's instruction text is a complete marker...
        assert(!footer.includes("<<<PMUX_DONE"), "footer must never contain a complete DONE marker");
        assert(!footer.includes("<<<PMUX_EOF"), "footer must never contain a complete EOF marker");

        // ...but assembling exactly what it instructs must match a real path
        // and produce markers the parsers accept.
        const reportPath = extractReportPathFromFooter(footer);
        assertEqual(reportPath, agentReportPath(workspaceDir, agentId, turn));

        const line1 = extractLine1TemplateFromFooter(footer);
        const eofLine = extractAssembledFragmentsFromFooter(footer, "마지막 줄");
        const doneLine = extractAssembledFragmentsFromFooter(footer, "화면에는");

        const body = "this is the agent's response body, written per the footer's instructions";
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, [line1, body, eofLine].join("\n"));

        const fileResult = await readReportFile(workspaceDir, agentId, turn, requestId);
        assertEqual(fileResult.state, "valid");
        assertEqual(fileResult.status, "complete");
        assertEqual(fileResult.content, body);

        const doneResult = parseDoneSignal({ pane: doneLine, agentId, turn, requestId });
        assertEqual(doneResult.found, true);
        assertEqual(doneResult.status, "complete");
      },
    );

    await checkAsync("readReportFile: propagates agentId path-traversal rejection as ToolError", async () => {
      let threw = false;
      try {
        await readReportFile(workspaceDir, "../x", 1, "req1");
      } catch (e) {
        threw = true;
        assert(e && e.name === "ToolError", "must throw ToolError, not a raw fs error");
      }
      assert(threw, "expected readReportFile to reject a path-traversal agentId");
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

await runReportFileTests();

// ---- detectRuntimeError: narrowed default pattern (2026-07-08 합의) --------
//
// Two REAL false positives drove the narrowing — codex's "usage limit
// resets available" banner and claude's Fable 5 promo line — both matched
// bare `usage limit` and made wait_ready report runtimeError on perfectly
// healthy boots.

check("detectRuntimeError: REAL 2026-07-08 banner lines must NOT match (narrowing regression guard)", () => {
  for (const banner of [
    "• You have 3 usage limit resets available. Run /usage to use one.",
    " ▎ Until July 7, you can use up to 50% of your plan's weekly usage limit on Fable 5. If you hit",
    "your rate limits reset at midnight",
  ]) {
    const r = detectRuntimeError(banner);
    assertEqual(r.found, false, `banner must not match: ${banner}`);
  }
});

check("detectRuntimeError: genuine limit-failure phrasings still match (both verb orders)", () => {
  for (const sample of [
    "Claude usage limit reached",
    "usage limit exceeded",
    "you have hit your usage limit",
    "rate limit reached — retry later",
    "you exceeded the rate limit",
    "too many requests",
    "connection timed out",
    "API Error: 529",
  ]) {
    const r = detectRuntimeError(sample);
    assert(r.found, `expected a match for: ${sample}`);
  }
});

// ---- classifyReadiness: claude 2.1.x spinner busy + approval dialog -------

check("classifyReadiness: REAL claude spinner line (✻ Booping… (5m …)) → agent_busy (2026-07-08 실측: was missed, capture returned missing mid-turn)", () => {
  const pane = [
    "● I've read the plan and all five source files. Let me write the review.",
    "",
    "✢ Booping… (5m 0s · ↓ 15.0k tokens)",
    "",
    "───────────────────────────────────────────────────────────────",
    "❯ ",
    "───────────────────────────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_busy");
});

check("classifyReadiness: claude completion line (✻ Brewed for 27s, no ellipsis+paren) is NOT busy → ready on bare composer", () => {
  const pane = [
    "● done.",
    "",
    "✻ Brewed for 27s",
    "",
    "───────────────────────────────────────────────────────────────",
    "❯ ",
    "───────────────────────────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_ready");
});

check("classifyReadiness: claude approval dialog → agent_blocked (pane-side detector required since ready-for-review degraded to null)", () => {
  const pane = [
    "  Here is my plan: …",
    "",
    "  Would you like to proceed?",
    "  ❯ 1. Yes",
    "    2. No, keep planning",
  ].join("\n");
  const r = classifyReadiness({ pane, provider: "claude" });
  assertEqual(r.state, "agent_blocked");
  // codex is unaffected — the signature is claude-only.
  const codex = classifyReadiness({ pane, provider: "codex" });
  assert(codex.state !== "agent_blocked", "codex must not use the claude approval signature");
});

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

// ---- guide (LLM-facing docs consistency) --------------------------------

check("guide: SERVER_INSTRUCTIONS is a distillation of ORCHESTRATION_GUIDE", () => {
  // Every tool named in the instructions must appear in the full guide too —
  // the short version must never tell a different story.
  const toolsInInstructions = SERVER_INSTRUCTIONS.match(/pmux_[a-z_]+/g) ?? [];
  assert(toolsInInstructions.length > 0, "instructions must name tools");
  for (const t of new Set(toolsInInstructions)) {
    assert(ORCHESTRATION_GUIDE.includes(t), `guide missing tool ${t}`);
  }
});

check("guide: golden-path tools are documented in both texts", () => {
  for (const t of [
    "pmux_agent_start",
    "pmux_agent_wait_ready",
    "pmux_agent_turn",
    "pmux_close_tab",
    "pmux_guide",
  ]) {
    assert(SERVER_INSTRUCTIONS.includes(t), `instructions missing ${t}`);
    assert(ORCHESTRATION_GUIDE.includes(t), `guide missing ${t}`);
  }
});

check("guide: SERVER_INSTRUCTIONS stays concise (injected into every session)", () => {
  assert(
    SERVER_INSTRUCTIONS.length < 3000,
    `instructions too long: ${SERVER_INSTRUCTIONS.length} chars`,
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\nall unit tests passed");
}
