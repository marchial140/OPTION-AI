-- Canonical per-user state and service-only transactional writes.
create table public.workspace_states (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.demo_workspace_states (
  owner_id uuid primary key,
  revision bigint not null default 1 check (revision > 0),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.workspace_states enable row level security;
alter table public.demo_workspace_states enable row level security;
revoke all on public.workspace_states, public.demo_workspace_states from anon, authenticated, public;
grant select on public.workspace_states to authenticated;
grant select, insert, update, delete on public.workspace_states, public.demo_workspace_states to service_role;
create policy workspace_owner_read on public.workspace_states for select to authenticated using ((select auth.uid()) = owner_id);

create or replace function public.workspace_has_jobs(p_value jsonb)
returns boolean language sql immutable strict
set search_path = ''
as $$
  select coalesce(p_value #>> '{settings,schedule,enabled}' = 'true', false)
    or jsonb_path_exists(p_value, '$.scans[*] ? (@.status == "queued" || @.status == "running")');
$$;

revoke all on function public.workspace_has_jobs(jsonb) from public, anon, authenticated;
grant execute on function public.workspace_has_jobs(jsonb) to service_role;

create index workspace_state_jobs on public.workspace_states(owner_id)
  where public.workspace_has_jobs(value);
create index demo_workspace_state_jobs on public.demo_workspace_states(owner_id)
  where public.workspace_has_jobs(value);

create or replace function public.list_queued_workspaces(
  p_include_demo boolean,
  p_after_owner uuid default null,
  p_after_demo boolean default false,
  p_limit integer default 200
)
returns table(owner_id uuid, is_demo boolean) language sql stable
set search_path = ''
as $$
  select jobs.owner_id, jobs.is_demo from (
    select w.owner_id, false as is_demo from public.workspace_states w
    where public.workspace_has_jobs(w.value)
      and (p_after_owner is null or (w.owner_id, false) > (p_after_owner, p_after_demo))
    union all
    select d.owner_id, true as is_demo from public.demo_workspace_states d
    where p_include_demo and public.workspace_has_jobs(d.value)
      and (p_after_owner is null or (d.owner_id, true) > (p_after_owner, p_after_demo))
  ) jobs
  order by jobs.owner_id, jobs.is_demo
  limit least(500, greatest(1, p_limit));
$$;

revoke all on function public.list_queued_workspaces(boolean, uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.list_queued_workspaces(boolean, uuid, boolean, integer) to service_role;
