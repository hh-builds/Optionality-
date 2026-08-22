-- =====================================================================
-- 003 — "Explore other decisions": the mortgage-vs-invest side calculator
--
-- RUN THIS WHEN THE MODULE DEPLOYS. The event-name CHECK is a whitelist:
-- until these two names are allowed, any batch of events containing one is
-- rejected wholesale, so a handful of legitimate events go missing with it.
-- Safe to re-run.
-- =====================================================================
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
  -- side calculators
  'open_mortgage',   -- opened "Mortgage or invest?"
  'edit_mortgage'    -- changed one of its inputs
));

notify pgrst, 'reload schema';
