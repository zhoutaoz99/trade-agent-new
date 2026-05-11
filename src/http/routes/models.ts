import type { FastifyInstance } from "fastify";
import { listProviderInfo } from "../../ai/models.js";

export async function registerModelsRoutes(app: FastifyInstance) {
  app.get("/api/models", async () => {
    return { providers: listProviderInfo() };
  });
}
