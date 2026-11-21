-- Relational records remain scoped to the owning user. Composite foreign keys
-- prevent even a privileged writer from cross-linking two users' resources.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.watchlists (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);
create table public.watchlist_items (
  owner_id uuid not null,
  watchlist_id text not null,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  created_at timestamptz not null default now(),
  primary key (owner_id, watchlist_id, symbol),
  foreign key (owner_id, watchlist_id) references public.watchlists(owner_id, id) on delete cascade
);
create table public.scan_runs (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  scan_type text not null check (scan_type in ('quick', 'deep', 'custom')),
  status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  started_at timestamptz not null,
  completed_at timestamptz,
  parameters jsonb,
  error_details text,
  requested_symbols text[] not null,
  request_count integer not null default 0 check (request_count >= 0),
  estimated_cost numeric not null default 0 check (estimated_cost >= 0),
  idempotency_key text,
  primary key (owner_id, id),
  unique (owner_id, idempotency_key)
);
create index scan_runs_history on public.scan_runs(owner_id, started_at desc);
create table public.scan_assets (
  owner_id uuid not null,
  scan_id text not null,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  rejection_reasons jsonb,
  analysis_summary jsonb,
  primary key (owner_id, scan_id, symbol),
  foreign key (owner_id, scan_id) references public.scan_runs(owner_id, id) on delete cascade
);
create index scan_assets_symbol on public.scan_assets(owner_id, symbol);
create table public.sources (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  url text not null check (length(url) between 1 and 4096),
  publisher text not null,
  published_at timestamptz,
  retrieved_at timestamptz not null,
  source_type text,
  citation text,
  confidence text,
  primary key (owner_id, id)
);
create table public.market_observations (
  owner_id uuid not null,
  id text not null,
  scan_id text not null,
  symbol text not null,
  observation_type text not null,
  value jsonb not null,
  currency text check (currency is null or currency = 'USD'),
  source_id text not null,
  quote_timestamp timestamptz,
  retrieved_at timestamptz not null,
  validation_status text not null,
  primary key (owner_id, id),
  foreign key (owner_id, scan_id) references public.scan_runs(owner_id, id) on delete cascade,
  foreign key (owner_id, source_id) references public.sources(owner_id, id) on delete cascade
);
create index market_observations_symbol on public.market_observations(owner_id, symbol, quote_timestamp desc);
create table public.option_contracts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  verified_contract_symbol text not null,
  underlying_symbol text not null,
  option_type text not null check (option_type in ('call', 'put')),
  strike numeric not null check (strike > 0),
  expiration date not null,
  multiplier integer not null check (multiplier = 100),
  contract_status text not null default 'standard',
  primary key (owner_id, verified_contract_symbol)
);
create index option_contracts_underlying on public.option_contracts(owner_id, underlying_symbol, expiration);
create table public.option_quotes (
  owner_id uuid not null,
  id text not null,
  contract_id text not null,
  bid numeric not null check (bid >= 0),
  ask numeric not null check (ask >= bid),
  volume bigint check (volume >= 0),
  open_interest bigint check (open_interest >= 0),
  implied_volatility numeric check (implied_volatility >= 0),
  source_id text not null,
  quote_timestamp timestamptz not null,
  retrieved_at timestamptz not null,
  validation_status text not null,
  primary key (owner_id, id),
  foreign key (owner_id, contract_id) references public.option_contracts(owner_id, verified_contract_symbol) on delete cascade,
  foreign key (owner_id, source_id) references public.sources(owner_id, id) on delete cascade
);
create index option_quotes_contract on public.option_quotes(owner_id, contract_id, quote_timestamp desc);
create table public.opportunities (
  owner_id uuid not null,
  scan_id text not null,
  id text not null,
  symbol text not null,
  strategy_type text not null check (strategy_type in ('long_call', 'long_put', 'bull_call', 'bear_put')),
  research_direction text not null,
  data_status text not null,
  total_score numeric check (total_score between 0 and 100),
  score_breakdown jsonb,
  entry_debit numeric not null check (entry_debit > 0),
  maximum_loss numeric not null check (maximum_loss > 0),
  maximum_profit numeric,
  breakeven numeric,
  risk_reward_ratio numeric,
  explanation text,
  created_at timestamptz not null,
  primary key (owner_id, scan_id, id),
  foreign key (owner_id, scan_id) references public.scan_runs(owner_id, id) on delete cascade
);
create index opportunities_rank on public.opportunities(owner_id, scan_id, total_score desc nulls last);
create table public.opportunity_legs (
  owner_id uuid not null,
  scan_id text not null,
  opportunity_id text not null,
  leg_index integer not null check (leg_index in (1, 2)),
  contract_id text not null,
  quote_id text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity integer not null check (quantity > 0),
  execution_price_assumption numeric not null check (execution_price_assumption >= 0),
  primary key (owner_id, scan_id, opportunity_id, leg_index),
  foreign key (owner_id, scan_id, opportunity_id) references public.opportunities(owner_id, scan_id, id) on delete cascade,
  foreign key (owner_id, contract_id) references public.option_contracts(owner_id, verified_contract_symbol),
  foreign key (owner_id, quote_id) references public.option_quotes(owner_id, id)
);
create table public.paper_trades (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  source_opportunity_id text,
  symbol text not null,
  strategy text not null check (strategy in ('long_call', 'long_put', 'bull_call', 'bear_put')),
  status text not null check (status in ('open', 'closed')),
  quantity integer not null check (quantity > 0),
  remaining_quantity integer not null check (remaining_quantity between 0 and quantity),
  entry_date timestamptz not null,
  exit_date timestamptz,
  entry_debit numeric not null check (entry_debit > 0),
  fees numeric not null check (fees >= 0),
  realized_pnl numeric not null,
  notes text,
  thesis text,
  primary key (owner_id, id)
);
create index paper_trades_dates on public.paper_trades(owner_id, entry_date desc);
create table public.paper_trade_legs (
  owner_id uuid not null,
  paper_trade_id text not null,
  leg_index integer not null check (leg_index in (1, 2)),
  contract_id text not null,
  quote_id text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity integer not null check (quantity > 0),
  entry_price numeric not null check (entry_price >= 0),
  exit_price numeric check (exit_price >= 0),
  primary key (owner_id, paper_trade_id, leg_index),
  foreign key (owner_id, paper_trade_id) references public.paper_trades(owner_id, id) on delete cascade,
  foreign key (owner_id, contract_id) references public.option_contracts(owner_id, verified_contract_symbol),
  foreign key (owner_id, quote_id) references public.option_quotes(owner_id, id)
);
create table public.paper_trade_exits (
  owner_id uuid not null,
  paper_trade_id text not null,
  id text not null,
  quantity integer not null check (quantity > 0),
  exit_credit numeric not null check (exit_credit >= 0),
  exit_date timestamptz not null,
  fees numeric not null check (fees >= 0),
  realized_pnl numeric not null,
  notes text,
  primary key (owner_id, paper_trade_id, id),
  foreign key (owner_id, paper_trade_id) references public.paper_trades(owner_id, id) on delete cascade
);
create table public.ai_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  scan_id text,
  model text not null,
  request_type text not null check (request_type in ('screen', 'contract', 'chat')),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  search_usage bigint not null check (search_usage >= 0),
  estimated_cost numeric not null check (estimated_cost >= 0),
  created_at timestamptz not null,
  primary key (owner_id, id)
);
create index ai_usage_budget on public.ai_usage(owner_id, created_at desc);
create table public.notifications (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  type text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null,
  primary key (owner_id, id)
);
create index notifications_timeline on public.notifications(owner_id, created_at desc);

do $$
declare
  relation text;
begin
  foreach relation in array array[
    'profiles', 'watchlists', 'watchlist_items', 'scan_runs', 'scan_assets', 'sources',
    'market_observations', 'option_contracts', 'option_quotes', 'opportunities', 'opportunity_legs',
    'paper_trades', 'paper_trade_legs', 'paper_trade_exits', 'ai_usage', 'notifications'
  ] loop
    execute format('alter table public.%I enable row level security', relation);
    execute format('revoke all on public.%I from anon, authenticated, public', relation);
    execute format('grant select on public.%I to authenticated', relation);
    execute format('grant select, insert, update, delete on public.%I to service_role', relation);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = %I)',
      relation, case when relation = 'profiles' then 'id' else 'owner_id' end);
  end loop;
end;
$$;
