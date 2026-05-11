import { useEffect, useMemo, useState } from "react";
import cronstrue from "cronstrue";
import { api, type AppConfig, type CommitteeMember, type LlmProviderConfig, type ModelRef } from "../api";

const DEFAULT_CUSTOM_PROVIDERS: LlmProviderConfig[] = [
  { provider: "poe", models: [], apiKey: "", baseUrl: "https://api.poe.com/v1" },
  { provider: "deepseek", models: ["deepseek-chat"], apiKey: "", baseUrl: "https://api.deepseek.com" },
];

function emptyMember(id: string, name: string): CommitteeMember {
  return {
    id,
    name,
    model: { provider: "deepseek", model: "deepseek-chat" },
    systemPrompt: "",
  };
}

function emptyConfig(): AppConfig {
  return {
    cronExpr: "*/30 * * * *",
    customProviders: DEFAULT_CUSTOM_PROVIDERS,
    trader: {
      model: { provider: "deepseek", model: "deepseek-chat" },
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

function normalizeModelsText(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/\r?\n|,/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeProviders(providers: LlmProviderConfig[]): LlmProviderConfig[] {
  return providers
    .map((provider) => ({
      provider: provider.provider.trim(),
      models: normalizeModelsText(provider.models.join("\n")),
      apiKey: provider.apiKey?.trim() || undefined,
      baseUrl: provider.baseUrl?.trim() || undefined,
    }))
    .filter((provider) => provider.provider);
}

function firstModelRef(providers: LlmProviderConfig[]): ModelRef {
  const first = providers[0];
  const models = normalizeModelsText(first?.models.join("\n") ?? "");
  return { provider: first?.provider ?? "", model: models[0] ?? "" };
}

function ModelPicker({
  providers,
  value,
  onChange,
}: {
  providers: LlmProviderConfig[];
  value: { provider: string; model: string };
  onChange: (v: { provider: string; model: string }) => void;
}) {
  const current = providers.find((p) => p.provider === value.provider);
  const currentModels = normalizeModelsText(current?.models.join("\n") ?? "");
  const providerOptions: LlmProviderConfig[] =
    value.provider && !current
      ? [{ provider: value.provider, models: value.model ? [value.model] : [] }, ...providers]
      : providers;
  return (
    <div className="row">
      <select
        value={value.provider}
        onChange={(e) => {
          const p = providers.find((p) => p.provider === e.target.value);
          const first = normalizeModelsText(p?.models.join("\n") ?? "")[0] ?? "";
          onChange({ provider: e.target.value, model: first });
        }}
      >
        {providerOptions.length === 0 && <option value="">Add a provider first</option>}
        {providerOptions.map((p) => (
          <option key={p.provider} value={p.provider}>
            {p.provider}
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
        {currentModels.map((m) => (
          <option key={m} value={m}>
            {m}
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
  providers: LlmProviderConfig[];
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.getConfig();
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

  const providers = config.customProviders ?? [];

  function update<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }

  function updateProvider(idx: number, nextProvider: LlmProviderConfig) {
    const previousProvider = providers[idx]?.provider;
    setConfig((current) => {
      if (!current) return current;
      const nextProviders = current.customProviders.slice();
      nextProviders[idx] = nextProvider;

      const rewriteModel = (model: ModelRef): ModelRef => {
        if (!previousProvider || !nextProvider.provider || model.provider !== previousProvider) return model;
        return { ...model, provider: nextProvider.provider, model: model.model || nextProvider.models[0] || "" };
      };

      return {
        ...current,
        customProviders: nextProviders,
        trader: { ...current.trader, model: rewriteModel(current.trader.model) },
        committee: {
          ...current.committee,
          chairman: {
            ...current.committee.chairman,
            model: rewriteModel(current.committee.chairman.model),
          },
          members: current.committee.members.map((member) => ({
            ...member,
            model: rewriteModel(member.model),
          })),
        },
      };
    });
  }

  function addProvider() {
    const nextProvider: LlmProviderConfig = {
      provider: `custom-${providers.length + 1}`,
      models: ["model-id"],
      apiKey: "",
    };
    setConfig((current) => {
      if (!current) return current;
      const nextProviders = [...current.customProviders, nextProvider];
      const model = firstModelRef(nextProviders);
      return {
        ...current,
        customProviders: nextProviders,
        trader: current.trader.model.provider ? current.trader : { ...current.trader, model },
        committee: {
          ...current.committee,
          chairman: current.committee.chairman.model.provider
            ? current.committee.chairman
            : { ...current.committee.chairman, model },
        },
      };
    });
  }

  function removeProvider(idx: number) {
    const removedProvider = providers[idx]?.provider;
    setConfig((current) => {
      if (!current) return current;
      const nextProviders = current.customProviders.filter((_, i) => i !== idx);
      const fallback = firstModelRef(nextProviders);
      const rewriteModel = (model: ModelRef): ModelRef =>
        removedProvider && model.provider === removedProvider ? fallback : model;
      return {
        ...current,
        customProviders: nextProviders,
        trader: { ...current.trader, model: rewriteModel(current.trader.model) },
        committee: {
          ...current.committee,
          chairman: {
            ...current.committee.chairman,
            model: rewriteModel(current.committee.chairman.model),
          },
          members: current.committee.members.map((member) => ({
            ...member,
            model: rewriteModel(member.model),
          })),
        },
      };
    });
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { id: _id, ...payload } = config;
      const r = await api.putConfig({ ...payload, customProviders: normalizeProviders(payload.customProviders) });
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
            const model = firstModelRef(providers);
            update("committee", {
              ...config.committee,
              members: [
                ...config.committee.members,
                { ...emptyMember(id, `Member ${config.committee.members.length + 1}`), model },
              ],
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
        {providers.map((provider, idx) => (
          <div key={idx} className="member-card">
            <div className="header">
              <strong>{provider.provider || "(unnamed provider)"}</strong>
              <button className="btn danger" onClick={() => removeProvider(idx)}>
                Remove
              </button>
            </div>
            <div className="row">
              <div>
                <label>Provider name</label>
                <input
                  value={provider.provider}
                  onChange={(e) => updateProvider(idx, { ...provider, provider: e.target.value })}
                  placeholder="poe"
                />
              </div>
              <div>
                <label>API key</label>
                <input
                  type="password"
                  value={provider.apiKey ?? ""}
                  onChange={(e) => updateProvider(idx, { ...provider, apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
            </div>
            <label>Base URL (optional for known providers)</label>
            <input
              value={provider.baseUrl ?? ""}
              onChange={(e) => updateProvider(idx, { ...provider, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
            />
            <label>Supported models (one per line or comma-separated)</label>
            <textarea
              value={provider.models.join("\n")}
              onChange={(e) => updateProvider(idx, { ...provider, models: e.target.value.split(/\r?\n/) })}
              placeholder={"gpt-5\nclaude-sonnet-4-5"}
            />
          </div>
        ))}
        {providers.length === 0 && (
          <div className="small muted" style={{ marginBottom: 10 }}>
            Add at least one provider before selecting models for Trader or Committee.
          </div>
        )}
        <button className="btn" onClick={addProvider}>
          + Add provider
        </button>
      </div>
    </div>
  );
}
