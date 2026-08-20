-- =====================================================================
--  Future Funded — migration 002: install ("add to home screen") tracking
--  Run this ONCE in Supabase → SQL Editor, after analytics.sql.
--  Safe to re-run.
--
--  Why a migration rather than just re-running analytics.sql: the event-name
--  CHECK was added with an "ignore if it already exists" guard, so re-running
--  that file would NOT widen it. This drops and recreates it, and analytics.sql
--  has been changed to do the same so future name changes are just a re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Widen the allowed event names
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
  -- install / "add to home screen"
  'install_click',      -- tapped Install app in the menu (intent)
  'install_prompted',   -- the browser's own install dialog was shown
  'install_accepted',   -- ...and accepted
  'install_dismissed',  -- ...and dismissed
  'install_help',       -- no native dialog available, so we showed written steps
  'app_installed',      -- Chromium's appinstalled event fired
  'app_launch'          -- a session that started in standalone mode (installed and in use)
));


-- ---------------------------------------------------------------------
-- 2. Install funnel + usage
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

revoke all on function public.admin_installs(text,text) from public, anon;
grant execute on function public.admin_installs(text,text) to authenticated;


-- ---------------------------------------------------------------------
-- 3. Show the install steps in the feature-usage list too
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

revoke all on function public.admin_features(text,text) from public, anon;
grant execute on function public.admin_features(text,text) to authenticated;



-- ---------------------------------------------------------------------
-- 4. FIX: "Plan: Incomplete" for people who plainly have a plan
--
--    plan_completed fires ONCE PER DEVICE, and it is attributed to whoever is
--    signed in at that instant. Anyone who built their plan before signing in
--    — which is the normal order in this product, since the account exists to
--    SAVE a plan you already made — has the event on their device but with no
--    user_id, so a per-user lookup found nothing and reported Incomplete.
--
--    Credit the user with any plan completed on a device they have signed in
--    on. Retroactive, so it fixes existing rows with no client change.
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
  ), completed_devices as (
    -- column names deliberately NOT user_id/device_id: this function has OUT
    -- parameters with those names, and an unqualified reference is ambiguous
    select distinct e.device_id as did from public.events e where e.name = 'plan_completed'
  ), user_devices as (
    select distinct e.user_id as uid, e.device_id as did
    from public.events e where e.user_id is not null
  ), device_credit as (
    select ud.uid from user_devices ud
    join completed_devices cd on cd.did = ud.did
    group by ud.uid
  ), rows as (
    select u.id,
           u.email::text,
           coalesce(u.raw_user_meta_data ->> 'full_name', '')  as display_name,
           u.created_at,
           (u.email_confirmed_at is not null)                  as confirmed,
           a.last_active,
           coalesce(a.sessions, 0)                             as sessions,
           (coalesce(a.plan_complete, false)
             or exists (select 1 from device_credit dc where dc.uid = u.id)) as plan_complete,
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
    left join agg a                on a.user_id = u.id
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

revoke all on function public.admin_users(text,text,text,text,int,int) from public, anon;
grant execute on function public.admin_users(text,text,text,text,int,int) to authenticated;

-- PostgREST caches the function list; nudge it so the new ones are callable now.
notify pgrst, 'reload schema';
