-- =====================================================================
--  Future Funded — migration 009: user feedback
--
--  ✅ APPLIED to production 2026-08-24, confirmed by Harry. Kept for the
--     record and for rebuilding from scratch; it does not need running
--     again. Mind the re-run warnings elsewhere in this file.
--  Run in Supabase → SQL Editor, after 008. Safe to re-run.
--
--  A suggestion-box button in the top bar. Anyone can send a note — signed in
--  or not — and it lands here with the time, who they were (if anyone), and
--  enough about the device to make "the chart looks wrong" actionable.
--
--  SAME TRUST MODEL AS public.events: insert is open to the world because
--  signed-out visitors are exactly the people whose feedback we most need, and
--  SELECT is admins only. The insert policy stops a client back-dating a row or
--  attributing one to somebody else, and the CHECKs below are the defence
--  against the open endpoint being used as free storage.
-- =====================================================================

create table if not exists public.feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  device_id   uuid,
  session_id  uuid,
  message     text not null,
  contact     text,           -- optional: only if they want a reply
  device_kind text,
  props       jsonb not null default '{}'::jsonb
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_user_idx    on public.feedback (user_id, created_at desc);

-- a note has to be real, and it can't be a dumping ground
do $$ begin
  alter table public.feedback add constraint feedback_message_sane
    check (length(btrim(message)) between 2 and 4000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feedback add constraint feedback_contact_sane
    check (contact is null or length(contact) <= 200);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feedback add constraint feedback_props_small
    check (pg_column_size(props) < 2048);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feedback add constraint feedback_kind_allowed
    check (device_kind is null or device_kind in ('mobile','tablet','desktop'));
exception when duplicate_object then null; end $$;

alter table public.feedback enable row level security;

drop policy if exists "anyone may send feedback" on public.feedback;
create policy "anyone may send feedback" on public.feedback
  for insert to anon, authenticated
  with check (
    created_at > now() - interval '10 minutes'
    and created_at < now() + interval '1 minute'
    -- a signed-in client may only attribute a note to itself; an anonymous one
    -- may not attribute one to anybody
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "admins read feedback" on public.feedback;
create policy "admins read feedback" on public.feedback
  for select to authenticated using (public.is_admin());

-- No update or delete policy at all: a note cannot be edited or deleted from
-- the app, by the sender or by an admin. Clearing it out is a SQL-editor job.


-- ---------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------
create or replace function public.admin_feedback(lim int default 100, off int default 0)
returns table (
  id           bigint,
  created_at   timestamptz,
  email        text,
  contact      text,
  message      text,
  device_kind  text,
  props        jsonb,
  device_id    uuid,
  total_count  bigint
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  perform public.admin_guard();
  return query
  select f.id, f.created_at, u.email::text, f.contact, f.message, f.device_kind, f.props,
         f.device_id, (select count(*) from public.feedback)
  from public.feedback f
  left join auth.users u on u.id = f.user_id
  order by f.created_at desc
  limit greatest(1, least(lim, 500)) offset greatest(0, off);
end;
$$;

revoke all on function public.admin_feedback(int,int) from public, anon;
grant execute on function public.admin_feedback(int,int) to authenticated;


-- ---------------------------------------------------------------------
-- Allow the two new event names, so opening and sending show up in
-- Feature usage alongside everything else.
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
  'feedback_open',   -- opened the suggestion box
  'feedback_sent'    -- ...and actually sent something
));

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
    ('plan_updated',          'Returned and updated a plan'),
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
