# Trade-Agent 执行流程分析

## 整体触发流程

```mermaid
flowchart TD
    A["用户点击触发按钮 / Cron定时触发"] --> B["POST /api/runs/trigger<br/>或 Cron 回调"]
    B --> C["triggerRun('manual' / 'cron')"]

    C --> D{hasActiveRun?}
    D -- 是 --> E["return skipped<br/>reason: another run in progress"]
    D -- 否 --> F{getActiveConfig?}
    F -- 否 --> G["return skipped<br/>reason: no active config"]
    F -- 有 --> H["createRun() → DB写入<br/>status = pending"]

    H --> I["bus.emit('run_start')"]
    I --> J["return { runId, status: 'started' }<br/>← HTTP 响应立即返回"]

    I --> K["EventBus 广播"]
    K --> K1["db-writer<br/>insertRunEvent"]
    K --> K2["sse-hub<br/>fanout → 浏览器"]

    J --> L["void executeRun(runId)<br/>异步执行"]
```

## executeRun 主流程

```mermaid
flowchart TD
    START["executeRun(runId)"] --> A["updateRunStatus('trading')"]
    A --> B["runFlow(ctx)"]

    B --> C["bus.emit('trader_phase_start')"]
    C --> D["makeTraderAgent()"]

    D --> D1["composeTraderSystemPrompt()<br/>拼接基础提示 + 历史建议"]
    D --> D2["resolveModel()<br/>解析 provider/model 配置"]
    D --> D3["getMcpTools()<br/>加载 MCP 工具为 AgentTool"]
    D --> D4["new Agent(pi-agent)"]
    D --> D5["bindAgentToBus()<br/>Agent 事件 → EventBus 桥接"]

    D --> E["promptAndCollect(trader, prompt)"]

    E --> F["agent.prompt() → LLM 循环"]
    F --> G{LLM 回复包含<br/>工具调用?}
    G -- 是 --> H["执行 MCP 工具"]
    H --> I["将工具结果送回 LLM"]
    I --> F
    G -- 否 --> J["返回 traderSummary"]

    J --> K["bus.emit('log', 'trader done')"]
    K --> L["bus.emit('committee_phase_start')"]
    L --> M["runCommittee()"]

    M --> N["返回 { traderSummary, advice }"]

    N --> O{执行结果}
    O -- 成功 --> P["updateStatus('done')<br/>保存 traderSummary + advice"]
    P --> Q["bus.emit('run_end')"]
    O -- 失败 --> R["updateStatus('failed')<br/>保存 error"]
    R --> S["bus.emit('run_failed')"]

    Q --> T["flushDbWrites()<br/>确保所有事件持久化"]
    S --> T
```

## 委员会多轮讨论流程

```mermaid
flowchart TD
    START["runCommittee()"] --> A["makeMemberAgent() × N<br/>每位成员创建独立 Agent"]
    A --> B["makeChairmanAgent()<br/>主席 Agent, 带 conclude / continue_debate 工具"]

    B --> C["初始化 transcript, focus"]
    C --> R["Round = 1"]

    R --> D["bus.emit('round_start')"]
    D --> E["成员并行发言<br/>Promise.all(member.prompt())"]
    E --> F["收集每个成员观点<br/>写入 transcript"]
    F --> G["主席裁决<br/>chairman.prompt()"]

    G --> H{主席决策}
    H -- "conclude<br/>(达成共识)" --> I["return { advice, rationale, transcript, rounds }"]
    H -- "continue_debate<br/>(需要继续)" --> J["更新 focus = focusQuestions"]
    J --> K["bus.emit('round_end')"]

    K --> L{"round < maxRounds?"}
    L -- 是 --> M["Round++"]
    M --> D
    L -- 否 --> N["最后一轮强制 conclude<br/>使用主席文本作为 fallback advice"]

    I --> O["bus.emit('round_end')"]
    O --> P["bus.emit('advice_final')"]

    N --> O
```

## 事件总线消费链路

```mermaid
flowchart LR
    EMIT["bus.emit(event)"] --> DB["db-writer<br/>enqueueWrite"]
    EMIT --> SSE["sse-hub<br/>fanout"]

    DB --> DBQ["串行写入队列<br/>per-run Promise 链"]
    DBQ --> PG["insertRunEvent() → PostgreSQL"]

    SSE --> FILTER["遍历 SSE 客户端<br/>filter 匹配"]
    FILTER --> S1["/api/runs/:id/stream<br/>单 Run 事件流"]
    FILTER --> S2["/api/runs/stream<br/>全局生命周期流"]
```

## Agent 事件桥接机制

```mermaid
flowchart LR
    AGENT["pi-agent Agent<br/>(trader / member / chairman)"] --> |"agent.subscribe()"| BRIDGE["bindAgentToBus()"]
    BRIDGE --> |"bus.emit({<br/>  runId,<br/>  agentId,<br/>  agentRole,<br/>  kind: event.type,<br/>  payload: event<br/>})"| BUS["EventBus"]
    BUS --> DB["db-writer → PostgreSQL"]
    BUS --> SSE["sse-hub → 浏览器 SSE"]
```

## Run 状态流转

```mermaid
stateDiagram-v2
    [*] --> pending: createRun()
    pending --> trading: executeRun() 开始
    trading --> done: runFlow() 成功完成
    trading --> failed: 任意阶段异常

    note right of trading
        实际实现中 committee 阶段
        也处于 trading 状态,
        仅通过事件 (kind) 区分子阶段:
        - trader_phase_start
        - committee_phase_start
        - round_start / round_end
    end note

    done --> [*]
    failed --> [*]
```

## MCP 工具集成流程

```mermaid
flowchart TD
    A["mcpManager.connectAll(servers)"] --> B["遍历 McpServerConfig"]
    B --> C{transport 类型}
    C -- stdio --> D["StdioClientTransport<br/>command + args + env"]
    C -- http --> E["StreamableHTTPClientTransport<br/>url + headers"]

    D --> F["client.connect(transport)"]
    E --> F
    F --> G["client.listTools()"]
    G --> H["mcpToolToAgentTool()<br/>每个工具转换为 AgentTool"]
    H --> I["存储到 mcpManager.servers"]

    I --> J["getAllTools()"]
    J --> K["传入 makeTraderAgent()<br/>作为 tools 参数"]

    K --> L["Trader Agent 可通过<br/>tool call 调用 MCP 工具"]
```

## 关键设计要点

1. **触发即返回** — `triggerRun` 创建 run 后用 `void executeRun()` 异步执行，HTTP 立即返回 `runId`
2. **事件驱动** — 所有阶段通过 `bus.emit` 广播事件，前端通过 SSE 实时接收进度
3. **串行写入** — db-writer 用 per-run 的 Promise 链保证事件按 `seq` 顺序入库
4. **委员会多轮** — 成员并行发言，主席串行裁决，最多 `maxRounds` 轮，最后一轮强制结束
5. **Agent 事件桥接** — `bindAgentToBus()` 将 pi-agent 内部事件（工具调用、LLM 请求/响应）转发到全局 EventBus
6. **MCP 工具适配** — MCP 工具通过 `mcpToolToAgentTool()` 转换为 pi-agent 的 `AgentTool` 接口，工具名做安全化处理

## 文件职责速查

| 文件 | 职责 |
|------|------|
| `src/http/routes/runs.ts` | HTTP 路由：触发、查询 runs/events |
| `src/orchestrator/runner.ts` | 入口：`triggerRun()` + `executeRun()`，状态管理与错误恢复 |
| `src/orchestrator/flow.ts` | 用户可编辑的流程编排：先 trader 后 committee |
| `src/orchestrator/committee.ts` | 委员会多轮讨论逻辑 |
| `src/orchestrator/helpers.ts` | Agent 工厂：`makeTraderAgent` / `makeMemberAgent` / `makeChairmanAgent` |
| `src/orchestrator/agent-events.ts` | Agent 事件 → EventBus 桥接 |
| `src/bus/event-bus.ts` | 全局事件总线（发布/订阅） |
| `src/bus/db-writer.ts` | 事件持久化：串行队列写入 PostgreSQL |
| `src/bus/sse-hub.ts` | SSE 推送：事件实时广播到浏览器 |
| `src/mcp/manager.ts` | MCP 服务器连接管理 |
| `src/mcp/tool-adapter.ts` | MCP 工具 → AgentTool 适配器 |
| `src/ai/models.ts` | LLM 模型解析与 API Key 获取 |
| `src/cron/scheduler.ts` | Cron 定时调度 |
| `src/db/repo.ts` | 数据库 CRUD 操作 |
