// Pure-function unit tests for src/profiles.ts, src/pane.ts and src/paths.ts
// (dist/ build). No framework — plain node, fails with exit 1 on any
// assertion failure.
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  buildAgentCommand,
  compileUserPattern,
} from "../dist/profiles.js";
import {
  buildSentinelFooter,
  classifyReadiness,
  extractMarkerBlock,
  makeMarkers,
  parseDoneSignal,
} from "../dist/pane.js";
import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "../dist/paths.js";

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
  const { command, bootstrapHint } = buildAgentCommand({
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
    sandbox: "workspace-write",
  });
  assertEqual(
    command,
    "codex --no-alt-screen -s workspace-write -m gpt-5.5 -c model_reasoning_effort=high",
  );
  assertEqual(bootstrapHint, undefined);
});

check("buildAgentCommand: codex defaults (no model/effort)", () => {
  const { command } = buildAgentCommand({ provider: "codex" });
  assertEqual(command, "codex --no-alt-screen -s read-only");
});

check("buildAgentCommand: claude normal", () => {
  const { command, bootstrapHint } = buildAgentCommand({
    provider: "claude",
    model: "claude-sonnet-5",
    permissionMode: "acceptEdits",
  });
  assertEqual(
    command,
    "claude --model claude-sonnet-5 --permission-mode acceptEdits",
  );
  assertEqual(bootstrapHint, undefined);
});

check("buildAgentCommand: claude effort → bootstrapHint (not in command)", () => {
  const { command, bootstrapHint } = buildAgentCommand({
    provider: "claude",
    effort: "xhigh",
  });
  assert(
    !command.includes("xhigh") && !command.includes("effort"),
    "effort must not leak into the claude command line",
  );
  assert(
    typeof bootstrapHint === "string" && bootstrapHint.includes("xhigh"),
    "bootstrapHint must carry the effort value",
  );
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
  // forever; v2 scopes errorPattern to tail(15) same as busy/ready.
  const pane = [
    "assistant: earlier in this session I saw: bash: codex: command not found",
    ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\nall unit tests passed");
}
