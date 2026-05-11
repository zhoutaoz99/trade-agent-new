import type { FastifyInstance } from "fastify";
import { getRun, listRunEvents, listRuns } from "../../db/repo.js";
import { triggerRun } from "../../orchestrator/runner.js";

export async function registerRunsRoutes(app: FastifyInstance) {
  app.get("/api/runs", async (req) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const items = await listRuns({ limit, before: q.before });
    return { items };
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getRun(id);
    if (!run) {
      reply.code(404);
      return { error: "not_found" };
    }
    return { run };
  });

  app.get("/api/runs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getRun(id);
    if (!run) {
      reply.code(404);
      return { error: "not_found" };
    }
    const after = parseInt((req.query as any).afterSeq ?? "0", 10) || 0;
    const events = await listRunEvents(id, after);
    return { events };
  });

  app.post("/api/runs/trigger", async () => {
    const r = await triggerRun("manual");
    return r;
  });
}
