import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAndActivateConfig, getActiveConfig, listConfigHistory } from "../../db/repo.js";
import { mcpManager } from "../../mcp/manager.js";
import { reconcileSchedule } from "../../cron/scheduler.js";

const modelRef = z.object({ provider: z.string().min(1), model: z.string().min(1) });
const memberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  model: modelRef,
  systemPrompt: z.string().default(""),
});
const mcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});
const configBody = z.object({
  cronExpr: z.string().min(1),
  trader: z.object({
    model: modelRef,
    systemPrompt: z.string().default(""),
    maxToolCalls: z.number().int().positive().optional(),
  }),
  committee: z.object({
    chairman: memberSchema,
    members: z.array(memberSchema).default([]),
    maxRounds: z.number().int().positive().max(10).default(3),
    initialFocus: z.string().optional(),
  }),
  mcpServers: z.array(mcpServerSchema).default([]),
});

export async function registerConfigRoutes(app: FastifyInstance) {
  app.get("/api/config", async () => {
    const cfg = await getActiveConfig();
    return { config: cfg };
  });

  app.get("/api/config/history", async () => {
    const items = await listConfigHistory(50);
    return { items };
  });

  app.put("/api/config", async (req, reply) => {
    const parsed = configBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_config", details: parsed.error.flatten() };
    }
    const cfg = await createAndActivateConfig(parsed.data);
    // Re-connect MCP + reconcile cron in the background — UI need not wait.
    void mcpManager.connectAll(cfg.mcpServers).catch((err) => {
      console.error("[config] MCP reconnect failed:", err);
    });
    void reconcileSchedule().catch((err) => {
      console.error("[config] cron reconcile failed:", err);
    });
    return { config: cfg };
  });
}
