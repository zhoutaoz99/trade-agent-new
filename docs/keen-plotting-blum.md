# 多Agent虚拟货币交易系统 — MVP实现方案

## Context

用户要求从零搭建一个虚拟货币交易多智能体系统：

- **交易主智能体（trader）**：定时触发，通过外部 MCP 服务器调用交易接口；
- **智囊团（committee）**：由 1 名主席 + N 名成员组成，每位成员可选不同厂商的 LLM；多轮自由讨论直到主席决定终止并给出最终建议；
- **反馈闭环**：智囊团建议成为下一轮交易决策的指导上下文；
- **Web UI**：展示运行历史、当前进度、所有 Agent 的思考/交流过程；并支持通过 UI 配置定时计划、各 Agent 模型与 prompt、MCP 服务器；
- **可定制流程**：交互编排作为 TypeScript 文件由用户直接编辑；
- **MVP**：先跑通最小可运行版本，容错/安全/认证等后续迭代。

底层框架使用 `@earendil-works/pi`（pi-agent-core 提供 Agent/Tool 抽象、pi-ai 提供统一多厂商 LLM 接口）。pi 本身不内建 MCP 与多 Agent 编排，我们在其上自行实现轻量编排层。

---

## 技术选型

| 层 | 选型 |
|---|---|
| 语言/运行时 | Node.js 20+，TypeScript，`"type": "module"`，`tsx` 直跑 |
| Agent 核心 | `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` |
| MCP | `@modelcontextprotocol/sdk` 作为 client 接入外部 MCP server（stdio + http 两种 transport） |
| HTTP/SSE | `fastify` + `@fastify/cors`（SSE 用原生 reply.raw） |
| 数据库 | PostgreSQL（`pg` 驱动），单实例足够；建库脚本走 SQL 文件 |
| 定时 | `croner`（轻量、TS 友好、支持秒级与时区） |
| 前端 | Vite + React + TypeScript；EventSource 接 SSE；`cronstrue` 人话化 cron |
| 校验 | `zod`（REST 入参与 config schema） |

---

## 目录结构

```
/Users/zhou/agent/trade-agent-new/
  package.json                 # type: module
  tsconfig.json
  .env.example                 # 各厂商 API key + DATABASE_URL
  README.md                    # 启动说明
  src/
    index.ts                   # 入口：连DB → 起bus → 起MCP → 起scheduler → 起fastify
    config.ts                  # 环境变量加载与校验
    db/
      pool.ts                  # pg Pool 单例
      migrate.ts               # 启动时执行 migrations/*.sql
      migrations/001_init.sql
      repo.ts                  # 类型化仓库函数
    bus/
      event-bus.ts             # EventEmitter + per-run seq 计数器
      db-writer.ts             # bus 订阅者 → run_events 表（按 run 串行）
      sse-hub.ts               # bus 订阅者 → 在线 SSE 客户端扇出
    ai/
      models.ts                # pi-ai getModel 的薄封装 + getApiKey 回调
    mcp/
      manager.ts               # 管理多个 MCP 连接的生命周期
      tool-adapter.ts          # mcpToolToAgentTool() + 服务器名前缀
    orchestrator/
      runner.ts                # 每次 cron tick：建 run → 调 flow.runFlow → 落 advice
      flow.ts                  # 用户可编辑的默认流程
      flow-types.ts            # FlowContext / Helpers 类型
      committee.ts             # runCommittee()，含 conclude/continue 工具
      helpers.ts               # promptAndCollect / composeTraderSystemPrompt 等
      agent-events.ts          # bindAgentToBus(agent, runId, agentId, role)
    http/
      server.ts                # fastify 实例 + 路由注册 + 静态资源
      routes/
        config.ts              # GET/PUT /api/config，GET /api/config/history
        runs.ts                # GET /api/runs，GET /api/runs/:id，POST /api/runs/trigger
        sse.ts                 # GET /api/runs/:id/stream，GET /api/runs/stream
        mcp.ts                 # GET /api/mcp/tools（列出已连接服务器的工具）
        models.ts              # GET /api/models（可选 provider 与可用环境变量）
    cron/
      scheduler.ts             # 监听 active config 变化、重建 cron 任务
  web/
    index.html
    vite.config.ts             # dev 代理 /api → :3000
    src/
      main.tsx
      App.tsx
      api.ts                   # fetch + EventSource 封装
      pages/
        RunsListPage.tsx
        RunDetailPage.tsx      # 多 agent 分栏 transcript + 实时 SSE
        ConfigPage.tsx         # cron / trader / committee / MCP 配置表单
      components/
        RunTranscript.tsx
        AgentColumn.tsx
        MessageBubble.tsx
        ToolCallDetails.tsx
        RoundDivider.tsx
        CommitteeEditor.tsx
        MemberCard.tsx
        ModelPicker.tsx
        CronInput.tsx
        RunStatusBadge.tsx
      hooks/
        useRunEvents.ts        # EventSource + Last-Event-ID 重连
        useRunList.ts
```

---

## 数据库 Schema（`src/db/migrations/001_init.sql`）

```sql
create extension if not exists pgcrypto;

-- 配置版本化：一行一个版本，唯一活跃版本由部分唯一索引保证
create table config (
  id           bigserial primary key,
  cron_expr    text not null,
  trader       jsonb not null,                -- {model:{provider,name}, systemPrompt, maxToolCalls}
  committee    jsonb not null,                -- {chairman:{...}, members:[...], maxRounds, initialFocus}
  mcp_servers  jsonb not null,                -- [{name, transport:"stdio"|"http", command|url, args?, env?}]
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index config_one_active on config(active) where active;

-- 每次 cron tick 产生一条 run
create table runs (
  id             uuid primary key default gen_random_uuid(),
  config_id      bigint not null references config(id),
  status         text not null check (status in ('pending','trading','committee','done','failed')),
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  trigger        text not null check (trigger in ('cron','manual')),
  prev_run_id    uuid references runs(id),
  trader_summary text,
  advice         text,
  error          text
);
create index runs_started_idx on runs(started_at desc);
create index runs_status_idx on runs(status);

-- run 内所有事件：SSE 与 transcript 的唯一数据源
create table run_events (
  run_id     uuid not null references runs(id) on delete cascade,
  seq        bigint not null,
  agent_id   text not null,
  agent_role text not null check (agent_role in ('orchestrator','trader','chairman','member')),
  round      int,
  kind       text not null,
  ts         timestamptz not null default now(),
  payload    jsonb not null,
  primary key (run_id, seq)
);
create index run_events_agent_idx on run_events(run_id, agent_id, seq);
```

设计要点：
- **`prev_run_id`** 显式串起前后两次 run，方便 trader 在新一次启动时通过 SQL 直接取前 N 次 advice 拼接到 systemPrompt。
- **`run_events` 复合主键 `(run_id, seq)`** 支撑 SSE 的 `Last-Event-ID` 续传。
- **JSONB 存 committee/trader/mcp_servers** 配置：层级结构 + UI 整块编辑表单，无需 join；改一次就建一条新 `config` 版本，旧 run 仍能溯源。

---

## 核心模块设计

### A) 智囊团多轮讨论 `src/orchestrator/committee.ts`

主席使用结构化工具 `conclude` / `continue_debate` 来表达决策，避免字符串解析。pi 的 `AgentTool` 返回 `terminate: true` 即可终止当轮 LLM 循环。

```ts
const concludeTool: AgentTool = {
  name: "conclude",
  description: "Finalize the committee's advice. Call only when consensus or clear direction is reached.",
  parameters: Type.Object({
    advice: Type.String({ description: "Concrete guidance for the next trader run" }),
    rationale: Type.String(),
  }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `Concluded: ${params.advice}` }],
    details: params,
    terminate: true,
  }),
};

const continueTool: AgentTool = {
  name: "continue_debate",
  description: "Request another round, with specific focus questions for members.",
  parameters: Type.Object({ focusQuestions: Type.Array(Type.String()) }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `Continuing: ${params.focusQuestions.join("; ")}` }],
    details: params,
  }),
};
```

讨论循环（要点，非完整代码）：

```ts
export async function runCommittee(args): Promise<string> {
  const members  = cfg.members.map(m => makeMemberAgent(m, bus, runId));
  const chairman = makeChairmanAgent(cfg.chairman, bus, runId, [concludeTool, continueTool]);
  const transcript: RoundTurn[] = [];
  let focus = cfg.initialFocus ?? "Review the trade and identify risks/opportunities.";

  for (let round = 1; round <= cfg.maxRounds; round++) {
    bus.emit({ runId, kind: "round_start", round });
    const memberResponses = await Promise.all(members.map(async ({ id, agent }) => ({
      memberId: id,
      text: await promptAndCollect(agent, renderMemberPrompt(traderOutput, transcript, focus, round)),
    })));
    transcript.push({ round, turns: memberResponses });

    const decision = await promptChairmanForDecision(chairman, renderChairmanPrompt(traderOutput, transcript, round, cfg.maxRounds));
    if (decision.kind === "conclude") return decision.advice;
    focus = decision.focusQuestions.join("; ");
  }
  return await forceConclusion(chairman, transcript);   // 达到 maxRounds 强制收口
}
```

关键决策：
- **每轮新 prompt，但 Agent 实例跨轮复用**：成员/主席的 pi `Agent` 在循环外一次性创建（保留 model + systemPrompt），每轮通过 `agent.prompt(roundPromptText)` 让其在自身 message history 上继续。其他成员的发言以 user-role 文本注入。
- **并发**：同轮多个成员可并行 `Promise.all`，互不干扰。
- **成本兜底**：`maxRounds` 默认 3；prompt 模板对第 2 轮以后仅注入"上一轮要点摘要 + 主席关注问题"，避免 transcript 二次方膨胀。

### B) MCP → pi AgentTool 适配 `src/mcp/tool-adapter.ts`

```ts
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function mcpToolToAgentTool(
  client: McpClient,
  serverName: string,
  tool: { name: string; description?: string; inputSchema: object },
): AgentTool {
  const raw = `${serverName}__${tool.name}`;
  const safeName = SAFE_NAME.test(raw) ? raw : raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return {
    name: safeName,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe<any>(tool.inputSchema ?? { type: "object", properties: {} }),
    execute: async (_id, params, signal) => {
      const args = typeof params === "string" ? JSON.parse(params) : (params ?? {});
      const res = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal });
      return {
        content: mapMcpContent(res.content),         // text 透传；image/resource 折叠成 text 摘要
        details: { isError: !!res.isError, structured: res.structuredContent },
      };
    },
  };
}
```

要点：
- MCP 的 `inputSchema` 是 JSON Schema；pi 的 `parameters` 运行期就是 JSON Schema 对象（TypeBox 生成的也是），用 `Type.Unsafe<any>(schema)` 包一层逃逸编译期类型即可，LLM 端拿到的 schema 一致。
- **服务器名前缀** `${serverName}__${toolName}` 防止多 MCP 间冲突；不合规字符替换为下划线。
- 防御性地处理 `params` 字符串化（pi 旧版有过该问题）。

### C) MCP 连接生命周期 `src/mcp/manager.ts`

- 启动时按 `config.mcp_servers` 建立全部连接；stdio 起子进程，http 起 streamable transport。
- 单例 `McpManager` 暴露 `getAllAgentTools(): AgentTool[]`、`getServerNames()`。
- 进程退出时关闭。MVP **不做自动重连**——若 MCP 掉线则当轮 run 失败、日志告警；后续迭代再加重连。

### D) Event Bus 与 SSE `src/bus/`

```ts
// event-bus.ts
class EventBus {
  private listeners = new Set<(e: RunEvent) => void>();
  private seqs = new Map<string, number>();   // runId → counter
  nextSeq(runId: string) { const n = (this.seqs.get(runId) ?? 0) + 1; this.seqs.set(runId, n); return n; }
  emit(partial: Omit<RunEvent, "seq"|"ts">) {
    const e = { ...partial, seq: this.nextSeq(partial.runId), ts: new Date().toISOString() };
    for (const fn of this.listeners) fn(e);
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
```

- **DB writer**：按 runId 串行落库的小队列（`Map<runId, Promise<void>>`，新写 `.then()` 链到队尾），保证 `seq` 顺序持久化。
- **SSE hub**：`Map<runId, Set<reply.raw>>`；每事件 `res.write(\`id: ${seq}\\ndata: ${JSON.stringify(e)}\\n\\n\`)`；15s 一个 `: heartbeat\n\n` 心跳；客户端 `Last-Event-ID` 时先从 DB 回放 `seq > lastId` 再挂入直播。

### E) Agent → Bus 绑定 `src/orchestrator/agent-events.ts`

```ts
export function bindAgentToBus(agent: Agent, ctx: { runId; agentId; agentRole; round? }) {
  agent.subscribe(async (event) => {
    bus.emit({
      runId: ctx.runId,
      agentId: ctx.agentId,
      agentRole: ctx.agentRole,
      round: ctx.round,
      kind: event.type,        // pi 原生事件类型（message_update / tool_execution_end 等）
      payload: event,
    });
  });
}
```

### F) 默认流程 `src/orchestrator/flow.ts`（用户可编辑入口）

```ts
export async function runFlow(ctx: FlowContext): Promise<FlowResult> {
  const { runId, helpers, config, previousAdvice, bus } = ctx;

  // 1. Trader 阶段
  bus.emit({ runId, kind: "trader_phase_start", agentId: "orchestrator", agentRole: "orchestrator" });
  const trader = await helpers.makeTraderAgent({
    systemPrompt: helpers.composeTraderSystemPrompt(config.trader.systemPrompt, previousAdvice),
    model: helpers.getModel(config.trader.model),
    tools: helpers.getMcpTools(),                     // 来自已连接 MCP
    agentId: "trader",
  });
  const traderOutput = await helpers.promptAndCollect(trader, "Proceed with this round's trading decision.");

  // 2. 智囊团阶段
  bus.emit({ runId, kind: "committee_phase_start", agentId: "orchestrator", agentRole: "orchestrator" });
  const advice = await helpers.runCommittee({ traderOutput, committee: config.committee });

  bus.emit({ runId, kind: "advice_final", agentId: "orchestrator", agentRole: "orchestrator", payload: { advice } });
  return { traderSummary: traderOutput, advice };
}
```

- 用户改流程 = 改这一个文件；`FlowContext.helpers` 提供稳定的扩展面（`makeTraderAgent` / `makeCommitteeAgent` / `runCommittee` / `getMcpTools` / `getModel` / `promptAndCollect` / `composeTraderSystemPrompt`）。
- **MVP 不做热加载**——改完重启服务。

### G) 反馈闭环

`runner.ts` 在新建 run 时查询前 N 次（默认 3）成功 run 的 `advice`，作为 `previousAdvice` 数组传入；`composeTraderSystemPrompt(base, list)` 在 trader 的 systemPrompt 末尾追加：

```
## Guidance from prior committee runs (most recent first)
- <advice N>
- <advice N-1>
- <advice N-2>
```

完全走 DB，服务重启不丢上下文。

### H) 调度 `src/cron/scheduler.ts`

- 读取 active `config.cron_expr`，用 `croner` 注册一个回调；config 更新时停旧任务、起新任务。
- **重叠保护**：tick 触发时若存在 `status in ('trading','committee')` 的 run，则跳过本次并落一条 `kind: "tick_skipped"` 事件，避免长讨论被新一轮覆盖。

---

## API 设计

### REST（Fastify）

| Method | Path | 说明 |
|---|---|---|
| GET  | `/api/config` | 当前活跃配置（cron / trader / committee / mcp_servers） |
| PUT  | `/api/config` | 新建并激活配置版本（原子事务） |
| GET  | `/api/config/history` | 历史版本列表 |
| GET  | `/api/runs?limit=&before=` | 分页 run 列表 |
| GET  | `/api/runs/:id` | run 详情（含 trader_summary、advice、状态） |
| GET  | `/api/runs/:id/events` | 全量事件（首次进入页面拉取，再挂 SSE） |
| POST | `/api/runs/trigger` | 手动触发一次 run |
| GET  | `/api/mcp/tools` | 已连接 MCP 服务器及其工具列表 |
| GET  | `/api/models` | 可选 provider 与对应可用 API key 状态 |

### SSE

- `GET /api/runs/:id/stream` — 单个 run 的实时事件流；支持 `Last-Event-ID` 续传。
- `GET /api/runs/stream` — 全局 run 生命周期事件（用于列表页实时刷新）。

事件 wire format：
```ts
type RunEvent = {
  seq: number;
  runId: string;
  agentId: string;          // "orchestrator" | "trader" | "chairman" | "member:alice"
  agentRole: "orchestrator" | "trader" | "chairman" | "member";
  round?: number;
  ts: string;
  kind: string;             // 见下
  payload: unknown;
};
```

`kind` 取值：
- 编排层：`run_start` / `run_end` / `tick_skipped` / `trader_phase_start` / `committee_phase_start` / `round_start` / `round_end` / `advice_final` / `run_failed`
- pi 透传：`agent_start` / `agent_end` / `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

---

## Web UI

**RunsListPage**：表格列出 runs（时间、状态、advice 预览、用时），订阅 `/api/runs/stream` 实时刷新；点击进入详情。

**RunDetailPage**：
- 顶部状态条 + 进度（trader → committee round X / Y → done）。
- 主体为分栏 transcript：左 trader 一列，右 committee 一组（chairman + 各成员）；每位 agent 各占一列，按时间纵向排列消息。
- 组件：`<RunTranscript>` 包 SSE 钩子 `useRunEvents(runId)`，下分 `<AgentColumn>` × N，列内渲染 `<MessageBubble>` / `<ToolCallDetails>`；委员会阶段以 `<RoundDivider>` 横向分隔。

**ConfigPage**：
- `<CronInput>` 带 `cronstrue` 中文解释；
- `<TraderEditor>`：provider/model 选择 + systemPrompt 编辑器 + maxToolCalls；
- `<CommitteeEditor>`：chairman（同 trader 结构）+ 动态成员列表（增删，每个 `<MemberCard>` 配 `<ModelPicker>` + prompt）+ maxRounds + initialFocus；
- `<McpServersEditor>`：transport（stdio/http）、command/args/env 或 url。

保存即创建新 config 版本并设为 active；scheduler 监听到变化重建 cron。

---

## 关键依赖（package.json 摘要）

```json
{
  "type": "module",
  "scripts": {
    "dev:server": "tsx watch src/index.ts",
    "dev:web":    "vite",
    "build":      "tsc -p . && vite build",
    "start":      "node dist/index.js"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^latest",
    "@earendil-works/pi-ai":        "^latest",
    "@modelcontextprotocol/sdk":    "^latest",
    "@sinclair/typebox":            "^latest",
    "fastify":                      "^5",
    "@fastify/cors":                "^10",
    "@fastify/static":              "^7",
    "pg":                           "^8",
    "croner":                       "^8",
    "zod":                          "^3"
  },
  "devDependencies": {
    "tsx": "^4",
    "typescript": "^5",
    "vite": "^5",
    "@vitejs/plugin-react": "^4",
    "react": "^18",
    "react-dom": "^18",
    "cronstrue": "^2"
  }
}
```

---

## MVP 范围圈定（明确取舍）

**包含**：cron 调度（单一活跃配置）、trader+committee 完整流程、conclude/continue 工具、MCP 适配（stdio + http）、Postgres 持久化、SSE 实时流（含 `Last-Event-ID` 续传）、runs 列表 + 详情多 agent 分栏、config 配置页（cron / trader / committee / MCP）、手动触发。

**不包含（后续迭代）**：登录认证 / 多用户、flow 热加载、回测、详细成本看板、人工审批门控、断线续跑（崩溃时把进行中 run 标 failed）、MCP 断线重连、加密的密钥托管（仅 env）、限流、复杂入参校验。

---

## 风险与对策

1. **MCP 连接生命周期**：MVP 启动时一次性建立，运行中掉线则当轮 run 失败并记日志；后续加重试与状态机。
2. **委员会 token 成本爆炸**：硬限 `maxRounds=3`，第 2 轮起 prompt 只注入"上轮要点摘要 + 主席关注问题"，并在事件 payload 里记录 pi-ai 返回的 usage 字段。
3. **cron 与长讨论重叠**：tick 时检测 `status in ('trading','committee')` 直接跳过。
4. **服务中途崩溃**：启动时把残留的非终态 run 标记为 `failed`；不做断点续跑。
5. **flow.ts 热加载**：MVP 静态导入；改完重启。
6. **SSE 通过反代**：响应头 `X-Accel-Buffering: no`、`Cache-Control: no-cache`，15s 心跳；前端 EventSource 自带重连 + 我们带 `Last-Event-ID`。
7. **ESM 一致性**：`@modelcontextprotocol/sdk` 是 ESM-only —— 全项目锁 `"type": "module"`、用 `tsx`，不混 CJS。
8. **多 API key**：`ai/models.ts` 的 `getApiKey(provider)` 从 env 读；`/api/models` 返回各 provider 是否就绪供 UI 提示。

---

## 验证方式（端到端）

1. **环境准备**
   - `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16`
   - 复制 `.env.example` → `.env`，填 `DATABASE_URL` 和至少一个 LLM API key（ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY 任意），以及一个外部 MCP server 的连接信息（命令或 URL）。
2. **启动**
   - `pnpm install`
   - 终端 1：`pnpm dev:server`（自动跑 migrations、连 MCP、启 fastify + cron）
   - 终端 2：`pnpm dev:web` 打开 http://localhost:5173
3. **配置**：进入 Config 页面，设置 cron（例 `*/5 * * * *`）、chairman、添加 2~3 名成员（分别选不同 provider）、贴 prompt、保存。
4. **手动触发**：Runs 页点击"手动触发"，跳转 RunDetail，观察分栏中 trader 调用 MCP 工具的过程、committee 的多轮讨论、主席调用 `conclude` 工具产出 advice。
5. **闭环验证**：等下一个 cron tick 触发新 run，确认 trader 的 systemPrompt 中拼接了上一次 advice（可在事件 payload 的 trader `turn_start` 中查看 messages）。
6. **断线重连**：刷新 RunDetail 页面，确认通过 `Last-Event-ID` 回放历史事件且无重复无丢失。

---

## Critical Files to Implement

- `/Users/zhou/agent/trade-agent-new/src/orchestrator/flow.ts` — 用户的流程定制入口
- `/Users/zhou/agent/trade-agent-new/src/orchestrator/committee.ts` — 主席工具 + 多轮讨论循环
- `/Users/zhou/agent/trade-agent-new/src/orchestrator/runner.ts` — cron tick → run → flow，串起 prev advice
- `/Users/zhou/agent/trade-agent-new/src/mcp/tool-adapter.ts` — MCP → AgentTool 适配
- `/Users/zhou/agent/trade-agent-new/src/mcp/manager.ts` — 多 MCP 连接管理
- `/Users/zhou/agent/trade-agent-new/src/bus/event-bus.ts` — seq + 订阅
- `/Users/zhou/agent/trade-agent-new/src/bus/db-writer.ts` — 串行落库
- `/Users/zhou/agent/trade-agent-new/src/bus/sse-hub.ts` — 客户端扇出 + 心跳
- `/Users/zhou/agent/trade-agent-new/src/http/routes/sse.ts` — `Last-Event-ID` 回放
- `/Users/zhou/agent/trade-agent-new/src/db/migrations/001_init.sql`
- `/Users/zhou/agent/trade-agent-new/web/src/pages/RunDetailPage.tsx` — 多 agent 分栏 transcript
- `/Users/zhou/agent/trade-agent-new/web/src/pages/ConfigPage.tsx` — UI 配置 committee/cron/MCP
- `/Users/zhou/agent/trade-agent-new/web/src/hooks/useRunEvents.ts` — SSE + Last-Event-ID
