export interface ModelRef {
  provider: string;
  model: string;
}

export interface CommitteeMember {
  id: string;
  name: string;
  model: ModelRef;
  systemPrompt: string;
}

export interface AppConfig {
  id?: number;
  cronExpr: string;
  trader: { model: ModelRef; systemPrompt: string; maxToolCalls?: number };
  committee: {
    chairman: CommitteeMember;
    members: CommitteeMember[];
    maxRounds: number;
    initialFocus?: string;
  };
  mcpServers: {
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }[];
}

export interface RunRow {
  id: string;
  configId: number;
  status: "pending" | "trading" | "committee" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
  trigger: "cron" | "manual";
  prevRunId: string | null;
  traderSummary: string | null;
  advice: string | null;
  error: string | null;
}

export interface RunEvent {
  seq: number;
  runId: string;
  agentId: string;
  agentRole: "orchestrator" | "trader" | "chairman" | "member";
  round?: number;
  ts: string;
  kind: string;
  payload: any;
}

export interface ProviderInfo {
  provider: string;
  envKeys: string[];
  hasKey: boolean;
  models: { id: string; name?: string }[];
}

async function http<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as any;
  return (await res.json()) as T;
}

export const api = {
  getConfig: () => http<{ config: AppConfig | null }>("GET", "/api/config"),
  putConfig: (cfg: Omit<AppConfig, "id">) =>
    http<{ config: AppConfig }>("PUT", "/api/config", cfg),
  listRuns: (opts: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.before) params.set("before", opts.before);
    const qs = params.toString();
    return http<{ items: RunRow[] }>("GET", `/api/runs${qs ? `?${qs}` : ""}`);
  },
  getRun: (id: string) => http<{ run: RunRow }>("GET", `/api/runs/${id}`),
  listRunEvents: (id: string, afterSeq = 0) =>
    http<{ events: RunEvent[] }>("GET", `/api/runs/${id}/events?afterSeq=${afterSeq}`),
  trigger: () => http<{ runId: string; status: "started" | "skipped"; reason?: string }>("POST", "/api/runs/trigger"),
  listProviders: () => http<{ providers: ProviderInfo[] }>("GET", "/api/models"),
  listMcpTools: () =>
    http<{
      servers: { server: string; transport: string; tools: { rawName: string; safeName: string; description?: string }[] }[];
    }>("GET", "/api/mcp/tools"),
};
