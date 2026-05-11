import { bus } from "../bus/event-bus.js";
import { flushDbWrites } from "../bus/db-writer.js";
import {
  createRun,
  getActiveConfig,
  getLatestAdvices,
  getLatestSuccessfulRunId,
  hasActiveRun,
  updateRunStatus,
} from "../db/repo.js";
import { mcpManager } from "../mcp/manager.js";
import type { RunTrigger } from "../types.js";
import { runCommittee } from "./committee.js";
import { runFlow } from "./flow.js";
import type { FlowContext } from "./flow-types.js";
import { makeAgent, makeTraderAgent, promptAndCollect } from "./helpers.js";

export interface TriggerResult {
  runId: string;
  status: "started" | "skipped";
  reason?: string;
}

export async function triggerRun(trigger: RunTrigger): Promise<TriggerResult> {
  if (await hasActiveRun()) {
    return { runId: "", status: "skipped", reason: "another run is in progress" };
  }
  const cfg = await getActiveConfig();
  if (!cfg) {
    return { runId: "", status: "skipped", reason: "no active config" };
  }
  const prevRunId = await getLatestSuccessfulRunId();
  const run = await createRun({ configId: cfg.id!, trigger, prevRunId });

  bus.emit({
    runId: run.id,
    agentId: "orchestrator",
    agentRole: "orchestrator",
    kind: "run_start",
    payload: { trigger, configId: cfg.id, prevRunId },
  });

  // Execute asynchronously; caller returns immediately with run id.
  void executeRun(run.id);
  return { runId: run.id, status: "started" };
}

async function executeRun(runId: string): Promise<void> {
  try {
    const cfg = await getActiveConfig();
    if (!cfg) throw new Error("active config disappeared mid-run");
    const previousAdvices = await getLatestAdvices(3);

    await updateRunStatus(runId, "trading");

    const ctx: FlowContext = {
      runId,
      config: cfg,
      previousAdvices,
      helpers: {
        makeAgent,
        makeTraderAgent,
        runCommittee: ({ traderOutput, cfg: commCfg }) =>
          runCommittee({ runId, traderOutput, cfg: commCfg, customProviders: cfg.customProviders }),
        promptAndCollect,
        getMcpTools: () => mcpManager.getAllTools(),
      },
      bus,
      log: (msg, payload) =>
        bus.emit({
          runId,
          agentId: "orchestrator",
          agentRole: "orchestrator",
          kind: "log",
          payload: { msg, payload },
        }),
    };

    // Marker: switch to committee phase status as soon as the trader output is ready.
    // We can't easily intercept inside flow.ts, so we keep status = 'trading' for the
    // whole flow execution; the events tell the precise sub-phase.
    const result = await runFlow(ctx);

    await updateRunStatus(runId, "done", {
      traderSummary: result.traderSummary,
      advice: result.advice,
      ended: true,
    });

    bus.emit({
      runId,
      agentId: "orchestrator",
      agentRole: "orchestrator",
      kind: "run_end",
      payload: { status: "done" },
    });
  } catch (err: any) {
    const message = err?.stack ?? err?.message ?? String(err);
    console.error(`[run ${runId}] failed:`, message);
    await updateRunStatus(runId, "failed", { error: message, ended: true });
    bus.emit({
      runId,
      agentId: "orchestrator",
      agentRole: "orchestrator",
      kind: "run_failed",
      payload: { error: message },
    });
  } finally {
    await flushDbWrites(runId).catch(() => {});
  }
}
