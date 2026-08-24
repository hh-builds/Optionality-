-- =====================================================================
--  Future Funded — migration 012: multiple saved plans
--
--  Run in Supabase → SQL Editor, after 011. Safe to re-run.
--
--  WHAT THIS IS FOR
--  ----------------
--  A signed-in user can keep up to five named versions of their forecast —
--  "My plan", "Me + wife", "Pay rise" — and flick between them. Naming is
--  free text and carries NO meaning: nothing in the engine, the app or this
--  file behaves differently because somebody called a plan "Pay rise".
--
--  Anonymous visitors are untouched. They have one plan, in localStorage,
--  exactly as before, and never see a selector.
--
--  ⚠️ public.projections IS NOT REPLACED, AND MUST NOT BE DROPPED.
--  ---------------------------------------------------------------------
--  It goes on holding the ACTIVE plan — the same whole-blob row it always
--  has, written on the same debounce — and it is still what the login sync
--  pulls. public.plans is the library; projections is the copy that is
--  currently open. Two consequences worth being explicit about:
--
--    * Every admin function keeps working with no change at all. plan_state(),
--      admin_users, admin_overview, admin_headline and the read-only preview
--      all read projections.data and therefore report on the plan the person
--      is actually looking at — which is the honest answer to "what has this
--      user got?". None of them are touched below.
--    * There is no deploy-ordering hazard. A client that predates this file
--      writes projections and never touches plans; a client that postdates it
--      finds no plans table, sets OptCloud.plansAvailable = false, and stays
--      in single-plan mode. Neither errors.
--
--  The duplication is one jsonb blob per user and it cannot drift: both
--  writes take the same localStorage snapshot in the same call.
--
--  WHAT IS IN A PLAN
--  -----------------
--  plans.data holds the plan-scoped localStorage keys only:
--    optionality.inputs, optionality.bridge, optionality.coast,
--    optionality.mortgage
--  Deliberately NOT optionality.dark / .realTerms / .ack — theme, today's
--  money vs nominal, and having read the disclaimer are facts about the
--  person, not about a plan, and switching plans must not flip them.
-- =====================================================================


-- ---------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  data        jsonb not null default '{}'::jsonb,
  sort_order  int  not null default 0,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists plans_user_idx on public.plans (user_id, sort_order, created_at);

-- A name is a label, and only a label. Bounded so the open write endpoint
-- can't be used as free storage, and trimmed non-empty so a plan can never
-- become unselectable by being called "".
do $$ begin
  alter table public.plans add constraint plans_name_sane
    check (length(btrim(name)) between 1 and 40);
exception when duplicate_object then null; end $$;

-- Five plans of four small blobs. A generous ceiling on the honest case and
-- a hard stop on anything else.
do $$ begin
  alter table public.plans add constraint plans_data_small
    check (pg_column_size(data) < 262144);
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
-- "At most one active plan per user" is NOT a unique index, on purpose.
--
-- A partial unique index is checked row by row, so the one-statement switch
-- in plan_set_active() below — which clears the old flag and sets the new
-- one in the same UPDATE — could trip it mid-statement depending on the
-- order rows happen to be visited. Deferring it isn't available either:
-- a partial index cannot back a DEFERRABLE constraint.
--
-- So the invariant is held by the RPCs, and every reader is written to be
-- indifferent to it anyway: they take `is_active desc, sort_order, created_at`
-- and LIMIT 1, which resolves deterministically even if two rows were
-- somehow flagged.
-- ---------------------------------------------------------------------
create index if not exists plans_active_idx on public.plans (user_id) where is_active;


-- ---------------------------------------------------------------------
-- The cap. Enforced here as well as in the client because the client is a
-- suggestion — anyone holding a session token can POST to the table.
-- ---------------------------------------------------------------------
create or replace function public.plans_cap()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if (select count(*) from public.plans p where p.user_id = new.user_id) >= 5 then
    raise exception 'plan_limit_reached'
      using hint = 'Delete one of your five saved plans to create another.';
  end if;
  return new;
end;
$$;

drop trigger if exists plans_cap_trg on public.plans;
create trigger plans_cap_trg before insert on public.plans
  for each row execute function public.plans_cap();

create or replace function public.plans_touch()
returns trigger
language plpgsql set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists plans_touch_trg on public.plans;
create trigger plans_touch_trg before update on public.plans
  for each row execute function public.plans_touch();


-- ---------------------------------------------------------------------
-- RLS — the same shape as projections: your plans are yours.
--
-- No admin read policy. Admins see people's figures through the existing
-- SECURITY DEFINER reporting functions over projections, which show the
-- plan the user has open; the other four are private working copies and
-- there is no reason for the admin page to hold them.
-- ---------------------------------------------------------------------
alter table public.plans enable row level security;

drop policy if exists "Users manage their own plans" on public.plans;
create policy "Users manage their own plans"
  on public.plans for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.plans to authenticated;


-- ---------------------------------------------------------------------
-- Operations that have to be atomic get an RPC. Everything else — renaming,
-- saving figures — is an ordinary PostgREST update under the policy above.
--
-- All three are SECURITY INVOKER: RLS still applies, so none of them can
-- reach another user's rows even if called with a hand-made id.
-- ---------------------------------------------------------------------

-- Create a plan and make it the open one, in one transaction.
create or replace function public.plan_create(p_name text, p_data jsonb default '{}'::jsonb)
returns public.plans
language plpgsql security invoker set search_path = public
as $$
declare row public.plans;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  insert into public.plans (user_id, name, data, sort_order, is_active)
  values (auth.uid(), btrim(p_name), coalesce(p_data, '{}'::jsonb),
          coalesce((select max(p.sort_order) + 1 from public.plans p where p.user_id = auth.uid()), 0),
          true)
  returning * into row;

  update public.plans set is_active = false
   where user_id = auth.uid() and id <> row.id and is_active;

  return row;
end;
$$;

-- Switch. One UPDATE over the user's rows, so there is never a moment with
-- no plan open.
create or replace function public.plan_set_active(p_id uuid)
returns void
language plpgsql security invoker set search_path = public
as $$
declare hit int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select count(*) into hit from public.plans p where p.user_id = auth.uid() and p.id = p_id;
  if hit = 0 then raise exception 'no such plan'; end if;

  update public.plans set is_active = (id = p_id)
   where user_id = auth.uid() and is_active <> (id = p_id);
end;
$$;

-- Delete, and hand the open slot to whatever is left. Refuses the last one:
-- a signed-in user always has somewhere for their figures to live.
create or replace function public.plan_delete(p_id uuid)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare was_active boolean; nxt uuid; total int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  -- Existence first, THEN the last-plan rule. The other way round, asking to
  -- delete a plan that isn't yours is answered with "you only have one",
  -- which is both wrong and a small leak about somebody else's library.
  select p.is_active into was_active
    from public.plans p where p.user_id = auth.uid() and p.id = p_id;
  if was_active is null then raise exception 'no such plan'; end if;

  select count(*) into total from public.plans p where p.user_id = auth.uid();
  if total <= 1 then
    raise exception 'last_plan'
      using hint = 'Rename it instead — an account always keeps one plan.';
  end if;

  delete from public.plans where user_id = auth.uid() and id = p_id;

  if was_active then
    select p.id into nxt from public.plans p
     where p.user_id = auth.uid()
     order by p.sort_order, p.created_at limit 1;
    update public.plans set is_active = (id = nxt) where user_id = auth.uid();
  else
    select p.id into nxt from public.plans p
     where p.user_id = auth.uid() and p.is_active
     order by p.sort_order, p.created_at limit 1;
  end if;

  return nxt;   -- the plan the client should now be showing
end;
$$;

revoke all on function public.plan_create(text, jsonb)  from public, anon;
revoke all on function public.plan_set_active(uuid)     from public, anon;
revoke all on function public.plan_delete(uuid)         from public, anon;
grant execute on function public.plan_create(text, jsonb) to authenticated;
grant execute on function public.plan_set_active(uuid)    to authenticated;
grant execute on function public.plan_delete(uuid)        to authenticated;


-- ---------------------------------------------------------------------
-- Backfill: everybody who already has figures gets "My plan" holding them.
--
-- Idempotent — it only fires for users with no plans row at all, so
-- re-running this file will not clone anyone's library. The plan-scoped
-- keys are picked out of the existing blob by name; the preference keys
-- (.dark, .realTerms, .ack) are deliberately left behind in projections.
-- ---------------------------------------------------------------------
insert into public.plans (user_id, name, data, sort_order, is_active)
select pr.user_id,
       'My plan',
       coalesce(
         (select jsonb_object_agg(k, pr.data -> k)
            from unnest(array['optionality.inputs','optionality.bridge',
                              'optionality.coast','optionality.mortgage']) k
           where pr.data ? k),
         '{}'::jsonb),
       0, true
from public.projections pr
where not exists (select 1 from public.plans p where p.user_id = pr.user_id);


-- ---------------------------------------------------------------------
-- Analytics
--
-- ⚠️ THE BATCHING TRAP, for anyone reading this in a hurry: events post in
-- batches and public.events has a CHECK listing every allowed name. ONE
-- unrecognised name fails the whole insert and takes every legitimate event
-- queued beside it. So the names have to be allowed HERE, and this file has
-- to be applied BEFORE any client that fires them ships.
--
-- The two plan events below are safe by construction: the client can only
-- fire them from a path that has already talked to public.plans, which does
-- not exist until this file runs.
--
-- 'disclaimer_ack' and 'save_nudge_dismiss' are allowed here too but NOTHING
-- FIRES THEM YET. They are the long-standing first-use gap (see
-- claude/First-Use Journey.md); allowing the names now means whoever picks
-- that up can ship a client change on its own, with no migration and no
-- ordering to get wrong.
-- ---------------------------------------------------------------------
alter table public.events drop constraint if exists events_name_allowed;
alter table public.events add constraint events_name_allowed check (name in (
  -- funnel
  'visit', 'return_visit', 'register', 'sign_in',
  'finances_entered', 'plan_completed', 'plan_updated',
  -- features
  'edit_savings', 'edit_target_income', 'edit_target_age',
  'open_advanced', 'edit_return_inflation', 'per_pot_assumptions',
  'view_projection', 'scenario_toggle', 'sooner_levers',
  'units_toggle', 'theme_toggle', 'export_csv',
  -- install / "add to home screen"  (002)
  'install_click', 'install_prompted', 'install_accepted', 'install_dismissed',
  'install_help', 'app_installed', 'app_launch',
  -- side calculators  (004 / 007 / 008)
  'open_mortgage', 'edit_mortgage', 'mortgage_advanced', 'mortgage_verdict',
  -- feedback  (009)
  'feedback_open', 'feedback_sent',
  -- multiple saved plans  (012)
  'plan_created',    -- made a second (or third…) version
  'plan_switched',   -- flicked between them: the point of the feature
  -- first-use journey  (012) — allowed, not yet fired
  'disclaimer_ack', 'save_nudge_dismiss'
));

-- admin_features, re-declared with the two new rows. Same signature, same
-- body, so there is no second overload for PostgREST to trip over.
create or replace function public.admin_features(p text default '30d', kind text default 'all', excl boolean default false)
returns table (feature text, label text, devices bigint, users bigint, pct_of_active numeric)
language plpgsql stable security definer set search_path = public
as $$
declare since timestamptz; base bigint; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  select count(distinct e.device_id) into base from public.events e
   where e.occurred_at >= since and e.name = 'finances_entered'
     and (kind = 'all' or e.device_kind = kind)
     and not (e.device_id = any(dev));

  return query
  with names(n, l) as (values
    ('edit_savings',          'Changed savings assumptions'),
    ('edit_target_income',    'Changed target income'),
    ('open_advanced',         'Opened advanced assumptions'),
    ('edit_return_inflation', 'Changed return / inflation'),
    ('per_pot_assumptions',   'Different assumptions by pot'),
    ('view_projection',       'Viewed detailed projections'),
    ('scenario_toggle',       'Toggled a scenario'),
    ('units_toggle',          'Switched today''s money / nominal'),
    ('export_csv',            'Exported CSV'),
    -- 'sooner_levers' is deliberately NOT listed: the name is allowed on
    -- public.events but nothing in the app has ever fired it, so the row could
    -- only ever read 0. The name stays in the CHECK — removing an allowed name
    -- would invalidate rows recorded under it — it just isn't reported.
    -- 'disclaimer_ack' and 'save_nudge_dismiss' are left off for the same
    -- reason: allowed above, fired by nothing yet.
    ('plan_updated',          'Returned and updated a plan'),
    ('plan_created',          'Created another plan'),
    ('plan_switched',         'Switched between plans'),
    ('open_mortgage',         'Opened "Mortgage or invest?"'),
    ('edit_mortgage',         'Changed a mortgage input'),
    ('mortgage_advanced',     'Opened the mortgage assumptions'),
    ('mortgage_verdict',      'Got a mortgage answer'),
    ('feedback_open',         'Opened the feedback box'),
    ('feedback_sent',         'Sent feedback'),
    ('install_click',         'Tapped Install app'),
    ('app_launch',            'Opened it as an installed app')
  )
  select names.n,
         names.l,
         coalesce(e.devices, 0),
         coalesce(e.users, 0),
         case when base > 0 then round(100.0 * coalesce(e.devices,0) / base, 1) else null end
  from names
  left join (
    select ev.name,
           count(distinct ev.device_id) devices,
           count(distinct ev.user_id)   users
    from public.events ev
    where ev.occurred_at >= since and (kind = 'all' or ev.device_kind = kind)
      and not (ev.device_id = any(dev))
    group by ev.name
  ) e on e.name = names.n
  order by coalesce(e.devices, 0) desc;
end;
$$;

revoke all on function public.admin_features(text,text,boolean) from public, anon;
grant execute on function public.admin_features(text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
