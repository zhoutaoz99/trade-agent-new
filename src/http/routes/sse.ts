import type { FastifyInstance } from "fastify";
import { listRunEvents } from "../../db/repo.js";
import { attachClient, writeReplay } from "../../bus/sse-hub.js";

export async function registerSseRoutes(app: FastifyInstance) {
  app.get("/api/runs/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const lastEventId = parseInt(
      (req.headers["last-event-id"] as string | undefined) ?? "0",
      10,
    ) || 0;

    // Hijack: we will write the SSE response manually.
    reply.hijack();
    const res = reply.raw;
    const cleanup = attachClient(res, (e) => e.runId === id);

    try {
      const replay = await listRunEvents(id, lastEventId);
      writeReplay(res, replay);
    } catch (err) {
      console.error("[sse] replay failed:", err);
    }

    req.raw.on("close", cleanup);
  });

  // Sparse global stream of run lifecycle events (run_start / run_end / run_failed).
  app.get("/api/runs/stream", async (_req, reply) => {
    reply.hijack();
    const res = reply.raw;
    attachClient(res, (e) =>
      e.agentRole === "orchestrator" &&
      (e.kind === "run_start" || e.kind === "run_end" || e.kind === "run_failed"),
    );
  });
}
