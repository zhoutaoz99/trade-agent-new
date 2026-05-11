import { Cron } from "croner";
import { getActiveConfig } from "../db/repo.js";
import { triggerRun } from "../orchestrator/runner.js";

let job: Cron | null = null;
let currentCronExpr: string | null = null;

export async function reconcileSchedule(): Promise<void> {
  const cfg = await getActiveConfig();
  if (!cfg) {
    if (job) {
      job.stop();
      job = null;
      currentCronExpr = null;
    }
    return;
  }
  if (cfg.cronExpr === currentCronExpr && job) return;

  job?.stop();
  try {
    job = new Cron(cfg.cronExpr, { protect: true }, async () => {
      try {
        const result = await triggerRun("cron");
        if (result.status === "skipped") {
          console.log(`[cron] skipped: ${result.reason}`);
        } else {
          console.log(`[cron] started run ${result.runId}`);
        }
      } catch (err) {
        console.error("[cron] tick error:", err);
      }
    });
    currentCronExpr = cfg.cronExpr;
    const next = job.nextRun();
    console.log(`[cron] scheduled "${cfg.cronExpr}", next at ${next?.toISOString() ?? "?"}`);
  } catch (err) {
    console.error(`[cron] invalid expression "${cfg.cronExpr}":`, err);
    job = null;
    currentCronExpr = null;
  }
}

export function stopScheduler() {
  job?.stop();
  job = null;
  currentCronExpr = null;
}
