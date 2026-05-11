import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";

const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

function makeSafeName(raw: string): string {
  if (SAFE.test(raw)) return raw;
  const replaced = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return replaced.slice(0, 64) || `tool_${Math.random().toString(36).slice(2, 8)}`;
}

function mapContent(items: any[] | undefined): any[] {
  if (!Array.isArray(items)) return [{ type: "text", text: "" }];
  const out: any[] = [];
  for (const c of items) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") {
      out.push({ type: "text", text: c.text });
    } else if (c.type === "image" && typeof c.data === "string") {
      out.push({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" });
    } else if (c.type === "resource_link") {
      out.push({ type: "text", text: `[resource_link: ${c.uri ?? "unknown"}]` });
    } else if (c.type === "resource") {
      const meta = c.resource ?? {};
      out.push({
        type: "text",
        text: `[resource ${meta.uri ?? ""}${meta.mimeType ? ` (${meta.mimeType})` : ""}]`,
      });
    } else {
      out.push({ type: "text", text: `[mcp content type=${c.type}]` });
    }
  }
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

export interface McpToolMeta {
  serverName: string;
  rawName: string;
  safeName: string;
}

export function mcpToolToAgentTool(
  client: McpClient,
  serverName: string,
  tool: { name: string; description?: string; inputSchema: any },
): { agentTool: AgentTool<any>; meta: McpToolMeta } {
  const raw = `${serverName}__${tool.name}`;
  const safeName = makeSafeName(raw);
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : { type: "object", properties: {} };

  const agentTool: AgentTool<any> = {
    name: safeName,
    label: `${serverName} · ${tool.name}`,
    description: tool.description ?? `${serverName} tool ${tool.name}`,
    // pi accepts a TSchema; raw JSON Schema works at runtime — escape compile-time typing.
    parameters: Type.Unsafe<any>(schema as any),
    execute: async (_toolCallId, params, signal) => {
      const args =
        typeof params === "string" ? safeParseJson(params) : (params ?? {});
      const res = await client.callTool(
        { name: tool.name, arguments: args as Record<string, unknown> },
        undefined,
        { signal },
      );
      const content = mapContent((res as any).content);
      const isError = !!(res as any).isError;
      return {
        content: content as any,
        details: {
          server: serverName,
          rawTool: tool.name,
          isError,
          structuredContent: (res as any).structuredContent,
        },
        // do not auto-terminate on MCP error — let the agent decide
      };
    },
  };

  return { agentTool, meta: { serverName, rawName: tool.name, safeName } };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
