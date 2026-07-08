// Unit tests for src/paths.ts (dist/ build).
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { assert, assertEqual, check, checkAsync, throws } from "./helpers.mjs";

import {
  agentReportPath,
  makeFileFooter,
  readReportFile,
} from "../../dist/paths.js";
import { parseDoneSignal } from "../../dist/pane.js";

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
