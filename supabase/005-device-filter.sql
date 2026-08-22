-- =====================================================================
--  Future Funded — migration 005: make the Device filter mean something
--
--  Run this ONCE in Supabase → SQL Editor, after 003-admin-v2.sql.
--  Safe to re-run. (004 is the mortgage module, from a parallel piece of work;
--  it only widens the event-name whitelist and does not overlap with this.)
--
--  BUG THIS FIXES. The Device control (All / Mobile / Tablet / Desktop) was
--  passed to admin_funnel, admin_features, admin_installs and admin_countries
--  but NOT to admin_overview or admin_trend, which never had a `kind` argument.
--  Those two draw everything at the top of the Overview tab, so switching the
--  control appeared to do nothing at all — the funnel below it was changing,
--  but nobody looks that far down before deciding a toggle is broken.
--
--  WHAT CAN AND CANNOT BE SPLIT BY DEVICE. Anything counted from `events` can:
--  a visit, a session, a completed plan all happened on one particular device.
--  Anything counted from `auth.users` or `projections` cannot — an account is
--  not a phone. Somebody signs up on their laptop and uses it on their phone;
--  filing that account under one or the other would be a made-up number.
--  So those figures stay whole-population, and the response now says which is
--  which (`meta.kind`, `users.device_scoped`) so the page can label them rather
--  than quietly showing an unfiltered number next to a filtered one.
--
--  ⚠️ Signatures change again, so both functions are DROPPED first — a defaulted
--  argument added with CREATE OR REPLACE makes a second overload and PostgREST
--  cannot then resolve the call.
--
--  ⚠️ THIS FILE IS ALSO THE REPAIR. `analytics.sql` and `002-install-tracking.sql`
--  still contain the ORIGINAL versions of admin_overview / admin_funnel /
--  admin_features / admin_installs / admin_trend / admin_users. Re-running either
--  of those — and you have a reason to, because analytics.sql is where the
--  event-name whitelist lives — will:
--    * recreate the old signatures ALONGSIDE the new ones, after which PostgREST
--      cannot tell which one the admin page means. Loud and obvious; and
--    * silently REPLACE admin_users with the old version — the one that reported
--      everybody's plan as Incomplete. Nothing errors; the page just goes back to
--      answering the question wrongly. That is the dangerous one.
--  So: **after re-running analytics.sql or 002, re-run 003 and then this file.**
--  The drops below clear every stale signature, so 003 + 005 always puts things
--  back however tangled they got.
-- =====================================================================

-- the signatures 003 introduced
drop function if exists public.admin_overview(boolean);
drop function if exists public.admin_trend(text, boolean);
-- ...and the originals from analytics.sql / 002, in case either has been re-run
drop function if exists public.admin_overview();
drop function if exists public.admin_funnel(text, text);
drop function if exists public.admin_features(text, text);
drop function if exists public.admin_installs(text, text);
drop function if exists public.admin_trend(text);


create or replace function public.admin_overview(excl boolean default false, kind text default 'all')
returns jsonb
language plpgsql stable security definer set search_path = public, auth
as $$
declare r jsonb; dev uuid[];
begin
  perform public.admin_guard();
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with ev as (
    select * from public.events e
    where not (e.device_id = any(dev))
      and (kind = 'all' or e.device_kind = kind)
  )
  select jsonb_build_object(
    'users', jsonb_build_object(
      -- ---- account-level: NOT split by device, and says so ----
      'total',       (select count(*) from auth.users),
      'new_7d',      (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'new_30d',     (select count(*) from auth.users where created_at > now() - interval '30 days'),
      'unconfirmed', (select count(*) from auth.users where email_confirmed_at is null),
      'with_plan',   (select count(*) from public.projections p
                       where (public.plan_state(p.data) ->> 'complete')::boolean),
      -- ---- event-level: split by device ----
      'active_24h',  (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '24 hours'),
      'active_7d',   (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '7 days'),
      'active_30d',  (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '30 days'),
      -- which of the above the device filter actually reached
      'device_scoped', jsonb_build_array('active_24h','active_7d','active_30d')
    ),
    'engagement', jsonb_build_object(
      'plans_created',   (select count(distinct device_id) from ev where name = 'finances_entered'),
      'plans_completed', (select count(distinct device_id) from ev where name = 'plan_completed'),
      'returning_users', (select count(*) from (
                            select user_id from ev
                            where user_id is not null
                            group by user_id having count(distinct session_id) > 1) t),
      'avg_sessions_per_user', (select round(avg(s), 1) from (
                            select count(distinct session_id) s from ev
                            where user_id is not null group by user_id) t),
      'visitors_30d',    (select count(distinct device_id) from ev
                            where occurred_at > now() - interval '30 days'),
      'sessions_30d',    (select count(distinct session_id) from ev
                            where occurred_at > now() - interval '30 days')
    ),
    'meta', jsonb_build_object(
      'kind',            kind,
      'last_event_at',   (select max(occurred_at) from ev),
      'events_total',    (select count(*) from ev),
      'devices_total',   (select count(distinct device_id) from ev),
      'excluded_devices', coalesce(array_length(dev, 1), 0)
    )
  ) into r;
  return r;
end;
$$;


-- `new_users` comes from auth.users and so is never device-scoped; the page
-- relabels that series when a filter is on rather than showing it as if it were.
create or replace function public.admin_trend(p text default '30d', excl boolean default false,
                                              kind text default 'all')
returns table (day date, visitors bigint, sessions bigint, new_users bigint, completions bigint)
language plpgsql stable security definer set search_path = public, auth
as $$
declare since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := greatest(public.period_start(p), now() - interval '180 days');
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  return query
  with days as (
    select generate_series(since::date, now()::date, interval '1 day')::date d
  ), ev as (
    select * from public.events e
    where not (e.device_id = any(dev))
      and (kind = 'all' or e.device_kind = kind)
  )
  select days.d,
         (select count(distinct e.device_id)  from ev e where e.occurred_at::date = days.d),
         (select count(distinct e.session_id) from ev e where e.occurred_at::date = days.d),
         (select count(*) from auth.users u where u.created_at::date = days.d),
         (select count(distinct e.device_id)  from ev e
           where e.occurred_at::date = days.d and e.name = 'plan_completed')
  from days order by days.d;
end;
$$;


do $$
declare f text;
begin
  foreach f in array array[
    'admin_overview(boolean,text)',
    'admin_trend(text,boolean,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
