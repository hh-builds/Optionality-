-- =====================================================================
--  Future Funded — migration 007: report the mortgage module's usage
--  Run in Supabase → SQL Editor, after 006. Safe to re-run.
--
--  `open_mortgage` and `edit_mortgage` have been firing since the module
--  shipped (004 widened the CHECK so they are accepted), but nothing ever
--  displayed them — admin_features works off a fixed list of names, and they
--  were not on it. The events were being collected and thrown away.
--
--  Also adds `mortgage_advanced`. The module's "Adjust assumptions" panel was
--  firing `open_advanced`, the same name the two planners use, so one row
--  labelled "Opened advanced assumptions" was silently counting two different
--  things and there was no way to separate them again afterwards.
--
--  ⚠️ A NOTE ON "% of active". That column is against devices that fired
--  `finances_entered` in the window — people who got as far as entering their
--  own figures. The mortgage module can be reached without doing that, since it
--  seeds its own defaults, so these three rows can in principle read above 100%.
--  `install_click` and `app_launch` have always had the same property. Read the
--  device count, not the percentage, for anything reachable without a plan.
--
--  No signature changes here, so nothing needs dropping first.
-- =====================================================================

-- 1. Allow the new name. Dropped and recreated so the list actually widens.
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
  -- install / "add to home screen"  (002-install-tracking.sql)
  'install_click', 'install_prompted', 'install_accepted', 'install_dismissed',
  'install_help', 'app_installed', 'app_launch',
  -- side calculators: "Explore other decisions"  (004-mortgage-module.sql)
  'open_mortgage',      -- opened "Mortgage or invest?"
  'edit_mortgage',      -- changed one of its inputs
  'mortgage_advanced'   -- opened its own assumptions panel
));
-- 'edit_target_age' stays on the list even though the field is gone: dropping a
-- name would invalidate rows already recorded under it.


-- 2. Put the three rows in the feature list
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
    ('sooner_levers',         'Used "get me there sooner"'),
    ('units_toggle',          'Switched today''s money / nominal'),
    ('export_csv',            'Exported CSV'),
    ('plan_updated',          'Returned and updated a plan'),
    ('open_mortgage',         'Opened "Mortgage or invest?"'),
    ('edit_mortgage',         'Changed a mortgage input'),
    ('mortgage_advanced',     'Opened the mortgage assumptions'),
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
