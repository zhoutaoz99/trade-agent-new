export type AgentRole = "orchestrator" | "trader" | "chairman" | "member";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface TraderConfig {
  model: ModelRef;
  systemPrompt: string;
  maxToolCalls?: number;
}

export interface CommitteeMemberConfig {
  id: string;
  name: string;
  model: ModelRef;
  systemPrompt: string;
}

export interface CommitteeConfig {
  chairman: CommitteeMemberConfig;
  members: CommitteeMemberConfig[];
  maxRounds: number;
  initialFocus?: string;
}

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface AppConfig {
  id?: number;
  cronExpr: string;
  trader: TraderConfig;
  committee: CommitteeConfig;
  mcpServers: McpServerConfig[];
}

export type RunStatus = "pending" | "trading" | "committee" | "done" | "failed";
export type RunTrigger = "cron" | "manual";

export interface RunRow {
  id: string;
  configId: number;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  trigger: RunTrigger;
  prevRunId: string | null;
  traderSummary: string | null;
  advice: string | null;
  error: string | null;
}

export interface RunEvent {
  seq: number;
  runId: string;
  agentId: string;
  agentRole: AgentRole;
  round?: number;
  ts: string;
  kind: string;
  payload: unknown;
}

export type RunEventInput = Omit<RunEvent, "seq" | "ts">;
