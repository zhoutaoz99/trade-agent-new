import "./config.js";
import { startDbWriter } from "./bus/db-writer.js";
import { startSseHub } from "./bus/sse-hub.js";
import { reconcileSchedule, stopScheduler } from "./cron/scheduler.js";
import { runMigrations } from "./db/migrate.js";
import { ensureSeedConfig, getActiveConfig, markOrphanedRunsFailed } from "./db/repo.js";
import { startServer } from "./http/server.js";
import { mcpManager } from "./mcp/manager.js";

const SEED_CONFIG = {
  cronExpr: "*/30 * * * *",
  customProviders: [
    { provider: "poe", models: [], baseUrl: "https://api.poe.com/v1" },
    { provider: "deepseek", models: ["deepseek-chat"], baseUrl: "https://api.deepseek.com" },
  ],
  trader: {
    model: { provider: "deepseek", model: "deepseek-chat" },
    systemPrompt:
      "You are an autonomous crypto trading agent. Use the available trading tools to inspect markets " +
      "and execute trades when justified. Be cautious, document your reasoning, and finish with a clear summary.",
  },
  committee: {
    chairman: {
      id: "chairman",
      name: "Chairman",
      model: { provider: "deepseek", model: "deepseek-chat" },
      systemPrompt:
        "You chair an advisory committee of investment specialists. After each round you must call exactly " +
        "one tool: `conclude` (with concrete advice) or `continue_debate` (with focus questions). Be decisive.",
    },
    members: [
      {
        id: "bull",
        name: "Bull",
        model: { provider: "deepseek", model: "deepseek-chat" },
        systemPrompt:
          "You are a bullish growth-oriented analyst. Identify upside opportunities and constructive risk-taking.",
      },
      {
        id: "bear",
        name: "Bear",
        model: { provider: "deepseek", model: "deepseek-chat" },
        systemPrompt:
          "You are a bearish risk-aware analyst. Identify downside risks, fragilities, and capital preservation moves.",
      },
    ],
    maxRounds: 3,
    initialFocus: "Evaluate whether the trader's decision aligns with risk-adjusted return objectives.",
  },
  mcpServers: [] as { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }[],
};

async function main() {
  console.log("[boot] running migrations…");
  await runMigrations();

  console.log("[boot] ensuring seed config…");
  await ensureSeedConfig(SEED_CONFIG);

  console.log("[boot] marking orphaned runs as failed…");
  const orphaned = await markOrphanedRunsFailed();
  if (orphaned > 0) console.log(`[boot] marked ${orphaned} orphaned run(s) failed`);

  startDbWriter();
  startSseHub();

  const cfg = await getActiveConfig();
  if (cfg) {
    console.log("[boot] connecting MCP servers…");
    await mcpManager.connectAll(cfg.mcpServers);
  }

  console.log("[boot] starting scheduler…");
  await reconcileSchedule();

  console.log("[boot] starting HTTP server…");
  await startServer();
}

async function shutdown(reason: string) {
  console.log(`[shutdown] ${reason}`);
  stopScheduler();
  await mcpManager.disconnectAll().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
