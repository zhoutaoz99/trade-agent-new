import { useEffect, useMemo, useState } from "react";
import cronstrue from "cronstrue";
import { api, type AppConfig, type CommitteeMember, type ProviderInfo } from "../api";

function emptyMember(id: string, name: string): CommitteeMember {
  return {
    id,
    name,
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    systemPrompt: "",
  };
}

function emptyConfig(): AppConfig {
  return {
    cronExpr: "*/30 * * * *",
    trader: {
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      systemPrompt: "",
    },
    committee: {
      chairman: emptyMember("chairman", "Chairman"),
      members: [],
      maxRounds: 3,
      initialFocus: "",
    },
    mcpServers: [],
  };
}

function ModelPicker({
  providers,
  value,
  onChange,
}: {
  providers: ProviderInfo[];
  value: { provider: string; model: string };
  onChange: (v: { provider: string; model: string }) => void;
}) {
  const current = providers.find((p) => p.provider === value.provider);
  return (
    <div className="row">
      <select
        value={value.provider}
        onChange={(e) => {
          const p = providers.find((p) => p.provider === e.target.value);
          const first = p?.models[0]?.id ?? "";
          onChange({ provider: e.target.value, model: first });
        }}
      >
        {providers.map((p) => (
          <option key={p.provider} value={p.provider}>
            {p.provider}
            {p.hasKey ? "" : "  (no key)"}
          </option>
        ))}
      </select>
      <input
        type="text"
        list={`models-${value.provider}`}
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="model id"
      />
      <datalist id={`models-${value.provider}`}>
        {current?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? m.id}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function MemberEditor({
  member,
  providers,
  onChange,
  onRemove,
  removable,
}: {
  member: CommitteeMember;
  providers: ProviderInfo[];
  onChange: (m: CommitteeMember) => void;
  onRemove?: () => void;
  removable?: boolean;
}) {
  return (
    <div className="member-card">
      <div className="header">
        <strong>{member.name || member.id}</strong>
        {removable && (
          <button className="btn danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="row">
        <div>
          <label>ID</label>
          <input value={member.id} onChange={(e) => onChange({ ...member, id: e.target.value })} />
        </div>
        <div>
          <label>Name</label>
          <input value={member.name} onChange={(e) => onChange({ ...member, name: e.target.value })} />
        </div>
      </div>
      <label>Model</label>
      <ModelPicker
        providers={providers}
        value={member.model}
        onChange={(v) => onChange({ ...member, model: v })}
      />
      <label>System prompt</label>
      <textarea
        value={member.systemPrompt}
        onChange={(e) => onChange({ ...member, systemPrompt: e.target.value })}
      />
    </div>
  );
}

export function ConfigPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, p] = await Promise.all([api.getConfig(), api.listProviders()]);
        setProviders(p.providers);
        setConfig(c.config ?? emptyConfig());
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  const cronExplain = useMemo(() => {
    if (!config?.cronExpr) return "";
    try {
      return cronstrue.toString(config.cronExpr);
    } catch {
      return "(invalid cron expression)";
    }
  }, [config?.cronExpr]);

  if (!config) return <div className="card">Loading…</div>;

  function update<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { id: _id, ...payload } = config;
      const r = await api.putConfig(payload);
      setConfig(r.config);
      setSuccess("Saved. MCP and scheduler are reconciling in the background.");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Configuration</h2>
          <div className="small muted">Saving creates a new active version. MCP + scheduler are reloaded.</div>
        </div>
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save & activate"}
        </button>
      </div>

      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {success && <div className="card" style={{ color: "var(--green)" }}>{success}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Schedule</h3>
        <label>Cron expression (5 fields)</label>
        <input value={config.cronExpr} onChange={(e) => update("cronExpr", e.target.value)} />
        <div className="small muted" style={{ marginTop: 4 }}>{cronExplain}</div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Trader</h3>
        <label>Model</label>
        <ModelPicker
          providers={providers}
          value={config.trader.model}
          onChange={(v) => update("trader", { ...config.trader, model: v })}
        />
        <label>System prompt</label>
        <textarea
          value={config.trader.systemPrompt}
          onChange={(e) => update("trader", { ...config.trader, systemPrompt: e.target.value })}
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Committee</h3>
        <div className="row">
          <div>
            <label>Max rounds</label>
            <input
              type="number"
              min={1}
              max={10}
              value={config.committee.maxRounds}
              onChange={(e) =>
                update("committee", {
                  ...config.committee,
                  maxRounds: Math.max(1, parseInt(e.target.value, 10) || 1),
                })
              }
            />
          </div>
          <div>
            <label>Initial focus</label>
            <input
              value={config.committee.initialFocus ?? ""}
              onChange={(e) =>
                update("committee", { ...config.committee, initialFocus: e.target.value })
              }
            />
          </div>
        </div>

        <h4 style={{ marginBottom: 4 }}>Chairman</h4>
        <MemberEditor
          member={config.committee.chairman}
          providers={providers}
          onChange={(m) => update("committee", { ...config.committee, chairman: m })}
        />

        <h4 style={{ marginBottom: 4 }}>Members</h4>
        {config.committee.members.map((m, idx) => (
          <MemberEditor
            key={idx}
            member={m}
            providers={providers}
            removable
            onChange={(updated) => {
              const next = config.committee.members.slice();
              next[idx] = updated;
              update("committee", { ...config.committee, members: next });
            }}
            onRemove={() => {
              const next = config.committee.members.filter((_, i) => i !== idx);
              update("committee", { ...config.committee, members: next });
            }}
          />
        ))}
        <button
          className="btn"
          onClick={() => {
            const id = `m${config.committee.members.length + 1}`;
            update("committee", {
              ...config.committee,
              members: [...config.committee.members, emptyMember(id, `Member ${config.committee.members.length + 1}`)],
            });
          }}
        >
          + Add member
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>MCP Servers</h3>
        {config.mcpServers.map((srv, idx) => (
          <div key={idx} className="member-card">
            <div className="header">
              <strong>{srv.name || "(unnamed)"}</strong>
              <button
                className="btn danger"
                onClick={() => update("mcpServers", config.mcpServers.filter((_, i) => i !== idx))}
              >
                Remove
              </button>
            </div>
            <div className="row">
              <div>
                <label>Name</label>
                <input
                  value={srv.name}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    next[idx] = { ...srv, name: e.target.value };
                    update("mcpServers", next);
                  }}
                />
              </div>
              <div>
                <label>Transport</label>
                <select
                  value={srv.transport}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    next[idx] = { ...srv, transport: e.target.value as "stdio" | "http" };
                    update("mcpServers", next);
                  }}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
              </div>
            </div>
            {srv.transport === "stdio" ? (
              <>
                <label>Command</label>
                <input
                  value={srv.command ?? ""}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    next[idx] = { ...srv, command: e.target.value };
                    update("mcpServers", next);
                  }}
                />
                <label>Args (one per line)</label>
                <textarea
                  value={(srv.args ?? []).join("\n")}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    next[idx] = {
                      ...srv,
                      args: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    };
                    update("mcpServers", next);
                  }}
                />
                <label>Env (KEY=VALUE per line)</label>
                <textarea
                  value={Object.entries(srv.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split("\n")) {
                      const eq = line.indexOf("=");
                      if (eq <= 0) continue;
                      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                    }
                    next[idx] = { ...srv, env };
                    update("mcpServers", next);
                  }}
                />
              </>
            ) : (
              <>
                <label>URL</label>
                <input
                  value={srv.url ?? ""}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    next[idx] = { ...srv, url: e.target.value };
                    update("mcpServers", next);
                  }}
                />
                <label>Headers (KEY=VALUE per line)</label>
                <textarea
                  value={Object.entries(srv.headers ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
                  onChange={(e) => {
                    const next = [...config.mcpServers];
                    const headers: Record<string, string> = {};
                    for (const line of e.target.value.split("\n")) {
                      const eq = line.indexOf("=");
                      if (eq <= 0) continue;
                      headers[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                    }
                    next[idx] = { ...srv, headers };
                    update("mcpServers", next);
                  }}
                />
              </>
            )}
          </div>
        ))}
        <button
          className="btn"
          onClick={() =>
            update("mcpServers", [
              ...config.mcpServers,
              { name: `srv${config.mcpServers.length + 1}`, transport: "http" as const, url: "" },
            ])
          }
        >
          + Add MCP server
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Available providers</h3>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Has API key?</th>
              <th>Env vars checked</th>
              <th>#Models</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.provider}>
                <td className="mono">{p.provider}</td>
                <td>
                  <span className="badge" style={{ color: p.hasKey ? "var(--green)" : "var(--muted)" }}>
                    {p.hasKey ? "yes" : "no"}
                  </span>
                </td>
                <td className="small muted">{p.envKeys.join(", ") || "—"}</td>
                <td>{p.models.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
