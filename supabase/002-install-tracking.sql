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

-- PostgREST caches the function list; nudge it so the new one is callable now.
notify pgrst, 'reload schema';
