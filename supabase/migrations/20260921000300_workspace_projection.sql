create table public.manual_quote_links (
  owner_id uuid not null,
  quote_id text not null,
  primary key (owner_id, quote_id),
  foreign key (owner_id, quote_id) references public.option_quotes(owner_id, id) on delete cascade
);
alter table public.manual_quote_links enable row level security;
revoke all on public.manual_quote_links from anon, authenticated, public;
grant select on public.manual_quote_links to authenticated;
grant select, insert, update, delete on public.manual_quote_links to service_role;
create policy owner_read on public.manual_quote_links for select to authenticated using ((select auth.uid()) = owner_id);

create or replace function public.project_evidence(p_owner uuid, p_source jsonb)
returns text language plpgsql set search_path = '' as $$
declare
  source_id text := md5(p_source::text);
begin
  insert into public.sources (owner_id, id, url, publisher, published_at, retrieved_at, source_type, citation, confidence)
  values (p_owner, source_id, p_source->>'url', p_source->>'publisher', (p_source->>'publishedAt')::timestamptz,
          (p_source->>'retrievedAt')::timestamptz, p_source->>'method', p_source->>'citation', p_source->>'confidence')
  on conflict do nothing;
  return source_id;
end;
$$;

create or replace function public.project_quote(p_owner uuid, p_quote jsonb)
returns text language plpgsql set search_path = '' as $$
declare
  contract_id text := p_quote->>'id';
  quote_id text := md5(p_quote::text);
  source_id text;
begin
  insert into public.option_contracts (owner_id, verified_contract_symbol, underlying_symbol, option_type, strike, expiration, multiplier)
  values (p_owner, contract_id, p_quote->>'symbol', p_quote->>'type', (p_quote->>'strike')::numeric,
          (p_quote->>'expiration')::date, (p_quote->>'multiplier')::integer)
  on conflict do nothing;

  source_id := public.project_evidence(p_owner, p_quote->'source' || jsonb_build_object('retrievedAt', p_quote->>'retrievedAt'));
  insert into public.option_quotes (owner_id, id, contract_id, bid, ask, volume, open_interest, source_id,
                                    quote_timestamp, retrieved_at, validation_status)
  values (p_owner, quote_id, contract_id, (p_quote->>'bid')::numeric, (p_quote->>'ask')::numeric, (p_quote->>'volume')::bigint,
          (p_quote->>'openInterest')::bigint, source_id, (p_quote->>'quoteAt')::timestamptz,
          (p_quote->>'retrievedAt')::timestamptz, p_quote->>'status')
  on conflict do nothing;
  return quote_id;
end;
$$;

create or replace function public.project_scan(p_owner uuid, p_scan jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_scan_id text := p_scan->>'id';
  asset_symbol text;
  candidate jsonb;
  evidence jsonb;
  opportunity jsonb;
  leg jsonb;
  leg_index integer;
  source_id text;
  quote_id text;
begin
  insert into public.scan_runs (owner_id, id, scan_type, status, started_at, completed_at, parameters, error_details,
                                requested_symbols, request_count, estimated_cost, idempotency_key)
  values (p_owner, v_scan_id, p_scan->>'type', p_scan->>'status', (p_scan->>'startedAt')::timestamptz, (p_scan->>'completedAt')::timestamptz,
          p_scan->'parameters', p_scan->>'error', array(select jsonb_array_elements_text(p_scan->'tickers')),
          (p_scan->>'requestCount')::integer, (p_scan->>'estimatedCost')::numeric, p_scan->>'idempotencyKey')
  on conflict (owner_id, id) do update set status = excluded.status, completed_at = excluded.completed_at,
    error_details = excluded.error_details, request_count = excluded.request_count, estimated_cost = excluded.estimated_cost
  where scan_runs.status in ('queued', 'running');
  if not found then return; end if;

  for asset_symbol in select jsonb_array_elements_text(p_scan->'tickers') loop
    select elem into candidate from jsonb_array_elements(p_scan->'candidates') as c(elem) where elem->>'symbol' = asset_symbol limit 1;
    insert into public.scan_assets (owner_id, scan_id, symbol, status, rejection_reasons, analysis_summary)
    values (
      p_owner, v_scan_id, asset_symbol,
      case when p_scan->'failed' ? asset_symbol then 'failed' when p_scan->'completed' ? asset_symbol then 'completed'
        when p_scan->>'status' = 'cancelled' then 'cancelled' when p_scan->>'current' = asset_symbol then 'running' else 'queued' end,
      (select jsonb_agg(elem->'reason') from jsonb_array_elements(p_scan->'rejections') as r(elem) where elem->>'symbol' = asset_symbol),
      candidate - 'sources'
    )
    on conflict (owner_id, scan_id, symbol) do update set
      status = excluded.status, rejection_reasons = excluded.rejection_reasons, analysis_summary = excluded.analysis_summary;

    for evidence in select jsonb_array_elements(candidate->'sources') loop
      source_id := public.project_evidence(p_owner, evidence);
      insert into public.market_observations (owner_id, id, scan_id, symbol, observation_type, value, currency, source_id,
                                              quote_timestamp, retrieved_at, validation_status)
      values (p_owner, md5(v_scan_id || ':' || asset_symbol || ':' || source_id), v_scan_id, asset_symbol,
              case when evidence->>'quoteAt' is not null and candidate->>'price' is not null then 'reference_price' else 'research_reference' end,
              case when evidence->>'quoteAt' is not null and candidate->>'price' is not null then candidate->'price'
                else to_jsonb(coalesce(evidence->>'citation', evidence->>'publisher')) end,
              case when evidence->>'quoteAt' is not null and candidate->>'price' is not null then 'USD' end,
              source_id, (evidence->>'quoteAt')::timestamptz, (evidence->>'retrievedAt')::timestamptz, candidate->>'status')
      on conflict do nothing;
    end loop;
  end loop;

  for opportunity in select jsonb_array_elements(p_scan->'opportunities') loop
    insert into public.opportunities (owner_id, scan_id, id, symbol, strategy_type, research_direction, data_status, total_score, score_breakdown,
                                      entry_debit, maximum_loss, maximum_profit, breakeven, risk_reward_ratio, explanation, created_at)
    values (p_owner, v_scan_id, opportunity->>'id', opportunity->>'symbol', opportunity->>'strategy', opportunity->>'direction',
            opportunity->>'status', (opportunity#>>'{score,total}')::numeric, opportunity#>'{score,breakdown}',
            (opportunity#>>'{result,entryDebit}')::numeric, (opportunity#>>'{result,maxLoss}')::numeric, (opportunity#>>'{result,maxProfit}')::numeric,
            (opportunity#>>'{result,breakEven}')::numeric, (opportunity#>>'{result,rewardRisk}')::numeric,
            opportunity->>'thesis', (opportunity->>'updatedAt')::timestamptz)
    on conflict do nothing;
    for leg, leg_index in select value, ordinality::integer from jsonb_array_elements(opportunity#>'{input,legs}') with ordinality loop
      quote_id := public.project_quote(p_owner, leg);
      insert into public.opportunity_legs (owner_id, scan_id, opportunity_id, leg_index, contract_id, quote_id, side, quantity, execution_price_assumption)
      values (p_owner, v_scan_id, opportunity->>'id', leg_index, leg->>'id', quote_id, case when leg_index = 1 then 'buy' else 'sell' end,
              (opportunity#>>'{input,quantity}')::integer, (leg->>(case when leg_index = 1 then 'ask' else 'bid' end))::numeric)
      on conflict do nothing;
    end loop;
  end loop;
end;
$$;

create or replace function public.project_paper_trade(p_owner uuid, p_trade jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  leg jsonb;
  leg_index integer;
  paper_exit jsonb;
  closing_time timestamptz;
  quote_id text;
begin
  if p_trade->>'status' = 'closed' then
    select max((value->>'exitDate')::timestamptz) into closing_time from jsonb_array_elements(p_trade->'exits');
  end if;

  insert into public.paper_trades (owner_id, id, source_opportunity_id, symbol, strategy, status, quantity, remaining_quantity,
                                    entry_date, exit_date, entry_debit, fees, realized_pnl, notes, thesis)
  values (p_owner, p_trade->>'id', p_trade->>'opportunityId', p_trade->>'symbol', p_trade->>'strategy',
          p_trade->>'status', (p_trade->>'quantity')::integer, (p_trade->>'remainingQuantity')::integer, (p_trade->>'entryDate')::timestamptz,
          closing_time, (p_trade->>'entryDebit')::numeric, (p_trade->>'fees')::numeric, (p_trade->>'realizedPnl')::numeric,
          p_trade->>'notes', p_trade->>'thesis')
  on conflict (owner_id, id) do update set status = excluded.status, remaining_quantity = excluded.remaining_quantity,
    exit_date = excluded.exit_date, realized_pnl = excluded.realized_pnl, notes = excluded.notes, thesis = excluded.thesis;

  for leg, leg_index in select value, ordinality::integer from jsonb_array_elements(p_trade#>'{input,legs}') with ordinality loop
    quote_id := public.project_quote(p_owner, leg);
    insert into public.paper_trade_legs (owner_id, paper_trade_id, leg_index, contract_id, quote_id, side, quantity, entry_price)
    values (p_owner, p_trade->>'id', leg_index, leg->>'id', quote_id, case when leg_index = 1 then 'buy' else 'sell' end,
            (p_trade->>'quantity')::integer, (leg->>(case when leg_index = 1 then 'ask' else 'bid' end))::numeric)
    on conflict do nothing;
  end loop;

  for paper_exit in select jsonb_array_elements(p_trade->'exits') loop
    insert into public.paper_trade_exits (owner_id, paper_trade_id, id, quantity, exit_credit, exit_date, fees, realized_pnl, notes)
    values (p_owner, p_trade->>'id', paper_exit->>'id', (paper_exit->>'quantity')::integer, (paper_exit->>'exitCredit')::numeric,
            (paper_exit->>'exitDate')::timestamptz, (paper_exit->>'fees')::numeric, (paper_exit->>'realizedPnl')::numeric, paper_exit->>'notes')
    on conflict do nothing;
  end loop;
end;
$$;

-- Auth tables need not be granted directly to service API callers.
create or replace function public.project_profile(p_owner uuid, p_preferences jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.profiles (id, email, preferences)
  select p_owner, u.email, p_preferences from auth.users u where u.id = p_owner
  on conflict (id) do update set email = excluded.email, preferences = excluded.preferences, updated_at = now();
$$;

create or replace function public.project_workspace_state(p_owner uuid, p_old jsonb, p_new jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  item jsonb;
  item_index bigint;
  v_quote_id text;
begin
  if p_old->'settings' is distinct from p_new->'settings' then
    perform public.project_profile(p_owner, p_new->'settings');
  end if;

  if p_old->'watchlists' is distinct from p_new->'watchlists' then
    delete from public.watchlists w where w.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'watchlists') as items(item) where items.item->>'id' = w.id);
    for item in select value from jsonb_array_elements(p_new->'watchlists') loop
      insert into public.watchlists (owner_id, id, name)
      values (p_owner, item->>'id', item->>'name')
      on conflict (owner_id, id) do update set name = excluded.name;
      delete from public.watchlist_items w where w.owner_id = p_owner and w.watchlist_id = item->>'id'
        and not (item->'items' ? w.symbol);
      insert into public.watchlist_items (owner_id, watchlist_id, symbol)
      select p_owner, item->>'id', value from jsonb_array_elements_text(item->'items') on conflict do nothing;
    end loop;
  end if;

  if p_old->'scans' is distinct from p_new->'scans' then
    delete from public.scan_runs s where s.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'scans') as items(item) where items.item->>'id' = s.id);
    for item in
      select current.value from jsonb_array_elements(p_new->'scans') current
      where not exists (select from jsonb_array_elements(p_old->'scans') prior where prior.value = current.value)
    loop
      perform public.project_scan(p_owner, item);
    end loop;
  end if;

  if p_old->'portfolio' is distinct from p_new->'portfolio' then
    delete from public.paper_trades t where t.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'portfolio') as items(item) where items.item->>'id' = t.id);
    for item in
      select current.value from jsonb_array_elements(p_new->'portfolio') current
      where not exists (select from jsonb_array_elements(p_old->'portfolio') prior where prior.value = current.value)
    loop
      perform public.project_paper_trade(p_owner, item);
    end loop;
  end if;

  if p_old->'manualQuotes' is distinct from p_new->'manualQuotes' then
    delete from public.manual_quote_links m where m.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'manualQuotes') item where md5(item.value::text) = m.quote_id);
    for item in select value from jsonb_array_elements(p_new->'manualQuotes') loop
      v_quote_id := public.project_quote(p_owner, item);
      insert into public.manual_quote_links (owner_id, quote_id) values (p_owner, v_quote_id) on conflict do nothing;
    end loop;
  end if;

  if p_old->'usage' is distinct from p_new->'usage' then
    delete from public.ai_usage t where t.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'usage') with ordinality as u(item, position)
        where md5(u.item::text) || ':' || u.position = t.id);
    for item, item_index in select value, ordinality from jsonb_array_elements(p_new->'usage') with ordinality loop
      insert into public.ai_usage (owner_id, id, scan_id, model, request_type, input_tokens, output_tokens, search_usage, estimated_cost, created_at)
      values (p_owner, md5(item::text) || ':' || item_index, item->>'scanId', item->>'model', item->>'requestType',
              (item->>'inputTokens')::bigint, (item->>'outputTokens')::bigint, (item->>'searchUsage')::bigint,
              (item->>'estimatedCost')::numeric, (item->>'createdAt')::timestamptz)
      on conflict do nothing;
    end loop;
  end if;

  if p_old->'notifications' is distinct from p_new->'notifications' then
    delete from public.notifications n where n.owner_id = p_owner
      and not exists (select from jsonb_array_elements(p_new->'notifications') as items(item) where items.item->>'id' = n.id);
    for item in select value from jsonb_array_elements(p_new->'notifications') loop
      insert into public.notifications (owner_id, id, type, message, read_at, created_at)
      values (p_owner, item->>'id', item->>'type', item->>'message', (item->>'readAt')::timestamptz, (item->>'createdAt')::timestamptz)
      on conflict (owner_id, id) do update set read_at = excluded.read_at;
    end loop;
  end if;

  if p_old->'scans' is distinct from p_new->'scans'
    or p_old->'portfolio' is distinct from p_new->'portfolio'
    or p_old->'manualQuotes' is distinct from p_new->'manualQuotes' then
    delete from public.option_quotes q where q.owner_id = p_owner
      and not exists (select from public.opportunity_legs l where l.owner_id = q.owner_id and l.quote_id = q.id)
      and not exists (select from public.paper_trade_legs l where l.owner_id = q.owner_id and l.quote_id = q.id)
      and not exists (select from public.manual_quote_links l where l.owner_id = q.owner_id and l.quote_id = q.id);
    delete from public.option_contracts c where c.owner_id = p_owner
      and not exists (select from public.option_quotes q where q.owner_id = c.owner_id and q.contract_id = c.verified_contract_symbol);
    delete from public.sources s where s.owner_id = p_owner
      and not exists (select from public.option_quotes q where q.owner_id = s.owner_id and q.source_id = s.id)
      and not exists (select from public.market_observations m where m.owner_id = s.owner_id and m.source_id = s.id);
  end if;
end;
$$;

create or replace function public.save_workspace_state(p_owner uuid, p_demo boolean, p_revision bigint, p_value jsonb)
returns boolean language plpgsql set search_path = '' as $$
declare
  old_value jsonb;
begin
  if p_demo then
    if p_revision = 0 then
      insert into public.demo_workspace_states(owner_id, value) values (p_owner, p_value) on conflict do nothing;
    else
      update public.demo_workspace_states
      set revision = revision + 1, value = p_value, updated_at = now()
      where owner_id = p_owner and revision = p_revision;
    end if;
    return found;
  end if;

  if p_revision = 0 then
    insert into public.workspace_states(owner_id, value) values (p_owner, p_value) on conflict do nothing;
  else
    select value into old_value from public.workspace_states where owner_id = p_owner and revision = p_revision;
    if not found then return false; end if;
    update public.workspace_states
    set revision = revision + 1, value = p_value, updated_at = now()
    where owner_id = p_owner and revision = p_revision;
  end if;
  if not found then return false; end if;
  perform public.project_workspace_state(p_owner, old_value, p_value);
  return true;
end;
$$;

revoke all on function public.project_evidence(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.project_quote(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.project_scan(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.project_paper_trade(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.project_profile(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.project_workspace_state(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_workspace_state(uuid, boolean, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.project_evidence(uuid, jsonb), public.project_quote(uuid, jsonb),
  public.project_scan(uuid, jsonb), public.project_paper_trade(uuid, jsonb),
  public.project_profile(uuid, jsonb), public.project_workspace_state(uuid, jsonb, jsonb), public.save_workspace_state(uuid, boolean, bigint, jsonb) to service_role;
