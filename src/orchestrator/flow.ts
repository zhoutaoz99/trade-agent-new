// USER-EDITABLE: this file controls the interaction flow between the trader and the
// advisory committee. Restart the server after editing.

import type { FlowContext, FlowResult } from "./flow-types.js";

export async function runFlow(ctx: FlowContext): Promise<FlowResult> {
  const { runId, helpers, config, previousAdvices, bus, log } = ctx;

  // 1. Trader phase ---------------------------------------------------------
  bus.emit({
    runId,
    agentId: "orchestrator",
    agentRole: "orchestrator",
    kind: "trader_phase_start",
    payload: { previousAdvicesCount: previousAdvices.length },
  });

  const trader = helpers.makeTraderAgent({
    runId,
    config: config.trader,
    previousAdvices,
    mcpTools: helpers.getMcpTools(),
  });

  const traderPrompt =
    "Proceed with this round's trading decision. Use the available tools to fetch market data, " +
    "evaluate positions, and place orders if warranted. Finish with a concise summary paragraph " +
    "of what you observed, what you decided, and which orders (if any) were submitted.";

  const traderSummary = await helpers.promptAndCollect(trader, traderPrompt);
  log("trader phase complete", { length: traderSummary.length });

  // 2. Committee phase ------------------------------------------------------
  bus.emit({
    runId,
    agentId: "orchestrator",
    agentRole: "orchestrator",
    kind: "committee_phase_start",
    payload: { memberCount: config.committee.members.length, maxRounds: config.committee.maxRounds },
  });

  const result = await helpers.runCommittee({ traderOutput: traderSummary, cfg: config.committee });

  bus.emit({
    runId,
    agentId: "orchestrator",
    agentRole: "orchestrator",
    kind: "advice_final",
    payload: { advice: result.advice, rationale: result.rationale, rounds: result.rounds },
  });

  return { traderSummary, advice: result.advice };
}
