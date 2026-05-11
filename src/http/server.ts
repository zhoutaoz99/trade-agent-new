import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { registerSseRoutes } from "./routes/sse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });

  await registerConfigRoutes(app);
  await registerRunsRoutes(app);
  await registerSseRoutes(app);
  await registerMcpRoutes(app);
  await registerModelsRoutes(app);

  app.get("/api/health", async () => ({ ok: true }));

  // Serve built web UI when present.
  const webDist = resolve(__dirname, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: "0.0.0.0", port: env.port });
  console.log(`[http] listening on http://localhost:${env.port}`);
  return app;
}
