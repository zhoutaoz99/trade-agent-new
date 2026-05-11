import { useEffect, useState } from "react";
import { api, type RunRow } from "../api";

function fmtTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleString();
}

function duration(start: string, end: string | null): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function RunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.listRuns({ limit: 100 });
      setRuns(r.items);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  async function onTrigger() {
    setTriggering(true);
    try {
      const r = await api.trigger();
      if (r.status === "skipped") {
        setError(`Skipped: ${r.reason ?? "unknown"}`);
      } else {
        window.location.hash = `#/runs/${r.runId}`;
      }
      load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Runs</h2>
          <div className="muted small">Auto-refresh every 4s</div>
        </div>
        <button className="btn primary" disabled={triggering} onClick={onTrigger}>
          {triggering ? "Triggering…" : "Manual trigger"}
        </button>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Duration</th>
              <th>Advice</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && runs.length === 0 && (
              <tr><td colSpan={6} className="muted">Loading…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={6} className="muted">No runs yet. Click "Manual trigger" or wait for cron.</td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{fmtTime(r.startedAt)}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>{r.trigger}</td>
                <td>{duration(r.startedAt, r.endedAt)}</td>
                <td style={{ maxWidth: 360 }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.advice ?? (r.error ? <span style={{ color: "var(--red)" }}>{r.error}</span> : <span className="muted">—</span>)}
                  </div>
                </td>
                <td>
                  <a href={`#/runs/${r.id}`} className="btn">Open</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
