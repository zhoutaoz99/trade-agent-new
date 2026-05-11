import type { FastifyInstance } from "fastify";
import { listProviderInfo } from "../../ai/models.js";
import { getActiveConfig } from "../../db/repo.js";

export async function registerModelsRoutes(app: FastifyInstance) {
  app.get("/api/models", async () => {
    const cfg = await getActiveConfig();
    return { providers: listProviderInfo(cfg?.customProviders ?? []) };
  });
}
