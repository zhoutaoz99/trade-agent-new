import { useEffect, useMemo, useState } from "react";
import { api, type RunEvent, type RunRow } from "../api";
import { useRunEvents } from "../hooks/useRunEvents";

interface AgentMsg {
  seq: number;
  role: "assistant" | "tool_call" | "tool_result" | "system" | "phase";
  round?: number;
  ts: string;
  text: string;
  meta?: string;
  isError?: boolean;
}

function fmt(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function pickText(content: any): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "thinking" && typeof b.thinking === "string") parts.push(`💭 ${b.thinking}`);
    else if (b?.type === "image") parts.push("[image]");
    else if (b?.type === "toolCall") {
      const args = b.arguments ? JSON.stringify(b.arguments, null, 2) : "";
      parts.push(`🔧 ${b.name}(${args})`);
    }
  }
  return parts.join("\n").trim();
}

interface AgentBucket {
  id: string;
  label: string;
  role: string;
  messages: AgentMsg[];
}

function eventToMessage(e: RunEvent): AgentMsg | null {
  const payload = e.payload as any;
  if (e.agentRole === "orchestrator") return null;

  if (e.kind === "message_end") {
    const m = payload?.message;
    if (!m) return null;
    if (m.role === "assistant") {
      return {
        seq: e.seq,
        role: "assistant",
        round: e.round,
        ts: e.ts,
        text: pickText(m.content) || "(empty assistant message)",
      };
    }
    return null;
  }
  if (e.kind === "tool_execution_start") {
    return {
      seq: e.seq,
      role: "tool_call",
      round: e.round,
      ts: e.ts,
      meta: `→ ${payload.toolName}`,
      text: JSON.stringify(payload.args ?? {}, null, 2),
    };
  }
  if (e.kind === "tool_execution_end") {
    const result = payload.result;
    const text = result?.content ? pickText(result.content) : JSON.stringify(result ?? {}, null, 2);
    return {
      seq: e.seq,
      role: "tool_result",
      round: e.round,
      ts: e.ts,
      meta: `← ${payload.toolName}${payload.isError ? " (ERROR)" : ""}`,
      text,
      isError: !!payload.isError,
    };
  }
  return null;
}

function deriveBuckets(events: RunEvent[]): AgentBucket[] {
  const map = new Map<string, AgentBucket>();
  function getBucket(id: string, role: string): AgentBucket {
    if (!map.has(id)) {
      let label = id;
      if (id === "trader") label = "Trader";
      else if (id === "chairman") label = "Chairman";
      else if (id.startsWith("member:")) label = `Member · ${id.slice(7)}`;
      map.set(id, { id, label, role, messages: [] });
    }
    return map.get(id)!;
  }
  for (const e of events) {
    const msg = eventToMessage(e);
    if (!msg) continue;
    const b = getBucket(e.agentId, e.agentRole);
    b.messages.push(msg);
  }
  return [...map.values()];
}

function orderBuckets(buckets: AgentBucket[]): AgentBucket[] {
  const order = (b: AgentBucket) => {
    if (b.id === "trader") return 0;
    if (b.id === "chairman") return 1;
    if (b.id.startsWith("member:")) return 2 + b.id.localeCompare("");
    return 99;
  };
  return [...buckets].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

export function RunDetailPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [pastEvents, setPastEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { events: liveEvents, connected } = useRunEvents(runId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getRun(runId);
        if (!cancelled) setRun(r.run);
        const ev = await api.listRunEvents(runId, 0);
        if (!cancelled) setPastEvents(ev.events);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Merge past + live, dedupe by seq.
  const allEvents = useMemo(() => {
    const seen = new Set<number>();
    const out: RunEvent[] = [];
    for (const e of [...pastEvents, ...liveEvents]) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      out.push(e);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }, [pastEvents, liveEvents]);

  const buckets = useMemo(() => orderBuckets(deriveBuckets(allEvents)), [allEvents]);

  const phaseEvents = allEvents.filter((e) => e.agentRole === "orchestrator");
  const adviceEvent = phaseEvents.find((e) => e.kind === "advice_final");
  const status = run?.status ?? "—";

  return (
    <div>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <a href="#/" className="muted small">← Back to runs</a>
          <h2 style={{ margin: "6px 0" }}>Run <span className="mono small">{runId.slice(0, 8)}</span></h2>
          <div className="small muted">
            Status: <span className={`badge ${status}`}>{status}</span> ·
            SSE: <span style={{ color: connected ? "var(--green)" : "var(--muted)" }}>{connected ? "live" : "idle"}</span> ·
            Events: {allEvents.length}
          </div>
        </div>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}

      {adviceEvent && (
        <div className="card">
          <h3 style={{ margin: "0 0 8px" }}>Committee Advice</h3>
          <pre>{(adviceEvent.payload as any).advice}</pre>
          {(adviceEvent.payload as any).rationale && (
            <>
              <div className="muted small" style={{ marginTop: 8 }}>Rationale</div>
              <pre className="muted">{(adviceEvent.payload as any).rationale}</pre>
            </>
          )}
        </div>
      )}

      {run?.traderSummary && (
        <div className="card">
          <h3 style={{ margin: "0 0 8px" }}>Trader Summary</h3>
          <pre>{run.traderSummary}</pre>
        </div>
      )}

      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>Transcript</h3>
        <div className="transcript">
          {buckets.map((b) => (
            <div key={b.id} className="agent-col">
              <h4>{b.label}</h4>
              {b.messages.length === 0 && <div className="muted small">No messages yet</div>}
              {b.messages.map((m) => (
                <div key={m.seq} className={`msg ${m.role === "tool_call" || m.role === "tool_result" ? "tool" : ""} ${m.isError ? "error" : ""}`}>
                  <div className="meta">
                    <span>{m.role}</span>
                    {m.round && <span>· round {m.round}</span>}
                    {m.meta && <span>· {m.meta}</span>}
                    <span style={{ marginLeft: "auto" }}>{fmt(m.ts)}</span>
                  </div>
                  <pre>{m.text}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>Phase log</h3>
        {phaseEvents.length === 0 && <div className="muted small">no orchestrator events</div>}
        {phaseEvents.map((e) => (
          <div key={e.seq} className="small mono" style={{ marginBottom: 4 }}>
            <span className="muted">{fmt(e.ts)}</span> · {e.kind}
            {e.round ? ` · round ${e.round}` : ""}
            {e.payload ? ` · ${JSON.stringify(e.payload).slice(0, 200)}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
