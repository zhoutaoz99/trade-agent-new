import { Agent, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getApiKey, resolveModel } from "../ai/models.js";
import { bindAgentToBus, type AgentBindContext } from "./agent-events.js";
import type { CommitteeMemberConfig, LlmProviderConfig, ModelRef, TraderConfig } from "../types.js";

/** Default identity conversion: filter to real LLM messages. */
export function defaultConvertToLlm(messages: any[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m && typeof m === "object" && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
  );
}

export interface MakeAgentOptions extends AgentBindContext {
  systemPrompt: string;
  model: ModelRef;
  customProviders?: LlmProviderConfig[];
  tools?: AgentTool<any>[];
  sessionId?: string;
  extraOptions?: Partial<AgentOptions>;
}

export function makeAgent(opts: MakeAgentOptions): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: resolveModel(opts.model, opts.customProviders),
      tools: opts.tools ?? [],
      messages: [],
      thinkingLevel: "off",
    },
    convertToLlm: defaultConvertToLlm,
    getApiKey: (provider) => getApiKey(provider, opts.customProviders),
    sessionId: opts.sessionId,
    ...opts.extraOptions,
  });
  bindAgentToBus(agent, {
    runId: opts.runId,
    agentId: opts.agentId,
    agentRole: opts.agentRole,
    round: opts.round,
  });
  return agent;
}

/** Run agent.prompt and return final assistant text. */
export async function promptAndCollect(agent: Agent, prompt: string): Promise<string> {
  await agent.prompt(prompt);
  await agent.waitForIdle();
  return collectLastAssistantText(agent);
}

export function collectLastAssistantText(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i];
    if (m && m.role === "assistant" && Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const block of m.content) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
      if (parts.length) return parts.join("\n").trim();
    }
  }
  return "";
}

export function composeTraderSystemPrompt(base: string, prevAdvices: string[]): string {
  if (prevAdvices.length === 0) return base;
  const list = prevAdvices.map((a, i) => `- (${i === 0 ? "most recent" : `t-${i}`}) ${a}`).join("\n");
  return `${base}\n\n## Guidance from prior committee runs (most recent first)\n${list}`;
}

export interface MakeTraderOptions {
  runId: string;
  config: TraderConfig;
  customProviders?: LlmProviderConfig[];
  previousAdvices: string[];
  mcpTools: AgentTool<any>[];
}

export function makeTraderAgent(opts: MakeTraderOptions): Agent {
  const systemPrompt = composeTraderSystemPrompt(opts.config.systemPrompt, opts.previousAdvices);
  return makeAgent({
    runId: opts.runId,
    agentId: "trader",
    agentRole: "trader",
    systemPrompt,
    model: opts.config.model,
    customProviders: opts.customProviders,
    tools: opts.mcpTools,
    sessionId: `${opts.runId}:trader`,
  });
}

export function makeMemberAgent(
  runId: string,
  member: CommitteeMemberConfig,
  customProviders?: LlmProviderConfig[],
): Agent {
  return makeAgent({
    runId,
    agentId: `member:${member.id}`,
    agentRole: "member",
    systemPrompt: member.systemPrompt,
    model: member.model,
    customProviders,
    sessionId: `${runId}:member:${member.id}`,
  });
}

export function makeChairmanAgent(
  runId: string,
  chairman: CommitteeMemberConfig,
  tools: AgentTool<any>[],
  customProviders?: LlmProviderConfig[],
): Agent {
  return makeAgent({
    runId,
    agentId: "chairman",
    agentRole: "chairman",
    systemPrompt: chairman.systemPrompt,
    model: chairman.model,
    customProviders,
    tools,
    sessionId: `${runId}:chairman`,
  });
}
