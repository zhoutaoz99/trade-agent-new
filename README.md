# Trade Agent

基于多智能体协作的虚拟货币交易系统。交易主智能体（Trader）定时触发，通过 MCP 服务器调用交易接口执行操作；智囊团（Committee）由 1 名主席 + N 名成员组成，每位成员可选用不同厂商的 LLM，经多轮讨论后输出投资建议；建议自动回注到下一轮交易决策中，形成反馈闭环。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Cron Scheduler                        │
│                     (croner, 可配置间隔)                      │
└─────────────┬───────────────────────────────────────────────┘
              │ tick
              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Orchestrator / Flow                       │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │    Trader     │───▶│  Committee (多轮讨论)             │   │
│  │ (MCP 工具调用)│    │  Chairman + Bull/Bear/...        │   │
│  └──────────────┘    │  conclude / continue_debate 工具  │   │
│                      └──────────────┬───────────────────┘   │
│                                     │ advice                 │
└─────────────────────────────────────┼───────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL (持久化)                         │
│  config (版本化) │ runs │ run_events (SSE 数据源)            │
└─────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌─────────────────────┐    ┌────────────────────────────────┐
│    REST API          │    │     SSE (实时事件流)            │
│  (Fastify)           │    │  Last-Event-ID 续传 + 心跳     │
└─────────────────────┘    └────────────────────────────────┘
              │                              │
              ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Web UI (Vite + React)                       │
│  运行列表 │ 运行详情(多 Agent 分栏) │ 配置管理              │
└─────────────────────────────────────────────────────────────┘
```

## 核心流程

每次 run 的执行流程定义在 `src/orchestrator/flow.ts` 中，可由用户直接编辑定制：

1. **Trader 阶段** — 创建 Trader Agent，注入上一轮 committee advice 作为系统提示的一部分，通过 MCP 工具获取行情、执行交易，输出交易摘要
2. **Committee 阶段** — 多成员并行发言，主席每轮决定 `conclude`（输出最终建议）或 `continue_debate`（提出新焦点问题继续讨论），最多 `maxRounds` 轮
3. **反馈闭环** — 建议写入 DB，下次 run 自动读取最近 N 次成功 advice 拼入 Trader 提示

## 项目结构

```
src/
  index.ts                    # 入口：迁移 → 种子配置 → MCP → 调度 → HTTP
  config.ts                   # 环境变量加载
  types.ts                    # 核心类型定义
  ai/
    models.ts                 # pi-ai 封装：getModel / getApiKey / listProviderInfo
  bus/
    event-bus.ts              # 事件总线：per-run seq 计数 + 订阅/发布
    db-writer.ts              # 串行落库队列（按 runId 排队）
    sse-hub.ts                # SSE 扇出：心跳 + Last-Event-ID 回放
  cron/
    scheduler.ts              # croner 定时任务，config 变更时重建
  db/
    pool.ts                   # pg Pool 单例 + withTx 事务辅助
    migrate.ts                # 启动时执行 SQL 迁移
    migrations/001_init.sql   # 建表：config / runs / run_events
    repo.ts                   # 类型化数据库操作
  http/
    server.ts                 # Fastify 实例 + 路由 + 静态资源
    routes/
      config.ts               # GET/PUT /api/config，GET /api/config/history
      runs.ts                 # GET /api/runs，GET /api/runs/:id，POST /api/runs/trigger
      sse.ts                  # GET /api/runs/:id/stream，GET /api/runs/stream
      mcp.ts                  # GET /api/mcp/tools
      models.ts               # GET /api/models
  mcp/
    manager.ts                # 多 MCP 服务器连接生命周期管理
    tool-adapter.ts           # MCP Tool → pi AgentTool 适配（前缀 + schema 透传）
  orchestrator/
    flow.ts                   # ★ 用户可编辑的流程入口
    flow-types.ts             # FlowContext / FlowResult 类型
    committee.ts              # 主席工具 + 多轮讨论循环
    helpers.ts                # Agent 工厂 / promptAndCollect / composeTraderSystemPrompt
    agent-events.ts           # Agent 事件 → EventBus 绑定
    runner.ts                 # 触发 run → 执行 flow → 落 advice
web/
  index.html
  vite.config.ts              # dev 代理 /api → :3000
  tsconfig.json
  src/
    main.tsx
    App.tsx                   # Hash 路由
    api.ts                    # fetch + EventSource 封装
    styles.css                # 暗色主题
    hooks/
      useRunEvents.ts         # SSE 订阅 + seq 去重 + Last-Event-ID
    pages/
      RunsListPage.tsx        # 运行列表 + 手动触发
      RunDetailPage.tsx       # 多 Agent 分栏 transcript + 实时 SSE
      ConfigPage.tsx          # cron / trader / committee / MCP 配置表单
```

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 | Node.js 20+，TypeScript，ESM (`"type": "module"`) |
| Agent 框架 | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` |
| MCP | `@modelcontextprotocol/sdk` (stdio + HTTP transport) |
| HTTP | Fastify 5 + `@fastify/cors` + `@fastify/static` |
| 数据库 | PostgreSQL 16+，`pg` 驱动 |
| 定时 | `croner` |
| 前端 | Vite 5 + React 18 + TypeScript |
| 实时推送 | SSE（EventSource），15s 心跳 + `Last-Event-ID` 续传 |
| 校验 | Zod（REST 入参），TypeBox（Agent Tool 参数） |

## 快速开始

### 前置条件

- Node.js >= 20
- PostgreSQL 16+
- 至少一个 LLM 厂商的 API Key

### 1. 安装依赖

```bash
npm install
```

### 2. 准备数据库

启动 PostgreSQL（以 Docker 为例）：

```bash
docker run -d --name trade-agent-pg \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=trade_agent \
  postgres:16
```

### 3. 配置环境变量

复制模板并填写：

```bash
cp .env.example .env
```

编辑 `.env`，至少填入一个 LLM API Key：

```env
PORT=3000
DATABASE_URL=postgresql://postgres:dev@localhost:5432/trade_agent

# 至少配置一个
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=...
```

### 4. 启动开发服务

```bash
# 同时启动后端 + 前端
npm run dev
```

或分别启动：

```bash
# 终端 1 — 后端（自动执行数据库迁移、连接 MCP、启动定时任务）
npm run dev:server

# 终端 2 — 前端
npm run dev:web
```

服务启动后：
- 后端 API：http://localhost:3000
- 前端 UI：http://localhost:5173（开发模式自动代理 `/api` 到后端）

### 5. 生产构建

```bash
npm run build
npm start
```

构建产物：`dist/`（后端）+ `web/dist/`（前端，由后端 `@fastify/static` 托管）。

## 使用说明

### 配置

打开 Web UI → `#/config` 页面：

- **Schedule**：设置 cron 表达式（如 `*/30 * * * *` 每 30 分钟），右侧自动显示人话释义
- **Trader**：选择 LLM provider/model，编辑系统提示
- **Committee**：配置主席（必须）和成员（可增删），每位可独立选模型和提示；设置最大讨论轮数和初始焦点
- **MCP Servers**：添加外部 MCP 服务器（stdio 或 HTTP transport），提供交易工具

保存即创建新的配置版本并激活，MCP 连接和定时任务自动重建。

### 手动触发

在运行列表页点击"手动触发"，或在任何支持 HTTP 的地方：

```bash
curl -X POST http://localhost:3000/api/runs/trigger
```

### 查看运行

运行详情页展示多 Agent 分栏视图：

- 左列：Trader 的完整思考过程和工具调用
- 右列：Committee 各成员的发言，按讨论轮次分隔
- 所有内容通过 SSE 实时更新，刷新页面后自动从 `Last-Event-ID` 续传

## 定制流程

交互流程定义在 `src/orchestrator/flow.ts`，直接编辑此文件即可定制。

`FlowContext` 提供以下辅助：

| 辅助函数 | 说明 |
|---|---|
| `helpers.makeTraderAgent()` | 创建 Trader Agent（注入 MCP 工具 + 历史 advice） |
| `helpers.makeMemberAgent()` | 创建 Committee 成员 Agent |
| `helpers.makeChairmanAgent()` | 创建主席 Agent（含 conclude/continue 工具） |
| `helpers.runCommittee()` | 执行完整的多轮讨论流程 |
| `helpers.promptAndCollect()` | 向 Agent 发送提示并收集最终文本回复 |
| `helpers.getMcpTools()` | 获取所有已连接 MCP 服务器的工具列表 |
| `helpers.getModel()` | 根据配置获取 LLM 模型实例 |
| `helpers.composeTraderSystemPrompt()` | 拼接系统提示 + 历史 advice |

编辑后重启服务生效（MVP 不支持热加载）。

## API 参考

### REST

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/config` | 当前活跃配置 |
| PUT | `/api/config` | 新建并激活配置版本 |
| GET | `/api/config/history` | 历史配置版本 |
| GET | `/api/runs?limit=&before=` | 分页运行列表 |
| GET | `/api/runs/:id` | 运行详情 |
| GET | `/api/runs/:id/events` | 运行全量事件 |
| POST | `/api/runs/trigger` | 手动触发运行 |
| GET | `/api/mcp/tools` | 已连接 MCP 服务器及工具 |
| GET | `/api/models` | 可用 provider 及 API key 状态 |

### SSE

| Path | 说明 |
|---|---|
| `GET /api/runs/:id/stream` | 单次运行实时事件流，支持 `Last-Event-ID` 续传 |
| `GET /api/runs/stream` | 全局运行生命周期事件（列表页实时刷新） |

## 数据库

系统启动时自动执行 `src/db/migrations/` 下的 SQL 迁移，无需手动建表。

三张核心表：

- **config** — 配置版本化，同一时刻仅一条 `active = true`（部分唯一索引保证）
- **runs** — 每次执行记录，含 `prev_run_id` 串联前后 run
- **run_events** — 运行内所有事件，复合主键 `(run_id, seq)` 支撑 SSE 续传

## MCP 服务器接入

在配置页面添加 MCP 服务器：

**stdio 类型**（本地进程）：
- Name：服务器名称
- Command：可执行文件路径（如 `npx`、`python`）
- Args：命令行参数（每行一个）
- Env：环境变量（`KEY=VALUE` 格式，每行一个）

**HTTP 类型**（远程服务）：
- Name：服务器名称
- URL：服务端点地址
- Headers：认证头等（`KEY=VALUE` 格式）

MCP 工具名会自动添加 `${serverName}__` 前缀防止冲突。

## 反馈闭环

系统自动将最近 3 次成功 run 的 committee advice 注入下一轮 Trader 的系统提示，格式如下：

```
## Guidance from prior committee runs (most recent first)
- <最新一次 advice>
- <上一次 advice>
- <更早一次 advice>
```

此机制通过数据库实现，服务重启不丢失上下文。

## 重叠保护

定时任务触发时若存在进行中的 run（`status` 为 `pending` / `trading` / `committee`），本次 tick 会被跳过并记录 `tick_skipped` 事件，避免长讨论被新 run 覆盖。

## 故障处理

- 启动时自动将残留的非终态 run 标记为 `failed`
- MCP 连接失败：当轮 run 失败并记录日志（MVP 不做自动重连）
- LLM 调用失败（如 API Key 缺失）：Agent 事件中包含 `stopReason: "error"` 和 `errorMessage`，流程优雅降级
- SSE 断线：客户端 EventSource 自动重连 + `Last-Event-ID` 从断点续传

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | HTTP 端口，默认 3000 |
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `ANTHROPIC_API_KEY` | 按需 | Anthropic (Claude) API Key |
| `OPENAI_API_KEY` | 按需 | OpenAI API Key |
| `DEEPSEEK_API_KEY` | 按需 | DeepSeek API Key |
| `GOOGLE_API_KEY` | 按需 | Google (Gemini) API Key |
| `GROQ_API_KEY` | 按需 | Groq API Key |
| `XAI_API_KEY` | 按需 | xAI (Grok) API Key |
| `OPENROUTER_API_KEY` | 按需 | OpenRouter API Key |

至少配置一个 LLM API Key，具体取决于你在配置页面为 Trader 和 Committee 成员选择了哪个 provider。
