-- =====================================================================
--  Future Funded — migration 008: what "Mortgage or invest?" told people
--
--  ✅ APPLIED to production 2026-08-24, confirmed by Harry. Kept for the
--     record and for rebuilding from scratch; it does not need running
--     again. Mind the re-run warnings elsewhere in this file.
--
--  Run in Supabase → SQL Editor, after 007. Safe to re-run.
--
--  The calculator reaches a verdict — overpay or invest — and until now that
--  answer was thrown away the moment the tab closed. This records it.
--
--  WHAT IS AND IS NOT SENT. The event carries three things and no money at all:
--    verdict  'overpay' | 'invest' | 'tie'
--    band     which gross return investing would need to draw level, AS A BAND
--             ('under 4%', '4-6%', '6-8%', '8% or more', 'above 30%')
--    horizon  the comparison window they chose ('5' | '10' | '20' | 'term' | 'custom')
--
--  ⚠️ The break-even rate is deliberately BANDED rather than sent as a figure.
--  It tracks the person's own mortgage rate closely enough to be a personal
--  financial detail; a band answers "how demanding was the bar" without
--  recording it. No balance, payment, contribution or spare-cash figure is sent
--  — that promise in privacy.html still holds, and the policy has been updated
--  to say that a verdict and a band are now recorded alongside the optionality age.
--
--  It fires once per session, only once somebody has actually typed their own
--  situation in: the shipped defaults reach a verdict too, and counting those
--  would tell us nothing about anybody.
--
--  No signature changes, so nothing needs dropping first.
-- =====================================================================

-- 1. Allow the name. Dropped and recreated so the list actually widens.
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
  -- side calculators: "Explore other decisions"  (004 / 007)
  'open_mortgage', 'edit_mortgage', 'mortgage_advanced',
  'mortgage_verdict'    -- the answer it gave them
));


-- 2. The breakdown
--
--    Counted by DEVICE, not by event: somebody who changes their mind twice in
--    one session should not vote twice. The most recent verdict per device wins,
--    since that is the answer they were left looking at.
create or replace function public.admin_mortgage(p text default '30d', kind text default 'all', excl boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with scoped as (
    select * from public.events e
    where e.occurred_at >= since
      and (kind = 'all' or e.device_kind = kind)
      and not (e.device_id = any(dev))
  ), latest as (
    select distinct on (s.device_id)
           s.device_id,
           s.props ->> 'verdict' as verdict,
           s.props ->> 'band'    as band,
           s.props ->> 'horizon' as horizon
    from scoped s
    where s.name = 'mortgage_verdict'
    order by s.device_id, s.occurred_at desc
  ), tot as (select count(*) n from latest)
  select jsonb_build_object(
    -- the funnel into the calculator, so the verdict count has a denominator
    'opened',   (select count(distinct device_id) from scoped where name = 'open_mortgage'),
    'edited',   (select count(distinct device_id) from scoped where name = 'edit_mortgage'),
    'answered', (select n from tot),
    'verdicts', coalesce((
      select jsonb_object_agg(v.k, v.n) from (
        select coalesce(l.verdict,'unknown') k, count(*) n from latest l group by 1) v), '{}'::jsonb),
    'bands', coalesce((
      select jsonb_object_agg(b.k, b.n) from (
        select coalesce(l.band,'unknown') k, count(*) n from latest l group by 1) b), '{}'::jsonb),
    'horizons', coalesce((
      select jsonb_object_agg(h.k, h.n) from (
        select coalesce(l.horizon,'unknown') k, count(*) n from latest l group by 1) h), '{}'::jsonb)
  ) into r;

  return r;
end;
$$;

revoke all on function public.admin_mortgage(text,text,boolean) from public, anon;
grant execute on function public.admin_mortgage(text,text,boolean) to authenticated;


-- 3. And a row in the feature list, so it sits with everything else
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
    ('mortgage_verdict',      'Got a mortgage answer'),
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
