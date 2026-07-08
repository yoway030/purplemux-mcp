import { callApi } from "../http.js";
import { ToolError } from "../errors.js";
import type {
  PaneResult,
  TabCreateResult,
  TabStatusResult,
  TabStatusSnapshot,
  WorkspaceInfo,
  WorkspaceListResult,
} from "./types.js";

export async function capturePane(workspaceId: string, tabId: string): Promise<string> {
  const payload = await callApi<PaneResult | string>(
    "GET",
    `/api/cli/tabs/${encodeURIComponent(tabId)}/result`,
    { query: { workspaceId } },
  );
  if (typeof payload === "string") return payload;
  if (typeof payload.content === "string") return payload.content;
  throw new ToolError("Capture response did not include string content.", {
    details: { tabId },
  });
}

export async function tabStatus(
  workspaceId: string,
  tabId: string,
): Promise<TabStatusSnapshot> {
  const payload = await callApi<TabStatusResult>(
    "GET",
    `/api/cli/tabs/${encodeURIComponent(tabId)}/status`,
    { query: { workspaceId } },
  );
  return {
    alive: payload.alive === true,
    rawCliState:
      typeof payload.cliState === "string" && payload.cliState.length > 0
        ? payload.cliState
        : null,
    command:
      typeof payload.command === "string" && payload.command.length > 0
        ? payload.command
        : null,
  };
}

async function tabAlive(workspaceId: string, tabId: string): Promise<boolean> {
  return (await tabStatus(workspaceId, tabId)).alive;
}

export async function resolveWorkspaceDir(workspaceId: string): Promise<string> {
  const payload = await callApi<WorkspaceListResult>(
    "GET",
    "/api/cli/workspaces",
  );
  const workspaces = Array.isArray(payload.workspaces)
    ? (payload.workspaces as WorkspaceInfo[])
    : [];
  const workspace = workspaces.find((w) => {
    const id = typeof w.id === "string" ? w.id : w.workspaceId;
    return id === workspaceId;
  });
  const dirs = workspace && Array.isArray(workspace.directories)
    ? workspace.directories
    : [];
  const firstDir = dirs.find((dir): dir is string => typeof dir === "string");
  if (!firstDir) {
    throw new ToolError(
      `Workspace ${workspaceId} has no directories[0]; cannot resolve agent report path.`,
      { details: { workspaceId } },
    );
  }
  return firstDir;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractTabId(payload: TabCreateResult): string {
  const tabId = asString(payload.tabId) ?? asString(payload.id);
  if (!tabId) {
    throw new ToolError("Create-tab response did not include a tabId.", {
      details: { response: payload },
    });
  }
  return tabId;
}

export function sessionName(payload: TabCreateResult, tabId: string): string {
  return (
    asString(payload.sessionName) ??
    asString(payload.tmuxSession) ??
    asString(payload.agentSessionId) ??
    asString(payload.claudeSessionId) ??
    tabId
  );
}
