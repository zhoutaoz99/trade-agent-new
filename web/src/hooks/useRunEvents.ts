import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "../api";

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    setEvents([]);
    lastSeqRef.current = 0;
    if (!runId) return;

    let cancelled = false;
    const es = new EventSource(`/api/runs/${runId}/stream`);

    const onMessage = (e: MessageEvent) => {
      try {
        const ev: RunEvent = JSON.parse(e.data);
        if (cancelled) return;
        if (ev.seq <= lastSeqRef.current) return;
        lastSeqRef.current = ev.seq;
        setEvents((prev) => [...prev, ev]);
      } catch (err) {
        console.warn("[sse] parse failed", err);
      }
    };

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    // Listen on the generic "message" event (no event field) plus typed events.
    es.addEventListener("message", onMessage);
    // The server emits `event: <kind>`; subscribe to a broad set so we catch them.
    const wildKinds = [
      "run_start", "run_end", "run_failed", "tick_skipped", "log",
      "trader_phase_start", "committee_phase_start", "advice_final",
      "round_start", "round_end",
      "agent_start", "agent_end", "turn_start", "turn_end",
      "message_start", "message_update", "message_end",
      "tool_execution_start", "tool_execution_update", "tool_execution_end",
    ];
    for (const k of wildKinds) es.addEventListener(k, onMessage as EventListener);

    return () => {
      cancelled = true;
      es.close();
    };
  }, [runId]);

  return { events, connected };
}
