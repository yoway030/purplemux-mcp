// Unit tests for the pure helpers exported by src/agents/ (post-P3 split).
// These cover the seams that used to be untestable inside the monolithic
// agents.ts; the HTTP-dependent orchestration paths stay covered by
// smoke/e2e (plan-sustainability-refactor.md 검증 강화).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { check, checkAsync, assert, assertEqual } from "./helpers.mjs";

import { compileAllPatterns } from "../../dist/agents/readiness.js";
import {
  defaultBootstrapEcho,
  looksShellReady,
  recommendedFileOutput,
} from "../../dist/agents/start.js";
import { extractTabId, sessionName } from "../../dist/agents/api.js";
import { buildPaneFallbackFooter, reportFileStatus } from "../../dist/agents/report.js";
import { makeMarkers } from "../../dist/pane.js";
import { MARKER_PREFIX, agentReportPath, readReportFile } from "../../dist/paths.js";

// ---- compileAllPatterns ---------------------------------------------------

check("compileAllPatterns: provider defaults, runtimeError undefined when omitted", () => {
  for (const provider of ["codex", "claude"]) {
    const p = compileAllPatterns({}, provider);
    assert(p.readyPattern instanceof RegExp, `${provider} readyPattern`);
    assert(p.errorPattern instanceof RegExp, `${provider} errorPattern`);
    assert(p.busyPattern instanceof RegExp, `${provider} busyPattern`);
    assertEqual(p.runtimeErrorPattern, undefined, `${provider} runtimeErrorPattern`);
  }
});

check("compileAllPatterns: user overrides compile and apply", () => {
  const p = compileAllPatterns(
    { readyPattern: "^READY$", runtimeErrorPattern: "BOOM" },
    "codex",
  );
  assert(p.readyPattern.test("READY"), "override ready matches");
  assert(!p.readyPattern.test("not ready"), "override ready is exact");
  assert(p.runtimeErrorPattern?.test("BOOM"), "runtimeError override compiles");
});

check("compileAllPatterns: invalid user pattern throws", () => {
  let threw = false;
  try {
    compileAllPatterns({ busyPattern: "([unclosed" }, "claude");
  } catch {
    threw = true;
  }
  assert(threw, "invalid busyPattern must throw");
});

// ---- recommendedFileOutput ------------------------------------------------

check("recommendedFileOutput: codex sandbox routing (default workspace-write → true)", () => {
  assertEqual(recommendedFileOutput({ provider: "codex" }), true);
  assertEqual(recommendedFileOutput({ provider: "codex", sandbox: "read-only" }), false);
  assertEqual(recommendedFileOutput({ provider: "codex", sandbox: "workspace-write" }), true);
});

check("recommendedFileOutput: claude permissionMode routing (default acceptEdits → true)", () => {
  assertEqual(recommendedFileOutput({ provider: "claude" }), true);
  assertEqual(recommendedFileOutput({ provider: "claude", permissionMode: "plan" }), false);
  assertEqual(recommendedFileOutput({ provider: "claude", permissionMode: "acceptEdits" }), true);
});

// ---- defaultBootstrapEcho ------------------------------------------------

check("defaultBootstrapEcho: codex keeps echo evidence, claude avoids synthetic boot prompt by default", () => {
  assertEqual(defaultBootstrapEcho({ provider: "codex" }), true);
  assertEqual(defaultBootstrapEcho({ provider: "claude" }), false);
});

// ---- looksShellReady --------------------------------------------------------

check("looksShellReady: shell prompt glyphs in recent lines", () => {
  assert(looksShellReady("user@host:~/repo$ "), "bash $ prompt");
  assert(looksShellReady("❯ "), "line-start ❯ prompt");
  assert(looksShellReady("~/repo❯ "), "path-adjacent ❯ prompt");
  assert(!looksShellReady(""), "empty pane");
  assert(!looksShellReady("Booting agent CLI...\nplease wait"), "no prompt yet");
});

// ---- extractTabId / sessionName --------------------------------------------

check("extractTabId: tabId, id fallback, throw on neither", () => {
  assertEqual(extractTabId({ tabId: "tab-a" }), "tab-a");
  assertEqual(extractTabId({ id: "tab-b" }), "tab-b");
  assertEqual(extractTabId({ tabId: "tab-a", id: "tab-b" }), "tab-a", "tabId wins");
  let threw = false;
  try {
    extractTabId({ name: "no-id" });
  } catch {
    threw = true;
  }
  assert(threw, "missing id must throw");
});

check("sessionName: precedence chain with tabId fallback", () => {
  assertEqual(sessionName({ sessionName: "s1", tmuxSession: "t1" }, "tab-x"), "s1");
  assertEqual(sessionName({ tmuxSession: "t1" }, "tab-x"), "t1");
  assertEqual(sessionName({}, "tab-x"), "tab-x");
});

// ---- buildPaneFallbackFooter ------------------------------------------------

check("buildPaneFallbackFooter: split-marker safety (no complete marker in footer)", () => {
  const o = { agentId: "worker1", turn: 3, requestId: "req42", maxResponseLines: 40 };
  const footer = buildPaneFallbackFooter(o);
  const { begin, end } = makeMarkers(o);
  assert(!footer.includes(begin), "footer must not contain the complete BEGIN marker");
  assert(!footer.includes(end), "footer must not contain the complete END marker");
  assert(footer.includes(begin.slice(MARKER_PREFIX.length)), "footer carries BEGIN tail part");
  assert(footer.includes(end.slice(MARKER_PREFIX.length)), "footer carries END tail part");
  assert(footer.includes("40줄"), "maxResponseLines is embedded");
});

// ---- reportFileStatus (real temp filesystem) --------------------------------

async function runReportStatusTests() {
  const dir = await mkdtemp(join(tmpdir(), "pmux-agents-report-"));
  const agentId = "ragent";
  const turn = 1;
  const requestId = "req1";
  const path = agentReportPath(dir, agentId, turn);
  await mkdir(join(dir, ".pmux-agents", agentId), { recursive: true });
  try {
    await checkAsync("reportFileStatus: missing file → exists:false", async () => {
      const st = await reportFileStatus(
        await readReportFile(dir, agentId, turn, requestId),
        path,
        requestId,
      );
      assertEqual(st.exists, false);
    });

    await checkAsync("reportFileStatus: valid report → complete + eofPresent", async () => {
      await writeFile(
        path,
        [`status=complete req=${requestId}`, "본문", `<<<PMUX_EOF req=${requestId}>>>`, ""].join("\n"),
      );
      const st = await reportFileStatus(
        await readReportFile(dir, agentId, turn, requestId),
        path,
        requestId,
      );
      assertEqual(st.exists, true);
      assertEqual(st.statusLine, "complete");
      assertEqual(st.reqMatch, true);
      assertEqual(st.eofPresent, true);
    });

    await checkAsync("reportFileStatus: req mismatch → reqMatch:false", async () => {
      await writeFile(
        path,
        ["status=complete req=otherreq", "본문", "<<<PMUX_EOF req=otherreq>>>", ""].join("\n"),
      );
      const st = await reportFileStatus(
        await readReportFile(dir, agentId, turn, requestId),
        path,
        requestId,
      );
      assertEqual(st.exists, true);
      assertEqual(st.reqMatch, false);
    });

    await checkAsync("reportFileStatus: missing EOF → eofPresent:false (uncommitted write)", async () => {
      await writeFile(
        path,
        [`status=complete req=${requestId}`, "본문 (EOF 없음)", ""].join("\n"),
      );
      const st = await reportFileStatus(
        await readReportFile(dir, agentId, turn, requestId),
        path,
        requestId,
      );
      assertEqual(st.exists, true);
      assertEqual(st.eofPresent, false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await runReportStatusTests();
