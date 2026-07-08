import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { callApi } from "../http.js";
import { ToolError } from "../errors.js";
import { jsonResult } from "../tool-result.js";
import { buildAgentCommand } from "../profiles.js";
import { TAIL_LINES, tailLines } from "../pane.js";
import {
  bootFilePath,
  buildBootstrapEchoPrompt,
  codexHookConfigs,
  ensureBootHookScript,
  pruneBootArtifacts,
  writeClaudeBootSettings,
  type SettingsMerge,
} from "../boot.js";
import { capturePane, extractTabId, sessionName } from "./api.js";
import { generateRequestId, sleep, validateModel } from "./common.js";
import type { AgentStartArgs, TabCreateResult } from "./types.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wire app hooks AND the boot-signal SessionStart hook (design 2026-07-08).
 * `hooksWired` keeps its original meaning (purplemux app status hooks);
 * `bootWired` reports the boot-signal wiring separately. Boot wiring
 * degrades gracefully: any fs failure falls back to the legacy app-hook-only
 * command with bootWired:false rather than failing the start. NOTE (codex
 * hook trust): a wired-but-never-seen boot file can be a NORMAL state if the
 * CLI's hook trust layer holds the new script — fileSeen is diagnostic only.
 */
async function wireHooksAndBoot(
  args: AgentStartArgs,
  command: string,
  bootId: string,
): Promise<{
  command: string;
  hooksWired: boolean;
  bootWired: boolean;
  settingsMerge?: SettingsMerge;
}> {
  const home = homedir();
  let bootHookPath: string | undefined;
  try {
    bootHookPath = await ensureBootHookScript();
  } catch {
    bootHookPath = undefined;
  }

  if (args.provider === "claude") {
    if (bootHookPath !== undefined) {
      try {
        const s = await writeClaudeBootSettings(bootId, bootHookPath);
        return {
          command: `${command} --settings ${shellQuote(s.path)}`,
          hooksWired: s.appHooksWired,
          bootWired: true,
          settingsMerge: s.settingsMerge,
        };
      } catch {
        // fall through to legacy app-hook-only wiring
      }
    }
    const settingsPath = `${home}/.purplemux/hooks.json`;
    if (!existsSync(settingsPath)) {
      return { command, hooksWired: false, bootWired: false };
    }
    return {
      command: `${command} --settings ${shellQuote(settingsPath)}`,
      hooksWired: true,
      bootWired: false,
    };
  }

  const appHook = `${home}/.purplemux/codex-hook.sh`;
  const appHookPath = existsSync(appHook) ? appHook : undefined;
  let configs: string[];
  try {
    configs = codexHookConfigs({ appHookPath, bootHookPath });
  } catch {
    // unsafe hook path (allowlist violation) — degrade instead of
    // assembling a shell-expandable hook command.
    return { command, hooksWired: false, bootWired: false };
  }
  if (configs.length === 0) {
    return { command, hooksWired: false, bootWired: false };
  }
  const hookArgs = configs.map((config) => `-c ${shellQuote(config)}`);
  return {
    command: `${command} ${hookArgs.join(" ")}`,
    hooksWired: appHookPath !== undefined,
    bootWired: bootHookPath !== undefined,
  };
}

export function looksShellReady(pane: string): boolean {
  const lines = pane
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const recent = lines.slice(-8);
  return recent.some((line) => /(?:^|[~\w./:@-])(?:[$#%>]|❯)\s*$/.test(line));
}

async function waitForShellReady(o: {
  workspaceId: string;
  tabId: string;
  timeoutMs: number;
}): Promise<{ ready: true; pane: string } | { ready: false; pane: string }> {
  const started = Date.now();
  let lastPane = "";
  while (Date.now() - started <= o.timeoutMs) {
    try {
      lastPane = await capturePane(o.workspaceId, o.tabId);
      if (looksShellReady(lastPane)) {
        return { ready: true, pane: lastPane };
      }
    } catch (err) {
      if (!(err instanceof ToolError && err.status === 409)) {
        throw err;
      }
    }
    const remaining = o.timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(300, remaining));
  }
  return { ready: false, pane: lastPane };
}

export function recommendedFileOutput(args: AgentStartArgs): boolean {
  if (args.provider === "codex") {
    return (args.sandbox ?? "read-only") !== "read-only";
  }
  return (args.permissionMode ?? "plan") !== "plan";
}

export function defaultBootstrapEcho(args: AgentStartArgs): boolean {
  return args.provider === "codex";
}

export async function runAgentStart(args: AgentStartArgs): Promise<CallToolResult> {
  validateModel(args.model);
  const base = buildAgentCommand(args);
  const bootId = generateRequestId();
  const bootFile = bootFilePath(bootId);
  const wired = await wireHooksAndBoot(args, base.command, bootId);
  const bootstrapEcho = args.bootstrapEcho ?? defaultBootstrapEcho(args);
  // `env VAR=… cmd` (not the bare VAR=… prefix) so fish shells work too.
  let command = wired.bootWired
    ? `env PMUX_BOOT_FILE=${shellQuote(bootFile)} ${wired.command}`
    : wired.command;
  if (bootstrapEcho) {
    // Positional initial prompt LAST, after every flag (auto-submitted
    // by both CLIs — 실측 2026-07-08). Claude does not use this by default
    // because a synthetic boot token can trigger needless interpretation.
    // Fixed template; only the hex
    // bootId is interpolated, so the §4.6 allowlist invariant holds.
    command = `${command} ${shellQuote(buildBootstrapEchoPrompt(bootId))}`;
  }
  await pruneBootArtifacts(bootId);
  const fileOutputHint = recommendedFileOutput(args);
  const next = bootstrapEcho
    ? "pmux_agent_wait_ready에 bootId와 expectEcho:true를 전달해 echo 완료를 확인한 뒤 turn=1부터 작업 전송 (bootstrap이 turn 0을 소비하므로 사용자 턴은 1부터, turn 1에는 expectPrevTurnEnd를 주지 말 것)"
    : "pmux_agent_wait_ready(bootId 전달 권장, expectEcho:false) 후 turn=1부터 pmux_agent_send 또는 pmux_agent_turn";
  const bootFields = {
    bootId,
    bootFile,
    bootWired: wired.bootWired,
    ...(wired.settingsMerge !== undefined
      ? { settingsMerge: wired.settingsMerge }
      : {}),
    bootstrapEcho,
  };
  // command is safe to return because all assembled inputs are allowlisted.
  // If future free-form command args are added, redact here before returning.
  const created = await callApi<TabCreateResult>("POST", "/api/cli/tabs", {
    body: {
      workspaceId: args.workspaceId,
      name: args.name,
      panelType: "terminal",
    },
  });
  const tabId = extractTabId(created);
  const shell = await waitForShellReady({
    workspaceId: args.workspaceId,
    tabId,
    timeoutMs: args.shellTimeoutMs ?? 5_000,
  });
  if (!shell.ready) {
    return jsonResult({
      state: "not_shell_ready",
      tabId,
      sessionName: sessionName(created, tabId),
      command,
      provider: args.provider,
      hooksWired: wired.hooksWired,
      ...bootFields,
      recommendedFileOutput: fileOutputHint,
      next,
      fallback: "wait_ready timeout이나 판정 불확실 시 pmux_capture_pane으로 직접 확인",
      tail: tailLines(shell.pane, TAIL_LINES),
    });
  }
  await callApi("POST", `/api/cli/tabs/${encodeURIComponent(tabId)}/send`, {
    query: { workspaceId: args.workspaceId },
    body: { content: command },
  });
  return jsonResult({
    tabId,
    sessionName: sessionName(created, tabId),
    command,
    provider: args.provider,
    hooksWired: wired.hooksWired,
    ...bootFields,
    recommendedFileOutput: fileOutputHint,
    next,
    fallback: "wait_ready timeout이나 판정 불확실 시 pmux_capture_pane으로 직접 확인",
  });
}
