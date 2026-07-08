import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { guard, jsonResult } from "../tool-result.js";
import * as S from "../schemas.js";
import { runAgentStart } from "./start.js";
import { runWaitReady } from "./wait-ready.js";
import { runAgentStatus } from "./status.js";
import { captureAgentEvidence, runAgentTurn, sendAgentPrompt } from "./turn.js";
import type {
  AgentCaptureArgs,
  AgentSendArgs,
  AgentTurnArgs,
} from "./types.js";

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "pmux_agent_start",
    {
      description:
        "Primary agent orchestration tool: create a terminal tab, poll briefly for shell readiness, then send an interactive agent CLI command. DEFAULTS (standing user config): omitted model/effort resolve to codex=gpt-5.5+medium, claude=claude-sonnet-5+high — launch with these without asking; confirm with the user only when a different configuration seems needed (codex sandbox / claude permissionMode still follow the task: read-only/plan for review-only work). Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. Returns recommendedFileOutput: false for read-only/plan agents that should be sent fileOutput:false. Boot verification: returns bootId and wires a SessionStart boot-signal file. bootstrapEcho defaults true for codex and false for claude: for codex, verify with pmux_agent_wait_ready {bootId, expectEcho:true}, then send user work from turn=1 (bootstrap consumed turn 0; do not pass expectPrevTurnEnd on turn 1); for claude's default path, call pmux_agent_wait_ready with bootId and expectEcho:false, then send user work from turn=1. Claude skips the synthetic echo by default because boot tokens can look like monitoring/protocol text and trigger needless interpretation. Set bootstrapEcho explicitly to override. codex hook trust (실측 2026-07-08): the FIRST launch that wires the boot hook requires a one-time interactive trust approval in the codex TUI — until approved, boot.fileSeen stays false while the echo still works; treat fileSeen:false + echoSeen:true on codex as this case, not a failure. This is non-blocking: after a successful start return, use pmux_agent_wait_ready before sending work. wait_ready launch_failed is meaningful only after start has successfully sent the command; an idle shell before command send is indistinguishable to the stateless wait tool. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab. Codex command: codex --no-alt-screen -s <sandbox>; Claude permissionMode choices are based on claude 2.1.201 and intentionally exclude bypassPermissions; claude effort maps to the --effort flag (claude >=2.1.202).",
      inputSchema: S.agentStartShape,
    },
    guard(runAgentStart),
  );

  server.registerTool(
    "pmux_agent_wait_ready",
    {
      description:
        "Primary agent orchestration tool: poll a tab until an agent is ready, still starting/busy, launch_failed, exited, or timeout. Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. agent_busy is non-terminal and keeps polling. Boot verification after pmux_agent_start: pass bootId; pass expectEcho:true only when start used bootstrapEcho:true (codex default, claude only when explicitly enabled). Under expectEcho, agent_ready is returned ONLY on the bootstrap DONE marker (completion evidence; supersedes ready heuristics, requireBusyTransition and runtimeError), and every response carries boot.fileSeen (SessionStart boot-signal file — diagnostic only; on echo timeout, fileSeen:false suggests launch/hook-trust failure while fileSeen:true suggests the model never answered). Claude's default boot path uses expectEcho:false and readiness comes from cliState/pane heuristics plus the diagnostic boot file. Default timeout rises to 90s under expectEcho. requireBusyTransition defaults false for boot readiness; set true when waiting after send so ready is returned only after busy was observed or an initial non-ready baseline later changes to ready. In boot mode only (and never under expectEcho), pane fallback input_queued can be treated as a composer placeholder and returned ready; send validation remains strict. Uses pane capture + tab_status only; no server-side registry is kept. Session lifetime contract: keep the tab open until the task is finished, then close it with pmux_close_tab.",
      inputSchema: S.agentWaitReadyShape,
    },
    guard(runWaitReady),
  );

  server.registerTool(
    "pmux_agent_send",
    {
      description:
        "Primary agent orchestration tool: validate provider-specific readiness/busy/error state, optionally verify a previous DONE signal or END marker, append the v2.1 PMUX footer, and send the prompt. Use pmux_send_input/pmux_capture_pane only as low-level fallbacks. For fileOutput=true previous turns, pass expectPrevTurnEnd together with expectPrevRequestId so shortened req-keyed markers can be matched. On turn <= 1 only, pane fallback input_queued is treated as a composer placeholder and sent with validation.warning; later turns remain strict. fileOutput defaults true: requestId is generated when omitted, workspaceDir is resolved from workspaces[].directories[0], and expectedReportFile is returned. Use fileOutput:false when pmux_agent_start returned recommendedFileOutput:false; read-only/plan agents cannot write report files. fileOutput=false uses the pane BEGIN/END fallback. agent_busy returns {sent:false, reason:\"busy\"}. Caller contract: if pmux_agent_capture returns partial/working, do not call pmux_agent_send again until the current turn completes or is explicitly abandoned.",
      inputSchema: S.agentSendShape,
    },
    guard(async (args: AgentSendArgs) => {
      return jsonResult(await sendAgentPrompt(args));
    }),
  );

  server.registerTool(
    "pmux_agent_turn",
    {
      description:
        "Primary agent orchestration tool for one full turn: send a prompt, poll for completion evidence, then return the recovered response. Safe to call immediately after a previous turn; transient pre-send busy/starting states are retried within the same pollTimeoutMs budget. Use pmux_agent_capture with the returned marker to resume after timeout; use pmux_send_input/pmux_capture_pane only as low-level fallbacks. Completion evidence from a valid report file or pane markers wins over readiness/runtime-error signals. Without completion evidence, ready plus runtimeError returns status:\"agent_error\".",
      inputSchema: S.agentTurnShape,
    },
    guard(async (args: AgentTurnArgs) => jsonResult(await runAgentTurn(args))),
  );

  server.registerTool(
    "pmux_agent_capture",
    {
      description:
        "Primary agent orchestration tool: recover a v2.1 agent response. Use pmux_capture_pane only as a low-level fallback. If requestId is supplied, first read the report file at workspaceDir/.pmux-agents/<agentId>/turn-<n>.md and require matching status line plus EOF marker. Without requestId, file recovery is skipped and pane BEGIN/END fallback is used. Returns structured complete/blocked/working/inconsistent/partial/missing results; partial/working means do not send the next turn yet.",
      inputSchema: S.agentCaptureShape,
    },
    guard(async (args: AgentCaptureArgs) => {
      const evidence = await captureAgentEvidence(args);
      const { tail: _tail, ...withoutTail } = evidence;
      if (evidence.status === "complete" || evidence.status === "blocked") {
        return jsonResult(withoutTail);
      }
      return jsonResult(evidence);
    }),
  );

  server.registerTool(
    "pmux_agent_status",
    {
      description:
        "Primary agent orchestration tool: return a no-wait v2.1 status snapshot. Use pmux_tab_status/pmux_capture_pane only as low-level fallbacks. Includes tab alive, provider-specific readiness, optional DONE signal for agentId/turn/requestId, optional report-file check, runtimeError when detected, and pane tail. No server-side state is kept.",
      inputSchema: S.agentStatusShape,
    },
    guard(runAgentStatus),
  );
}
