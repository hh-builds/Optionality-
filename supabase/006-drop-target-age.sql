-- =====================================================================
--  Future Funded — migration 006: drop the "target optionality age" field
--  Run in Supabase → SQL Editor, after 005. Safe to re-run.
--  COSMETIC ONLY — nothing breaks without it; the admin just shows two
--  readouts that can never move again.
--
--  The field was display-only: it compared the age you typed against the
--  computed crossover and fed nothing into any projection, so it has been
--  removed from the app.
--
--  'edit_target_age' stays in the event-name CHECK on purpose — dropping
--  it would invalidate any rows already recorded under that name.
--
--  Signatures below match 003-admin-v2 (the `excl` own-devices filter).
-- =====================================================================

-- 1. Medians: stop reporting a field that no longer exists
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
      nullif((bridge ->> 'currentAge'), '')::numeric     as current_age
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
      nullif((bridge ->> 'currentAge'), '')::numeric     as current_age
    from plans
  )
  select jsonb_build_object(
    'n', n,
    'median_target_income', percentile_cont(0.5) within group (order by target_income),
    'median_isa_gia',       percentile_cont(0.5) within group (order by isa_gia),
    'median_pension',       percentile_cont(0.5) within group (order by pension),
    'median_current_age',   percentile_cont(0.5) within group (order by current_age)
  ) into r from vals;

  return r;
end;
$$;

revoke all on function public.admin_model_medians() from public, anon;
grant execute on function public.admin_model_medians() to authenticated;


-- 2. Feature usage: drop the row that can never move again
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
