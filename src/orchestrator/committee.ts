import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { bus } from "../bus/event-bus.js";
import type { CommitteeConfig } from "../types.js";
import { collectLastAssistantText, makeChairmanAgent, makeMemberAgent, promptAndCollect } from "./helpers.js";

export interface RoundTurn {
  memberId: string;
  memberName: string;
  text: string;
}

export interface CommitteeRound {
  round: number;
  turns: RoundTurn[];
}

export type ChairmanDecision =
  | { kind: "conclude"; advice: string; rationale: string }
  | { kind: "continue"; focusQuestions: string[]; rationale?: string };

interface DecisionSlot {
  current: ChairmanDecision | null;
}

function buildChairmanTools(slot: DecisionSlot): AgentTool<any>[] {
  const conclude: AgentTool<any> = {
    name: "conclude",
    label: "Conclude debate",
    description:
      "Finalize the committee's advice. Call exactly once when consensus or clear direction is reached. The agent will stop after this call.",
    parameters: Type.Object({
      advice: Type.String({
        description: "Concise, concrete guidance for the next trader run (Chinese or English).",
      }),
      rationale: Type.String({ description: "One-paragraph rationale grounding the advice in the discussion." }),
    }) as any,
    execute: async (_id, raw) => {
      const params = raw as { advice: string; rationale: string };
      slot.current = { kind: "conclude", advice: params.advice, rationale: params.rationale };
      return {
        content: [{ type: "text", text: `Concluded.\nAdvice: ${params.advice}` }],
        details: { ...params, decision: "conclude" as const },
        terminate: true,
      };
    },
  };

  const cont: AgentTool<any> = {
    name: "continue_debate",
    label: "Request another round",
    description:
      "Request another round of debate when key questions remain. Provide specific focus questions for members. The agent will stop after this call.",
    parameters: Type.Object({
      focusQuestions: Type.Array(Type.String(), {
        description: "1-4 specific questions or points of contention for the next round.",
      }),
      rationale: Type.Optional(
        Type.String({ description: "Why another round is needed." }),
      ),
    }) as any,
    execute: async (_id, raw) => {
      const params = raw as { focusQuestions: string[]; rationale?: string };
      slot.current = {
        kind: "continue",
        focusQuestions: params.focusQuestions,
        rationale: params.rationale,
      };
      return {
        content: [
          {
            type: "text",
            text: `Continuing. Next focus: ${params.focusQuestions.join("; ")}`,
          },
        ],
        details: { ...params, decision: "continue" as const },
        terminate: true,
      };
    },
  };

  return [conclude, cont];
}

function renderTranscriptForMember(
  transcript: CommitteeRound[],
  selfMemberId: string,
  round: number,
): string {
  if (transcript.length === 0) return "";
  const lines: string[] = [];
  for (const r of transcript) {
    lines.push(`### Round ${r.round}`);
    for (const t of r.turns) {
      const tag = t.memberId === selfMemberId ? "(you)" : "";
      lines.push(`- ${t.memberName} ${tag}: ${t.text}`);
    }
  }
  return lines.join("\n");
}

function renderMemberPrompt(opts: {
  traderOutput: string;
  transcript: CommitteeRound[];
  selfMemberId: string;
  round: number;
  focus: string;
  totalRounds: number;
}): string {
  const head = `You are participating in an advisory committee reviewing a recent automated crypto trade. Round ${opts.round} of up to ${opts.totalRounds}.`;
  const trade = `## Trader's output\n${opts.traderOutput}`;
  const focus = `## Focus for this round\n${opts.focus}`;
  const past = opts.transcript.length
    ? `## Discussion so far\n${renderTranscriptForMember(opts.transcript, opts.selfMemberId, opts.round)}`
    : "";
  const ask =
    opts.round === 1
      ? "Provide your independent analysis: risks, opportunities, and concrete suggestions. Be specific and concise."
      : "Update or defend your view based on the discussion. Address other members where you disagree. Stay concise.";
  return [head, trade, focus, past, `## Your task\n${ask}`].filter(Boolean).join("\n\n");
}

function renderChairmanPrompt(opts: {
  traderOutput: string;
  transcript: CommitteeRound[];
  round: number;
  totalRounds: number;
}): string {
  const past = opts.transcript
    .map((r) => `### Round ${r.round}\n${r.turns.map((t) => `- ${t.memberName}: ${t.text}`).join("\n")}`)
    .join("\n\n");
  return [
    `You chair an advisory committee reviewing a recent automated crypto trade.`,
    `## Trader's output\n${opts.traderOutput}`,
    `## Discussion so far\n${past}`,
    `## Your task\nDecide whether the committee has enough alignment to conclude.\n` +
      `- If yes, call the **conclude** tool with concrete, actionable advice for the next trader run.\n` +
      `- If important questions remain, call **continue_debate** with 1-4 specific focus questions.\n` +
      `Round ${opts.round} of ${opts.totalRounds}. ` +
      (opts.round >= opts.totalRounds ? `This is the FINAL round — you MUST conclude.` : ""),
  ].join("\n\n");
}

export async function runCommittee(args: {
  runId: string;
  traderOutput: string;
  cfg: CommitteeConfig;
}): Promise<{ advice: string; rationale: string; transcript: CommitteeRound[]; rounds: number }> {
  const { runId, traderOutput, cfg } = args;
  const totalRounds = Math.max(1, Math.min(cfg.maxRounds ?? 3, 10));

  const members = cfg.members.map((m) => ({
    cfg: m,
    agent: makeMemberAgent(runId, m),
  }));

  const slot: DecisionSlot = { current: null };
  const chairman = makeChairmanAgent(runId, cfg.chairman, buildChairmanTools(slot));

  const transcript: CommitteeRound[] = [];
  let focus = cfg.initialFocus ?? "Review the trade and identify risks/opportunities.";

  for (let round = 1; round <= totalRounds; round++) {
    bus.emit({
      runId,
      agentId: "orchestrator",
      agentRole: "orchestrator",
      round,
      kind: "round_start",
      payload: { round, totalRounds, focus },
    });

    const turns = await Promise.all(
      members.map(async ({ cfg: m, agent }) => {
        const prompt = renderMemberPrompt({
          traderOutput,
          transcript,
          selfMemberId: m.id,
          round,
          focus,
          totalRounds,
        });
        const text = await promptAndCollect(agent, prompt);
        return { memberId: m.id, memberName: m.name, text };
      }),
    );
    transcript.push({ round, turns });

    // Chairman decision
    slot.current = null;
    const chairmanPrompt = renderChairmanPrompt({
      traderOutput,
      transcript,
      round,
      totalRounds,
    });
    await chairman.prompt(chairmanPrompt);
    await chairman.waitForIdle();
    const decision = slot.current as ChairmanDecision | null;

    bus.emit({
      runId,
      agentId: "orchestrator",
      agentRole: "orchestrator",
      round,
      kind: "round_end",
      payload: { round, decision: decision?.kind ?? "missing" },
    });

    if (!decision) {
      // Fallback: chairman replied with text only. Treat last assistant text as advice and stop.
      const fallback = collectLastAssistantText(chairman) || "(no advice produced)";
      return {
        advice: fallback,
        rationale: "Chairman did not call the conclude tool; using assistant text as advice.",
        transcript,
        rounds: round,
      };
    }

    if (decision.kind === "conclude") {
      return {
        advice: decision.advice,
        rationale: decision.rationale,
        transcript,
        rounds: round,
      };
    }
    focus = decision.focusQuestions.join("; ");
  }

  // Should be unreachable: chairman is told final round must conclude.
  const fallback = collectLastAssistantText(chairman) || "(no advice produced)";
  return {
    advice: fallback,
    rationale: "Max rounds reached without conclude tool call.",
    transcript,
    rounds: totalRounds,
  };
}
