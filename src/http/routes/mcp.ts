import type { FastifyInstance } from "fastify";
import { mcpManager } from "../../mcp/manager.js";

export async function registerMcpRoutes(app: FastifyInstance) {
  app.get("/api/mcp/tools", async () => {
    return { servers: mcpManager.introspect() };
  });
}
