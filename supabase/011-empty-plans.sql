-- =====================================================================
--  Future Funded — migration 011: plans that are genuinely empty
--
--  Run in Supabase → SQL Editor, after 010. Safe to re-run.
--
--  WHY THIS EXISTS
--  ---------------
--  The app no longer ships a worked example. Until now a new visitor was
--  seeded with age 35, £50,000 in an ISA, £90,000 of pension and a £43,000
--  target, and was shown a confident answer about somebody who does not
--  exist. From this release the personal figures start EMPTY and the app
--  asks for them.
--
--  That quietly breaks plan_state(). It decided a pot was "filled in" by
--  asking whether the saved figures DIFFER FROM THE SHIPPED DEFAULTS —
--  which was exactly right while every new account stored those defaults
--  verbatim. An empty plan differs from them too. Left alone, every
--  untouched plan would start reporting as filled in:
--
--    * People → Plan would tick for accounts holding nothing at all;
--    * "Complete" in the funnel would count them;
--    * admin_headline() would average a pile of nulls and zeroes into the
--      figures, destroying the one thing it is for — reporting what people
--      who actually typed their numbers in have.
--
--  So a pot is filled in when BOTH hold:
--    (a) the figures are actually THERE — a personal field is present and
--        not null; and
--    (b) they are not the legacy seed still sitting in plan_defaults.
--
--  (a) alone would count old empty-but-complete-looking blobs; (b) alone is
--  the bug above. Both together read plans from either era correctly, and
--  no stored data is touched or migrated — this is a reporting change only.
--
--  ⚠️ plan_state() is REPLACED, not dropped: same name, same single
--  argument, same return type, so there is no second overload to trap
--  PostgREST. Its callers (admin_user_detail, admin_users, admin_overview,
--  admin_headline) pick the new definition up automatically.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Has this pot actually been filled in?
--
-- "Present and not null" — NOT "greater than zero". £0 in an ISA and £0 a
-- year going in are real answers that plenty of people starting out will
-- give, and the app deliberately accepts them; counting them as blank
-- would erase exactly the users most worth hearing about. A contribution
-- counts if ANY period carries an amount, which is how the engine reads
-- them too.
-- ---------------------------------------------------------------------
create or replace function public.pot_entered(pot jsonb, balance_key text)
returns boolean
language sql immutable set search_path = public
as $$
  select pot is not null
     and jsonb_typeof(pot) = 'object'
     and (
       -- any personal figure present and non-null is enough to say somebody
       -- has started; plan_state then also requires it to differ from the seed
          jsonb_typeof(coalesce(pot -> 'currentAge',   'null'::jsonb)) = 'number'
       or jsonb_typeof(coalesce(pot -> balance_key,    'null'::jsonb)) = 'number'
       or jsonb_typeof(coalesce(pot -> 'targetIncome', 'null'::jsonb)) = 'number'
       or jsonb_typeof(coalesce(pot -> 'targetPot',    'null'::jsonb)) = 'number'
       or exists (
            select 1
            from jsonb_array_elements(
                   case when jsonb_typeof(coalesce(pot -> 'phases', '[]'::jsonb)) = 'array'
                        then pot -> 'phases' else '[]'::jsonb end) ph
            where jsonb_typeof(coalesce(ph -> 'annual', 'null'::jsonb)) = 'number')
     );
$$;

revoke all on function public.pot_entered(jsonb, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- plan_state, rewritten around the two-part test
-- ---------------------------------------------------------------------
create or replace function public.plan_state(d jsonb)
returns jsonb
language sql stable set search_path = public
as $$
  with def as (select data from public.plan_defaults where id = 1),
  cur as (
    select public.try_jsonb(d ->> 'optionality.bridge') as b,
           public.try_jsonb(d ->> 'optionality.coast')  as c
  ),
  cmp as (
    select
      (    public.pot_entered(cur.b, 'currentBalance')
       and public.jsonb_pick(cur.b, array['currentAge','currentBalance','targetIncome','phases'])
             is distinct from
           public.jsonb_pick(def.data -> 'bridge', array['currentAge','currentBalance','targetIncome','phases'])
      ) as bridge,
      (    public.pot_entered(cur.c, 'currentPension')
       and public.jsonb_pick(cur.c, array['currentAge','currentPension','targetIncome','phases'])
             is distinct from
           public.jsonb_pick(def.data -> 'coast', array['currentAge','currentPension','targetIncome','phases'])
      ) as coast,
      (cur.b is not null or cur.c is not null) as any_plan
    from cur, def
  )
  select jsonb_build_object(
    'has_plan', coalesce(any_plan, false),
    'bridge',   coalesce(bridge, false),
    'coast',    coalesce(coast, false),
    'complete', coalesce(bridge and coast, false)
  ) from cmp;
$$;

revoke all on function public.plan_state(jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- admin_headline: keep the nulls out of the averages
--
-- The figures were already scoped to filled-in pots, and the fix above
-- restores that. But a pot can now be filled in on one field and blank on
-- another — somebody who entered their balance and stopped — and averaging
-- a missing balance as £0 would drag every figure down while looking
-- perfectly healthy. agg_stat already ignores nulls; try_num already
-- returns null for anything unparseable. The one gap was plan_annual_in,
-- which coalesced a pot with no contribution figures to 0 and so reported
-- "people pay in nothing" rather than "they haven't said".
-- ---------------------------------------------------------------------
create or replace function public.plan_annual_in(pot jsonb)
returns numeric
language sql immutable set search_path = public
as $$
  select case
    -- nobody has put an amount against any period: that is silence, not zero
    when not exists (
      select 1
      from jsonb_array_elements(
             case when jsonb_typeof(coalesce(pot -> 'phases', '[]'::jsonb)) = 'array'
                  then pot -> 'phases' else '[]'::jsonb end) ph
      where jsonb_typeof(coalesce(ph -> 'annual', 'null'::jsonb)) = 'number')
    then null
    else (
      -- what they are paying in THIS year: periods stack, so it is the sum of
      -- every one whose range covers their current age — the engine's rule.
      -- A period with no ages on it runs for the whole plan, which is what the
      -- app's plain "£ a year" field means, so it always counts.
      select coalesce(sum(public.try_num(ph ->> 'annual')), 0)
      from jsonb_array_elements(
             case when jsonb_typeof(coalesce(pot -> 'phases', '[]'::jsonb)) = 'array'
                  then pot -> 'phases' else '[]'::jsonb end) ph
      where public.try_num(ph ->> 'fromAge') is null
         or public.try_num(ph ->> 'toAge') is null
         or public.try_num(pot ->> 'currentAge')
              between coalesce(public.try_num(ph ->> 'fromAge'), -1e9)
                  and coalesce(public.try_num(ph ->> 'toAge'),    1e9)
    )
  end;
$$;

revoke all on function public.plan_annual_in(jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- plan_defaults keeps the LEGACY seed, on purpose
--
-- It is no longer "what the app ships with" — the app ships with nothing.
-- It is now the fingerprint of an account created before this release that
-- was never touched, and it has to stay exactly as it is or those accounts
-- would start reading as filled in. Do not update it to match the blank
-- state; the emptiness test above is what covers new accounts.
-- ---------------------------------------------------------------------
update public.plan_defaults
   set note = 'LEGACY seed: Engine.BRIDGE_DEFAULTS / COAST_DEFAULTS as shipped '
            || 'before the blank-start release (2026-08-22). Kept to recognise '
            || 'untouched pre-release accounts — do NOT change to match the app.',
       updated_at = now()
 where id = 1;

notify pgrst, 'reload schema';
