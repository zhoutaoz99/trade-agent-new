import type { Agent } from "@earendil-works/pi-agent-core";
import { bus } from "../bus/event-bus.js";
import type { AgentRole } from "../types.js";

export interface AgentBindContext {
  runId: string;
  agentId: string;
  agentRole: AgentRole;
  round?: number;
}

export function bindAgentToBus(agent: Agent, ctx: AgentBindContext): () => void {
  return agent.subscribe((event) => {
    bus.emit({
      runId: ctx.runId,
      agentId: ctx.agentId,
      agentRole: ctx.agentRole,
      round: ctx.round,
      kind: event.type,
      payload: event,
    });
  });
}
