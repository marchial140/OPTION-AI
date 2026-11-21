begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions;
select plan(10);

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
