import type { Provider } from "../profiles.js";

export type AgentStartArgs = {
  workspaceId: string;
  name?: string;
  provider: Provider;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write";
  permissionMode?: "plan" | "manual" | "acceptEdits" | "dontAsk" | "auto";
  shellTimeoutMs?: number;
  bootstrapEcho?: boolean;
};

export type AgentWaitReadyArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  timeoutMs?: number;
  pollMs?: number;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
  runtimeErrorPattern?: string;
  requireBusyTransition?: boolean;
  bootId?: string;
  expectEcho?: boolean;
};

export type AgentSendArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  agentId: string;
  turn: number;
  prompt: string;
  requestId?: string;
  fileOutput?: boolean;
  maxResponseLines?: number;
  expectPrevTurnEnd?: number;
  expectPrevRequestId?: string;
  skipReadyCheck?: boolean;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
  runtimeErrorPattern?: string;
};

export type AgentCaptureArgs = {
  workspaceId: string;
  tabId: string;
  agentId: string;
  turn: number;
  requestId?: string;
};

export type AgentTurnArgs = AgentSendArgs & {
  pollTimeoutMs?: number;
  pollMs?: number;
};

export type AgentStatusArgs = {
  workspaceId: string;
  tabId: string;
  provider: Provider;
  agentId?: string;
  turn?: number;
  requestId?: string;
  readyPattern?: string;
  errorPattern?: string;
  busyPattern?: string;
  runtimeErrorPattern?: string;
};

export interface TabCreateResult {
  tabId?: unknown;
  id?: unknown;
  sessionName?: unknown;
  tmuxSession?: unknown;
  agentSessionId?: unknown;
  claudeSessionId?: unknown;
}

export interface TabStatusResult {
  alive?: unknown;
  cliState?: unknown;
  command?: unknown;
}

export interface PaneResult {
  content?: unknown;
}

export interface WorkspaceListResult {
  workspaces?: unknown;
}

export interface WorkspaceInfo {
  id?: unknown;
  workspaceId?: unknown;
  directories?: unknown;
}

export type ReportFileStatus = {
  exists: boolean;
  statusLine?: "complete" | "blocked" | "invalid";
  reqMatch?: boolean;
  eofPresent?: boolean;
  bytes?: number;
};

export type RuntimeErrorInfo = { match: string; line: string };

export type MarkerInfo = {
  agentId: string;
  turn: number;
  requestId?: string;
};

export type AgentSendValue =
  | {
      sent: true;
      marker: MarkerInfo;
      expectedReportFile?: string;
      validation: {
        ready?: boolean;
        prevTurnEnd?: boolean;
        warning?: string;
      };
      signalSource: "cliState" | "pane";
      rawCliState: string | null;
      command: string | null;
      runtimeError?: RuntimeErrorInfo;
    }
  | {
      sent: false;
      reason:
        | "launch_failed"
        | "busy"
        | "blocked"
        | "not_ready"
        | "missing_prev_turn_end";
      signalSource: "cliState" | "pane";
      rawCliState: string | null;
      command: string | null;
      tail: string;
      readinessState?: string;
      readinessReason?: string;
      runtimeError?: RuntimeErrorInfo;
    };

export type NativeState =
  | "agent_ready"
  | "agent_busy"
  | "agent_starting"
  | "agent_blocked"
  | "launch_failed";

export type TabStatusSnapshot = {
  alive: boolean;
  rawCliState: string | null;
  command: string | null;
};

export type CaptureEvidence =
  | {
      status: "complete" | "blocked";
      content: string;
      source: "file" | "pane";
      doneSignal?: boolean;
      tail: string;
    }
  | {
      status: "working" | "partial" | "inconsistent" | "missing";
      reason?: string;
      contentSoFar?: string;
      tail: string;
    };
