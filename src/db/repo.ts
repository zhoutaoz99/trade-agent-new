import type { AppConfig, RunEvent, RunRow, RunStatus, RunTrigger } from "../types.js";
import { pool, withTx } from "./pool.js";

function rowToConfig(row: any): AppConfig {
  return {
    id: Number(row.id),
    cronExpr: row.cron_expr,
    trader: row.trader,
    committee: row.committee,
    mcpServers: row.mcp_servers,
  };
}

function rowToRun(row: any): RunRow {
  return {
    id: row.id,
    configId: Number(row.config_id),
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    trigger: row.trigger,
    prevRunId: row.prev_run_id ?? null,
    traderSummary: row.trader_summary ?? null,
    advice: row.advice ?? null,
    error: row.error ?? null,
  };
}

export async function getActiveConfig(): Promise<AppConfig | null> {
  const r = await pool.query("select * from config where active = true limit 1");
  return r.rowCount ? rowToConfig(r.rows[0]) : null;
}

export async function listConfigHistory(limit = 50): Promise<AppConfig[]> {
  const r = await pool.query("select * from config order by id desc limit $1", [limit]);
  return r.rows.map(rowToConfig);
}

export async function createAndActivateConfig(cfg: Omit<AppConfig, "id">): Promise<AppConfig> {
  return withTx(async (client) => {
    await client.query("update config set active = false where active = true");
    const r = await client.query(
      `insert into config (cron_expr, trader, committee, mcp_servers, active)
       values ($1,$2::jsonb,$3::jsonb,$4::jsonb,true) returning *`,
      [
        cfg.cronExpr,
        JSON.stringify(cfg.trader),
        JSON.stringify(cfg.committee),
        JSON.stringify(cfg.mcpServers ?? []),
      ],
    );
    return rowToConfig(r.rows[0]);
  });
}

export async function ensureSeedConfig(seed: Omit<AppConfig, "id">): Promise<AppConfig> {
  const existing = await getActiveConfig();
  if (existing) return existing;
  return createAndActivateConfig(seed);
}

export async function createRun(input: {
  configId: number;
  trigger: RunTrigger;
  prevRunId: string | null;
}): Promise<RunRow> {
  const r = await pool.query(
    `insert into runs (config_id, status, trigger, prev_run_id)
     values ($1,'pending',$2,$3) returning *`,
    [input.configId, input.trigger, input.prevRunId],
  );
  return rowToRun(r.rows[0]);
}

export async function updateRunStatus(
  runId: string,
  status: RunStatus,
  extra: Partial<{ traderSummary: string; advice: string; error: string; ended: boolean }> = {},
): Promise<void> {
  const sets: string[] = ["status = $2"];
  const params: any[] = [runId, status];
  let i = 3;
  if (extra.traderSummary !== undefined) {
    sets.push(`trader_summary = $${i++}`);
    params.push(extra.traderSummary);
  }
  if (extra.advice !== undefined) {
    sets.push(`advice = $${i++}`);
    params.push(extra.advice);
  }
  if (extra.error !== undefined) {
    sets.push(`error = $${i++}`);
    params.push(extra.error);
  }
  if (extra.ended) sets.push(`ended_at = now()`);
  await pool.query(`update runs set ${sets.join(", ")} where id = $1`, params);
}

export async function getRun(id: string): Promise<RunRow | null> {
  const r = await pool.query("select * from runs where id = $1", [id]);
  return r.rowCount ? rowToRun(r.rows[0]) : null;
}

export async function listRuns(
  opts: { limit?: number; before?: string } = {},
): Promise<RunRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.before) {
    const r = await pool.query(
      `select * from runs where started_at < (select started_at from runs where id = $1)
       order by started_at desc limit $2`,
      [opts.before, limit],
    );
    return r.rows.map(rowToRun);
  }
  const r = await pool.query("select * from runs order by started_at desc limit $1", [limit]);
  return r.rows.map(rowToRun);
}

export async function getLatestAdvices(limit = 3): Promise<string[]> {
  const r = await pool.query(
    `select advice from runs where status = 'done' and advice is not null
     order by ended_at desc nulls last limit $1`,
    [limit],
  );
  return r.rows.map((row) => row.advice as string);
}

export async function getLatestSuccessfulRunId(): Promise<string | null> {
  const r = await pool.query(
    `select id from runs where status = 'done' order by ended_at desc nulls last limit 1`,
  );
  return r.rowCount ? r.rows[0].id : null;
}

export async function hasActiveRun(): Promise<boolean> {
  const r = await pool.query(
    `select 1 from runs where status in ('pending','trading','committee') limit 1`,
  );
  return r.rowCount! > 0;
}

export async function markOrphanedRunsFailed(): Promise<number> {
  const r = await pool.query(
    `update runs set status = 'failed', error = coalesce(error, 'orphaned at startup'), ended_at = now()
     where status in ('pending','trading','committee')`,
  );
  return r.rowCount ?? 0;
}

export async function insertRunEvent(e: RunEvent): Promise<void> {
  await pool.query(
    `insert into run_events (run_id, seq, agent_id, agent_role, round, kind, ts, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     on conflict (run_id, seq) do nothing`,
    [
      e.runId,
      e.seq,
      e.agentId,
      e.agentRole,
      e.round ?? null,
      e.kind,
      e.ts,
      JSON.stringify(e.payload ?? null),
    ],
  );
}

export async function listRunEvents(
  runId: string,
  afterSeq = 0,
): Promise<RunEvent[]> {
  const r = await pool.query(
    `select run_id, seq, agent_id, agent_role, round, kind, ts, payload
     from run_events where run_id = $1 and seq > $2 order by seq asc`,
    [runId, afterSeq],
  );
  return r.rows.map((row) => ({
    runId: row.run_id,
    seq: Number(row.seq),
    agentId: row.agent_id,
    agentRole: row.agent_role,
    round: row.round ?? undefined,
    ts: row.ts.toISOString(),
    kind: row.kind,
    payload: row.payload,
  }));
}
