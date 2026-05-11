import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../types.js";
import { mcpToolToAgentTool, type McpToolMeta } from "./tool-adapter.js";

interface ConnectedServer {
  config: McpServerConfig;
  client: McpClient;
  tools: AgentTool<any>[];
  toolMeta: McpToolMeta[];
}

class McpManager {
  private servers = new Map<string, ConnectedServer>();

  async connectAll(configs: McpServerConfig[] | null | undefined): Promise<void> {
    await this.disconnectAll();
    const list = Array.isArray(configs) ? configs : [];
    for (const cfg of list) {
      try {
        await this.connectOne(cfg);
      } catch (err) {
        console.error(`[mcp] failed to connect server ${cfg.name}:`, err);
      }
    }
  }

  private async connectOne(cfg: McpServerConfig): Promise<void> {
    const client = new McpClient({ name: "trade-agent", version: "0.1.0" });

    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error(`stdio MCP "${cfg.name}" missing command`);
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...process.env as Record<string, string>, ...(cfg.env ?? {}) },
      });
      await client.connect(transport);
    } else if (cfg.transport === "http") {
      if (!cfg.url) throw new Error(`http MCP "${cfg.name}" missing url`);
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: cfg.headers ?? {} },
      });
      await client.connect(transport);
    } else {
      throw new Error(`Unknown MCP transport "${(cfg as any).transport}"`);
    }

    const list = await client.listTools();
    const tools: AgentTool<any>[] = [];
    const toolMeta: McpToolMeta[] = [];
    for (const t of list.tools) {
      const { agentTool, meta } = mcpToolToAgentTool(client, cfg.name, t as any);
      tools.push(agentTool);
      toolMeta.push(meta);
    }
    this.servers.set(cfg.name, { config: cfg, client, tools, toolMeta });
    console.log(`[mcp] connected ${cfg.name} (${cfg.transport}), tools=${tools.length}`);
  }

  getAllTools(): AgentTool<any>[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  introspect(): { server: string; transport: string; tools: { rawName: string; safeName: string; description?: string }[] }[] {
    return [...this.servers.values()].map((s) => ({
      server: s.config.name,
      transport: s.config.transport,
      tools: s.toolMeta.map((m) => ({
        rawName: m.rawName,
        safeName: m.safeName,
        description: s.tools.find((t) => t.name === m.safeName)?.description,
      })),
    }));
  }

  async disconnectAll(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client.close();
      } catch (err) {
        console.error(`[mcp] error closing ${s.config.name}:`, err);
      }
    }
    this.servers.clear();
  }
}

export const mcpManager = new McpManager();
