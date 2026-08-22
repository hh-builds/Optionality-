-- =====================================================================
--  Future Funded — migration 010
--    (a) a done/not-done tracker on feedback, with a filter
--    (b) headline figures aggregated across people who actually typed
--        their own numbers in
--
--  Run in Supabase → SQL Editor, after 009. Safe to re-run.
--
--  ⚠️ admin_feedback CHANGES SIGNATURE (a filter argument), so it is dropped
--  before being recreated — a defaulted argument added with CREATE OR REPLACE
--  leaves a second overload that PostgREST cannot resolve.
-- =====================================================================

drop function if exists public.admin_feedback(int, int);


-- ---------------------------------------------------------------------
-- 1. THE TRACKER
--
--    ⚠️ public.feedback still has NO update policy, deliberately: the message
--    a person wrote must not be editable from the app by anyone, including an
--    admin. Marking one done is therefore done through a SECURITY DEFINER
--    function that touches ONLY these two columns — the note itself stays
--    exactly as it was sent.
-- ---------------------------------------------------------------------
alter table public.feedback add column if not exists done_at timestamptz;
alter table public.feedback add column if not exists done_by uuid references auth.users(id) on delete set null;
create index if not exists feedback_done_idx on public.feedback (done_at);

create or replace function public.admin_feedback_done(fid bigint, done boolean default true)
returns jsonb
language plpgsql volatile security definer set search_path = public, auth
as $$
declare r record;
begin
  perform public.admin_guard();
  update public.feedback f
     set done_at = case when done then now() else null end,
         done_by = case when done then auth.uid() else null end
   where f.id = fid
  returning f.id, f.done_at into r;
  if not found then
    raise exception 'no feedback with id %', fid using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', r.id, 'done_at', r.done_at, 'done', r.done_at is not null);
end;
$$;

revoke all on function public.admin_feedback_done(bigint, boolean) from public, anon;
grant execute on function public.admin_feedback_done(bigint, boolean) to authenticated;


-- filter: all | open | done   (total_count is the count for THAT filter, so the
-- pager and the tab badge agree with what is on screen)
create or replace function public.admin_feedback(lim int default 100, off int default 0,
                                                 filter text default 'all')
returns table (
  id           bigint,
  created_at   timestamptz,
  email        text,
  contact      text,
  message      text,
  device_kind  text,
  props        jsonb,
  device_id    uuid,
  done_at      timestamptz,
  done_by      text,
  total_count  bigint,
  open_count   bigint
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  perform public.admin_guard();
  return query
  with scoped as (
    select * from public.feedback f
    where case filter
            when 'open' then f.done_at is null
            when 'done' then f.done_at is not null
            else true
          end
  )
  select s.id, s.created_at, u.email::text, s.contact, s.message, s.device_kind, s.props,
         s.device_id, s.done_at, du.email::text,
         (select count(*) from scoped),
         (select count(*) from public.feedback f2 where f2.done_at is null)
  from scoped s
  left join auth.users u  on u.id = s.user_id
  left join auth.users du on du.id = s.done_by
  order by (s.done_at is not null), s.created_at desc
  limit greatest(1, least(lim, 500)) offset greatest(0, off);
end;
$$;

revoke all on function public.admin_feedback(int,int,text) from public, anon;
grant execute on function public.admin_feedback(int,int,text) to authenticated;


-- ---------------------------------------------------------------------
-- 2. HEADLINE FIGURES
--
--    ⚠️ THE WHOLE POINT: only plans somebody has actually TYPED IN.
--    A new account is seeded from whatever is in the browser, so anyone who
--    signed up without touching the planners stores the shipped defaults
--    verbatim. Averaging those in tells you what the app ships with, not what
--    anybody has. plan_state() already knows which pots differ from the
--    defaults, and each figure is aggregated only over the plans where ITS pot
--    was filled in — so the pension average isn't diluted by people who only
--    ever filled in the ISA side.
--
--    Suppressed below 5, like the medians it replaces. privacy.html promises
--    that, and this reads the same rows.
-- ---------------------------------------------------------------------

-- a cast that cannot throw: one malformed blob must not take the section down
create or replace function public.try_num(t text)
returns numeric
language plpgsql immutable
as $$
begin
  return nullif(btrim(t), '')::numeric;
exception when others then
  return null;
end;
$$;

-- What they are paying in THIS year: phases stack, so it is the sum of every
-- phase whose range covers their current age — the same rule the engine uses.
create or replace function public.plan_annual_in(pot jsonb)
returns numeric
language sql immutable set search_path = public
as $$
  select coalesce(sum(public.try_num(ph ->> 'annual')), 0)
  from jsonb_array_elements(case when jsonb_typeof(coalesce(pot -> 'phases', '[]'::jsonb)) = 'array'
                                 then pot -> 'phases' else '[]'::jsonb end) ph
  where public.try_num(pot ->> 'currentAge')
          between coalesce(public.try_num(ph ->> 'fromAge'), -1e9)
              and coalesce(public.try_num(ph ->> 'toAge'),    1e9);
$$;

create or replace function public.agg_stat(vals numeric[])
returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'n',      count(v),
    'median', percentile_cont(0.5) within group (order by v),
    'mean',   round(avg(v), 0)
  ) from unnest(vals) v where v is not null;
$$;

create or replace function public.admin_headline()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; thresh constant int := 5;
begin
  perform public.admin_guard();

  -- ⚠️ A CTE, not a temp table: a STABLE function may not CREATE TABLE, and
  -- making this VOLATILE to allow one would be a lie about a read-only report.
  with hl as (
    select public.try_jsonb(p.data ->> 'optionality.bridge')      as bridge,
           public.try_jsonb(p.data ->> 'optionality.coast')       as coast,
           (public.plan_state(p.data) ->> 'bridge')::boolean      as b_filled,
           (public.plan_state(p.data) ->> 'coast')::boolean       as c_filled
    from public.projections p
  ), c as (
    select count(*) filter (where b_filled)               as nb,
           count(*) filter (where c_filled)               as nc,
           count(*) filter (where b_filled or c_filled)   as nany,
           count(*) filter (where b_filled and c_filled)  as nboth,
           count(*)                                       as nplans
    from hl
  )
  select case when c.nany < thresh then
    jsonb_build_object('suppressed', true, 'n', c.nany, 'threshold', thresh,
                       'n_bridge', c.nb, 'n_coast', c.nc, 'n_plans', c.nplans)
  else
    jsonb_build_object(
      'suppressed', false, 'threshold', thresh,
      'n', c.nany, 'n_bridge', c.nb, 'n_coast', c.nc, 'n_both', c.nboth,
      'n_plans', c.nplans,
      'current_age',   (select public.agg_stat(array_agg(public.try_num(bridge ->> 'currentAge')))
                          from hl where b_filled),
      'isa_gia',       (select public.agg_stat(array_agg(public.try_num(bridge ->> 'currentBalance')))
                          from hl where b_filled),
      'target_income', (select public.agg_stat(array_agg(public.try_num(bridge ->> 'targetIncome')))
                          from hl where b_filled),
      'bridge_in',     (select public.agg_stat(array_agg(public.plan_annual_in(bridge)))
                          from hl where b_filled),
      'pension',       (select public.agg_stat(array_agg(public.try_num(coast ->> 'currentPension')))
                          from hl where c_filled),
      'pension_in',    (select public.agg_stat(array_agg(public.plan_annual_in(coast)))
                          from hl where c_filled),
      -- both pots together, only where BOTH sides were filled in, or it reads
      -- as "people have no pension"
      'wealth',        (select public.agg_stat(array_agg(
                            coalesce(public.try_num(bridge ->> 'currentBalance'), 0)
                          + coalesce(public.try_num(coast  ->> 'currentPension'), 0)))
                          from hl where b_filled and c_filled),
      'paying_in',     (select public.agg_stat(array_agg(
                            public.plan_annual_in(bridge) + public.plan_annual_in(coast)))
                          from hl where b_filled and c_filled)
    )
  end into r from c;

  return r;
end;
$$;

revoke all on function public.admin_headline()          from public, anon;
revoke all on function public.try_num(text)             from public, anon, authenticated;
revoke all on function public.plan_annual_in(jsonb)     from public, anon, authenticated;
revoke all on function public.agg_stat(numeric[])       from public, anon, authenticated;
grant execute on function public.admin_headline() to authenticated;

notify pgrst, 'reload schema';
