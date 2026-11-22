begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions;
select plan(12);

insert into auth.users (id, email, aud, role) values
  ('ba1124ba-9a62-463d-b9b3-e88831cb3b7a', 'first@example.org', 'authenticated', 'authenticated'),
  ('ba1124ba-9a62-463d-b9b3-e88831cb3b7b', 'second@example.org', 'authenticated', 'authenticated');

set local role service_role;
select ok(public.save_workspace_state(
  'ba1124ba-9a62-463d-b9b3-e88831cb3b7a', false, 0,
  '{"settings":{"schedule":{"enabled":true}},"scans":[],"watchlists":[{"id":"principal","name":"Principale","items":["NVDA"]}],"portfolio":[],"notifications":[],"manualQuotes":[],"usage":[]}'
), 'service role creates a live workspace');
select is((select count(*) from public.watchlist_items), 1::bigint, 'relational projection records the watchlist item');
select is((select count(*) from public.list_queued_workspaces(false)), 1::bigint, 'enabled schedules are picked up by service role');
select is(public.save_workspace_state('ba1124ba-9a62-463d-b9b3-e88831cb3b7a', false, 0, '{}'), false, 'stale revision cannot replace newer workspace');
select ok(public.save_workspace_state('ba1124ba-9a62-463d-b9b3-e88831cb3b7a', true, 0, '{}'), 'demo uses a different table even with the same ID');

select ok(public.save_workspace_state('ba1124ba-9a62-463d-b9b3-e88831cb3b7a', false, 1, (
  select jsonb_set(value, '{portfolio}', '[{
    "id":"paper-one","symbol":"NVDA","strategy":"bull_call","status":"closed","quantity":1,
    "remainingQuantity":0,"entryDate":"2026-09-18T15:00:00Z","entryDebit":180,"fees":0,"realizedPnl":-185,
    "input":{"legs":[
      {"id":"NVDA261218C00150000","symbol":"NVDA","type":"call","strike":150,"expiration":"2026-12-18","multiplier":100,
       "bid":2.9,"ask":3.2,"source":{"url":"https://example.org/quote","publisher":"Test"},
       "quoteAt":"2026-09-18T15:00:00Z","retrievedAt":"2026-09-18T15:00:00Z","status":"UNVERIFIED"},
      {"id":"NVDA261218C00155000","symbol":"NVDA","type":"call","strike":155,"expiration":"2026-12-18","multiplier":100,
       "bid":1.4,"ask":1.6,"source":{"url":"https://example.org/quote","publisher":"Test"},
       "quoteAt":"2026-09-18T15:00:00Z","retrievedAt":"2026-09-18T15:00:00Z","status":"UNVERIFIED"}
    ]},
    "exits":[{"id":"exit-one","quantity":1,"exitCredit":-5,"exitDate":"2026-09-19T15:00:00Z","fees":0,"realizedPnl":-185}]
  }]'::jsonb)
  from public.workspace_states where owner_id = 'ba1124ba-9a62-463d-b9b3-e88831cb3b7a'
)), 'workspace accepts a negative paper exit credit');
select is((select exit_credit from public.paper_trade_exits where id = 'exit-one'), -5::numeric, 'negative credit projects as the paid exit debit');

set local role authenticated;
set local "request.jwt.claim.sub" = 'ba1124ba-9a62-463d-b9b3-e88831cb3b7a';
select is((select count(*) from public.workspace_states), 1::bigint, 'authenticated owner can read live workspace');
select throws_ok(
  $$select public.save_workspace_state('ba1124ba-9a62-463d-b9b3-e88831cb3b7a', false, 1, '{}')$$,
  '42501', null, 'client cannot invoke service-only writes'
);
select throws_ok($$select * from public.demo_workspace_states$$, '42501', null, 'demo state remains server-only');

set local "request.jwt.claim.sub" = 'ba1124ba-9a62-463d-b9b3-e88831cb3b7b';
select is((select count(*) from public.workspace_states), 0::bigint, 'other users cannot read live workspace');
select is((select count(*) from public.watchlist_items), 0::bigint, 'other users cannot read projected watchlist items');

reset role;
select * from finish();
rollback;
