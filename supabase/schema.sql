-- Run this in the Supabase SQL editor of a fresh project.
-- The agent writes with the service role key (bypasses RLS).
-- The public dashboard reads with the anon key: read-only via RLS policies.

create table if not exists snapshots (
  id bigint primary key,
  ts timestamptz not null,
  date text not null,
  equity_usd double precision not null,
  cash_usd double precision not null,
  invested_usd double precision not null,
  benchmark_equity_usd double precision,
  day_pnl_pct double precision
);

create table if not exists positions (
  ticker text primary key,
  shares double precision not null,
  avg_cost double precision not null,
  cost_basis double precision not null,
  last_price double precision,
  market_value double precision,
  pnl_usd double precision,
  stop_loss text,
  take_profit text,
  opened_at timestamptz,
  updated_at timestamptz
);

create table if not exists trades (
  id bigint primary key,
  ts timestamptz not null,
  ticker text not null,
  side text not null,
  mode text not null,
  status text not null,
  req_amount_usd double precision,
  fill_price double precision,
  fill_shares double precision,
  fill_usd double precision,
  rule_id text,
  reason text
);

create table if not exists journal (
  id text primary key,
  date text not null,
  type text not null,
  content text not null,
  created_at timestamptz not null
);

create table if not exists agent_status (
  id int primary key,
  updated_at timestamptz not null,
  mode text not null default 'dry_run',
  initial_capital double precision not null,
  equity_usd double precision,
  benchmark_equity_usd double precision,
  kill_switch boolean not null default false,
  thesis text,
  thesis_date text,
  api_cost_total_usd double precision,
  realized_pnl_usd double precision
);

alter table snapshots enable row level security;
alter table positions enable row level security;
alter table trades enable row level security;
alter table journal enable row level security;
alter table agent_status enable row level security;

create policy "public read snapshots" on snapshots for select using (true);
create policy "public read positions" on positions for select using (true);
create policy "public read trades" on trades for select using (true);
create policy "public read journal" on journal for select using (true);
create policy "public read agent_status" on agent_status for select using (true);
