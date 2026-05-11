import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventBus } from "../bus/event-bus.js";
import type { AppConfig, CommitteeConfig } from "../types.js";
import type { runCommittee } from "./committee.js";
import type { makeAgent, makeTraderAgent, promptAndCollect } from "./helpers.js";

export interface FlowHelpers {
  makeAgent: typeof makeAgent;
  makeTraderAgent: typeof makeTraderAgent;
  runCommittee: (args: { traderOutput: string; cfg: CommitteeConfig }) => ReturnType<typeof runCommittee>;
  promptAndCollect: typeof promptAndCollect;
  getMcpTools: () => AgentTool<any>[];
}

export interface FlowContext {
  runId: string;
  config: AppConfig;
  previousAdvices: string[];
  helpers: FlowHelpers;
  bus: EventBus;
  log: (msg: string, payload?: unknown) => void;
}

export interface FlowResult {
  traderSummary: string;
  advice: string;
}
