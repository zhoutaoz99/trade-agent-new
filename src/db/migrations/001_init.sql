create extension if not exists pgcrypto;

create table if not exists config (
  id           bigserial primary key,
  cron_expr    text not null,
  trader       jsonb not null,
  committee    jsonb not null,
  mcp_servers  jsonb not null,
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index if not exists config_one_active on config(active) where active;

create table if not exists runs (
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
create index if not exists runs_started_idx on runs(started_at desc);
create index if not exists runs_status_idx on runs(status);

create table if not exists run_events (
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
create index if not exists run_events_agent_idx on run_events(run_id, agent_id, seq);
