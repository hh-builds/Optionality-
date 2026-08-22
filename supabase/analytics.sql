-- =====================================================================
--  Future Funded — analytics + admin
--  Run this whole file ONCE in Supabase → SQL Editor.
--  Safe to re-run: everything is create-if-not-exists / create-or-replace.
--
--  ⚠️ NOT SAFE TO RE-RUN ON ITS OWN once 003 and 005 have been applied.
--  Later migrations replace six of the functions defined below. Re-running this
--  file resurrects the ORIGINAL versions: for admin_funnel / admin_features /
--  admin_installs / admin_overview / admin_trend that leaves a second overload
--  and PostgREST can no longer resolve the call, and for admin_users it silently
--  reinstates the version that reported everybody's plan as Incomplete — no
--  error, just wrong answers, which is the worse of the two.
--  **If you re-run this file, run 003-admin-v2.sql and then 005-device-filter.sql
--  straight afterwards.** Together those two put everything back.
--
--  After running it, make yourself an admin (see the bootstrap block at
--  the very bottom — it needs your email).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ADMIN ALLOWLIST
--    Nothing else in this file is readable without a row in here.
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- A signed-in user may check whether THEY are an admin, nothing more.
-- (No insert/update/delete policy at all: the allowlist is managed from
-- the SQL editor only, so a compromised session can't grant itself access.)
drop policy if exists "see own admin row" on public.admins;
create policy "see own admin row" on public.admins
  for select using (auth.uid() = user_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;


-- ---------------------------------------------------------------------
-- 2. EVENTS
--    Append-only. Anyone (signed in or not) may INSERT; only admins may
--    read. Every row carries an anonymous device id, a session id and a
--    device kind so the funnel can be split by device.
--
--    `name` is constrained to a fixed vocabulary. That is the main defence
--    against a public insert endpoint being used as free storage — combined
--    with the size cap on props below.
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  device_id   uuid not null,
  session_id  uuid not null,
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null,
  device_kind text not null,
  props       jsonb not null default '{}'::jsonb
);

-- Dropped and recreated rather than "add if missing", so that adding a new
-- event name to this list and re-running the file actually widens it.
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
  -- install / "add to home screen"  (see 002-install-tracking.sql)
  'install_click', 'install_prompted', 'install_accepted', 'install_dismissed',
  'install_help', 'app_installed', 'app_launch',
  -- side calculators: "Explore other decisions" (see 004-mortgage-module.sql)
  'open_mortgage', 'edit_mortgage'
));

do $$ begin
  alter table public.events add constraint events_device_kind_allowed
    check (device_kind in ('mobile','tablet','desktop'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.events add constraint events_props_small
    check (pg_column_size(props) < 2048);
exception when duplicate_object then null; end $$;

create index if not exists events_occurred_at_idx on public.events (occurred_at desc);
create index if not exists events_device_idx      on public.events (device_id, occurred_at);
create index if not exists events_user_idx        on public.events (user_id, occurred_at);
create index if not exists events_name_idx        on public.events (name, occurred_at desc);

alter table public.events enable row level security;

-- Insert-only for the world. `occurred_at` is defaulted server-side and the
-- check below stops a client back-dating or future-dating its own rows.
drop policy if exists "anyone may record an event" on public.events;
create policy "anyone may record an event" on public.events
  for insert to anon, authenticated
  with check (
    occurred_at > now() - interval '10 minutes'
    and occurred_at < now() + interval '1 minute'
    -- a signed-in client may only attribute events to itself; an anonymous
    -- one may not attribute them to anybody
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "admins read events" on public.events;
create policy "admins read events" on public.events
  for select to authenticated using (public.is_admin());


-- ---------------------------------------------------------------------
-- 3. HELPERS
-- ---------------------------------------------------------------------

-- '7d' | '30d' | 'all'  ->  a lower bound
create or replace function public.period_start(p text)
returns timestamptz
language sql immutable
as $$
  select case p
           when '7d'  then now() - interval '7 days'
           when '30d' then now() - interval '30 days'
           else '-infinity'::timestamptz
         end;
$$;

create or replace function public.admin_guard()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. OVERVIEW — the headline numbers
-- ---------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb
language plpgsql stable security definer set search_path = public, auth
as $$
declare r jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'users', jsonb_build_object(
      'total',        (select count(*) from auth.users),
      'new_7d',       (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'new_30d',      (select count(*) from auth.users where created_at > now() - interval '30 days'),
      'active_7d',    (select count(distinct user_id) from public.events
                        where user_id is not null and occurred_at > now() - interval '7 days'),
      'active_30d',   (select count(distinct user_id) from public.events
                        where user_id is not null and occurred_at > now() - interval '30 days'),
      'unconfirmed',  (select count(*) from auth.users where email_confirmed_at is null)
    ),
    'engagement', jsonb_build_object(
      -- a "plan created" = a device that got as far as entering finances
      'plans_created',   (select count(distinct device_id) from public.events where name = 'finances_entered'),
      'plans_completed', (select count(distinct device_id) from public.events where name = 'plan_completed'),
      'returning_users', (select count(*) from (
                            select user_id from public.events
                            where user_id is not null
                            group by user_id having count(distinct session_id) > 1) t),
      'avg_sessions_per_user', (select round(avg(s), 1) from (
                            select count(distinct session_id) s from public.events
                            where user_id is not null group by user_id) t),
      'visitors_30d',    (select count(distinct device_id) from public.events
                            where occurred_at > now() - interval '30 days'),
      'sessions_30d',    (select count(distinct session_id) from public.events
                            where occurred_at > now() - interval '30 days')
    )
  ) into r;
  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. MODEL MEDIANS
--    Reads projections.data across ALL users, but only ever returns
--    aggregates — no individual figure can leave this function.
--    Suppressed entirely below 5 plans so a median can't identify anyone.
-- ---------------------------------------------------------------------
create or replace function public.admin_model_medians()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; n int;
begin
  perform public.admin_guard();

  with plans as (
    select
      (p.data ->> 'optionality.bridge')::jsonb as bridge,
      (p.data ->> 'optionality.coast')::jsonb  as coast
    from public.projections p
    where p.data ? 'optionality.bridge'
  ), vals as (
    select
      nullif((bridge ->> 'targetIncome'), '')::numeric   as target_income,
      nullif((bridge ->> 'currentBalance'), '')::numeric as isa_gia,
      nullif((coast  ->> 'currentPension'), '')::numeric as pension,
      nullif((bridge ->> 'currentAge'), '')::numeric     as current_age,
      nullif((bridge ->> 'targetAge'), '')::numeric      as target_age
    from plans
  )
  select count(*) into n from vals;

  if n < 5 then
    return jsonb_build_object('suppressed', true, 'n', n);
  end if;

  with plans as (
    select
      (p.data ->> 'optionality.bridge')::jsonb as bridge,
      (p.data ->> 'optionality.coast')::jsonb  as coast
    from public.projections p
    where p.data ? 'optionality.bridge'
  ), vals as (
    select
      nullif((bridge ->> 'targetIncome'), '')::numeric   as target_income,
      nullif((bridge ->> 'currentBalance'), '')::numeric as isa_gia,
      nullif((coast  ->> 'currentPension'), '')::numeric as pension,
      nullif((bridge ->> 'currentAge'), '')::numeric     as current_age,
      nullif((bridge ->> 'targetAge'), '')::numeric      as target_age
    from plans
  )
  select jsonb_build_object(
    'n', n,
    'median_target_income', percentile_cont(0.5) within group (order by target_income),
    'median_isa_gia',       percentile_cont(0.5) within group (order by isa_gia),
    'median_pension',       percentile_cont(0.5) within group (order by pension),
    'median_current_age',   percentile_cont(0.5) within group (order by current_age),
    'median_target_age',    percentile_cont(0.5) within group (order by target_age)
  ) into r from vals;

  return r;
end;
$$;

-- The optionality age itself is a MODEL OUTPUT, not an input, so it isn't in
-- the stored blob. The app reports it with the `plan_completed` /
-- `plan_updated` events (props->>'optionality_age'), and this reads the most
-- recent one per device.
create or replace function public.admin_median_optionality_age()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  perform public.admin_guard();
  with latest as (
    select distinct on (device_id)
           device_id,
           nullif(props ->> 'optionality_age','')::numeric as age
    from public.events
    where name in ('plan_completed','plan_updated')
      and props ? 'optionality_age'
    order by device_id, occurred_at desc
  )
  select jsonb_build_object(
    'n', count(age),
    'median', case when count(age) >= 5
                   then percentile_cont(0.5) within group (order by age)
                   else null end
  ) into r from latest;
  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. FUNNEL
--    NOTE ON ORDERING. The brief's order was
--      visited -> registered -> entered finances -> completed plan -> returned
--    but in this product registration is OPTIONAL and happens AFTER people
--    have played with the numbers and want to keep them. Scored in the brief's
--    order, "entered finances / registered" came out at 240% on test data,
--    because most people enter finances without ever registering. The order
--    below is the journey people actually take, so every conversion is a real
--    drop-off figure.
--
--    Each stage is CUMULATIVE: a device is counted at stage N only if it also
--    reached every earlier stage. So the counts only ever fall, and
--    pct_of_prev is a true "of the people who got this far, how many went on".
--    Total registrations regardless of path is in admin_overview().
--
--    Counted by DEVICE, so signed-out visitors are included.
-- ---------------------------------------------------------------------
create or replace function public.admin_funnel(p text default '30d', kind text default 'all')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz;
begin
  perform public.admin_guard();
  since := public.period_start(p);

  with scoped as (
    select * from public.events
    where occurred_at >= since
      and (kind = 'all' or device_kind = kind)
  ), d as (
    select device_id,
           bool_or(name = 'visit')            as visited,
           bool_or(name = 'finances_entered') as entered,
           bool_or(name = 'plan_completed')   as completed,
           bool_or(name = 'register')         as registered,
           bool_or(name = 'return_visit')     as returned
    from scoped group by device_id
  ), c as (
    select
      count(*) filter (where visited)                                                  as s1,
      count(*) filter (where visited and entered)                                      as s2,
      count(*) filter (where visited and entered and completed)                        as s3,
      count(*) filter (where visited and entered and completed and registered)         as s4,
      count(*) filter (where visited and entered and completed and registered
                             and returned)                                             as s5
    from d
  )
  select jsonb_build_array(
    jsonb_build_object('stage','Visited',          'count', s1,
                       'pct_of_prev', null,
                       'pct_of_top',  case when s1 > 0 then 100.0 end),
    jsonb_build_object('stage','Entered finances', 'count', s2,
                       'pct_of_prev', case when s1 > 0 then round(100.0*s2/s1,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s2/s1,1) end),
    jsonb_build_object('stage','Completed plan',   'count', s3,
                       'pct_of_prev', case when s2 > 0 then round(100.0*s3/s2,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s3/s1,1) end),
    jsonb_build_object('stage','Registered',       'count', s4,
                       'pct_of_prev', case when s3 > 0 then round(100.0*s4/s3,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s4/s1,1) end),
    jsonb_build_object('stage','Returned',         'count', s5,
                       'pct_of_prev', case when s4 > 0 then round(100.0*s5/s4,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s5/s1,1) end)
  ) into r from c;

  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. FEATURE USAGE
--    "% of active" is against devices that got as far as entering finances
--    in the same window — the population that could plausibly use a feature.
-- ---------------------------------------------------------------------
create or replace function public.admin_features(p text default '30d', kind text default 'all')
returns table (feature text, label text, devices bigint, users bigint, pct_of_active numeric)
language plpgsql stable security definer set search_path = public
as $$
declare since timestamptz; base bigint;
begin
  perform public.admin_guard();
  since := public.period_start(p);

  select count(distinct device_id) into base from public.events
   where occurred_at >= since and name = 'finances_entered'
     and (kind = 'all' or device_kind = kind);

  return query
  with names(n, l) as (values
    ('edit_savings',          'Changed savings assumptions'),
    ('edit_target_income',    'Changed target income'),
    ('edit_target_age',       'Changed target optionality age'),
    ('open_advanced',         'Opened advanced assumptions'),
    ('edit_return_inflation', 'Changed return / inflation'),
    ('per_pot_assumptions',   'Different assumptions by pot'),
    ('view_projection',       'Viewed detailed projections'),
    ('scenario_toggle',       'Toggled a scenario'),
    ('sooner_levers',         'Used "get me there sooner"'),
    ('units_toggle',          'Switched today''s money / nominal'),
    ('export_csv',            'Exported CSV'),
    ('plan_updated',          'Returned and updated a plan'),
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
    select name,
           count(distinct device_id) devices,
           count(distinct user_id)   users
    from public.events
    where occurred_at >= since and (kind = 'all' or device_kind = kind)
    group by name
  ) e on e.name = names.n
  order by coalesce(e.devices, 0) desc;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. TREND — one row per day, for a small sparkline
-- ---------------------------------------------------------------------
create or replace function public.admin_trend(p text default '30d')
returns table (day date, visitors bigint, new_users bigint, completions bigint)
language plpgsql stable security definer set search_path = public, auth
as $$
declare since timestamptz;
begin
  perform public.admin_guard();
  since := greatest(public.period_start(p), now() - interval '180 days');

  return query
  with days as (
    select generate_series(since::date, now()::date, interval '1 day')::date d
  )
  select days.d,
         (select count(distinct device_id) from public.events e
           where e.occurred_at::date = days.d),
         (select count(*) from auth.users u where u.created_at::date = days.d),
         (select count(distinct device_id) from public.events e
           where e.occurred_at::date = days.d and e.name = 'plan_completed')
  from days order by days.d;
end;
$$;


-- ---------------------------------------------------------------------
-- 9. USER LIST
--    Deliberately carries NO financial figures — only whether a plan exists
--    and when it last changed. Medians above are the only view onto the
--    numbers themselves.
--
--    filter: all | new | active | inactive | incomplete | recent | unconfirmed
--    sort:   created | last_active | sessions | email | updated
-- ---------------------------------------------------------------------
create or replace function public.admin_users(
  search text default '',
  filter text default 'all',
  sort   text default 'last_active',
  dir    text default 'desc',
  lim    int  default 50,
  off    int  default 0
)
returns table (
  user_id       uuid,
  email         text,
  display_name  text,
  created_at    timestamptz,
  confirmed     boolean,
  last_active   timestamptz,
  sessions      bigint,
  plan_complete boolean,
  plan_updated  timestamptz,
  device_kinds  text,
  status        text,
  total_count   bigint
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  perform public.admin_guard();

  return query
  with agg as (
    select e.user_id,
           max(e.occurred_at)                                  as last_active,
           count(distinct e.session_id)                        as sessions,
           bool_or(e.name = 'plan_completed')                  as plan_complete,
           string_agg(distinct e.device_kind, ', ' order by e.device_kind) as device_kinds
    from public.events e where e.user_id is not null group by e.user_id
  ), rows as (
    select u.id,
           u.email::text,
           coalesce(u.raw_user_meta_data ->> 'full_name', '')  as display_name,
           u.created_at,
           (u.email_confirmed_at is not null)                  as confirmed,
           a.last_active,
           coalesce(a.sessions, 0)                             as sessions,
           coalesce(a.plan_complete, false)                    as plan_complete,
           pr.updated_at                                       as plan_updated,
           coalesce(a.device_kinds, '')                        as device_kinds,
           case
             when u.email_confirmed_at is null                        then 'unconfirmed'
             when a.last_active is null                               then 'never used'
             when a.last_active > now() - interval '7 days'           then 'active'
             when a.last_active > now() - interval '30 days'          then 'idle'
             else 'dormant'
           end                                                 as status
    from auth.users u
    left join agg a          on a.user_id = u.id
    left join public.projections pr on pr.user_id = u.id
  ), filtered as (
    select * from rows r
    where (search = '' or r.email ilike '%'||search||'%' or r.display_name ilike '%'||search||'%')
      and case filter
            when 'new'         then r.created_at > now() - interval '7 days'
            when 'active'      then r.last_active > now() - interval '7 days'
            when 'inactive'    then (r.last_active is null or r.last_active < now() - interval '30 days')
            when 'incomplete'  then r.plan_complete = false
            when 'recent'      then r.last_active > now() - interval '24 hours'
            when 'unconfirmed' then r.confirmed = false
            else true
          end
  )
  select f.id, f.email, f.display_name, f.created_at, f.confirmed, f.last_active,
         f.sessions, f.plan_complete, f.plan_updated, f.device_kinds, f.status,
         (select count(*) from filtered)
  from filtered f
  order by
    case when dir = 'asc' then
      case sort when 'created' then extract(epoch from f.created_at)
                when 'sessions' then f.sessions::numeric
                when 'updated' then extract(epoch from f.plan_updated)
                else extract(epoch from f.last_active) end
    end asc nulls last,
    case when dir <> 'asc' then
      case sort when 'created' then extract(epoch from f.created_at)
                when 'sessions' then f.sessions::numeric
                when 'updated' then extract(epoch from f.plan_updated)
                else extract(epoch from f.last_active) end
    end desc nulls last,
    case when sort = 'email' and dir = 'asc' then f.email end asc nulls last,
    case when sort = 'email' and dir <> 'asc' then f.email end desc nulls last
  limit greatest(1, least(lim, 200)) offset greatest(0, off);
end;
$$;


-- ---------------------------------------------------------------------
-- 9b. INSTALL — "add to home screen" funnel and usage
--
--    NOTE — iOS gives us nothing. Safari fires neither beforeinstallprompt nor
--    appinstalled, so on iPhone/iPad 'install_prompted' and 'app_installed' are
--    always zero. The honest signal there is `launch_devices`: devices that have
--    actually opened the app in standalone mode. Read that as "installed and
--    being used", and treat it as the real number.
-- ---------------------------------------------------------------------
create or replace function public.admin_installs(p text default 'all', kind text default 'all')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz;
begin
  perform public.admin_guard();
  since := public.period_start(p);

  with scoped as (
    select * from public.events
    where occurred_at >= since and (kind = 'all' or device_kind = kind)
  )
  select jsonb_build_object(
    'clicked',        (select count(distinct device_id) from scoped where name = 'install_click'),
    'prompted',       (select count(distinct device_id) from scoped where name = 'install_prompted'),
    'accepted',       (select count(distinct device_id) from scoped where name = 'install_accepted'),
    'dismissed',      (select count(distinct device_id) from scoped where name = 'install_dismissed'),
    'help_shown',     (select count(distinct device_id) from scoped where name = 'install_help'),
    'installed',      (select count(distinct device_id) from scoped where name = 'app_installed'),
    'launch_devices', (select count(distinct device_id) from scoped where name = 'app_launch'),
    'launches',       (select count(*)                  from scoped where name = 'app_launch'),
    -- which platform people are on when we have to fall back to written steps
    'help_by_platform', coalesce((
      select jsonb_object_agg(pf, n) from (
        select coalesce(props ->> 'platform', 'unknown') pf, count(distinct device_id) n
        from scoped where name = 'install_help' group by 1
      ) t), '{}'::jsonb),
    -- of everyone who visited in the window, how many run it as an app
    'visitors',       (select count(distinct device_id) from scoped)
  ) into r;

  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 10. GRANTS — only signed-in users may even call these; each one then
--     checks is_admin() for itself.
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'admin_overview()',
    'admin_model_medians()',
    'admin_median_optionality_age()',
    'admin_funnel(text,text)',
    'admin_features(text,text)',
    'admin_trend(text)',
    'admin_users(text,text,text,text,int,int)',
    'admin_installs(text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 11. RETENTION — keep the event log from growing forever.
--     Run manually now and then, or schedule with pg_cron if you enable it.
-- ---------------------------------------------------------------------
create or replace function public.prune_events(keep_days int default 400)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare n bigint;
begin
  perform public.admin_guard();
  delete from public.events where occurred_at < now() - (keep_days || ' days')::interval;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.prune_events(int) from public, anon;
grant execute on function public.prune_events(int) to authenticated;


-- =====================================================================
--  BOOTSTRAP — RUN THIS SEPARATELY, WITH YOUR OWN EMAIL.
--  Until you do, admin.html will sign you in and then tell you you're
--  not an admin, which is correct behaviour.
-- =====================================================================
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'you@example.com'
-- on conflict do nothing;

-- Check it worked:
-- select u.email, a.added_at from public.admins a join auth.users u on u.id = a.user_id;
