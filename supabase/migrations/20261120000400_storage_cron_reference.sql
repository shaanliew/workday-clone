-- =====================================================================
-- Attachments bucket, hourly reminder job, reference data
-- =====================================================================

-- ---------------------------------------------------------------------
-- Private bucket for MCs and receipts. Path: <employee_id>/<file>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy "upload own attachments" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  );

create policy "read permitted attachments" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (storage.foldername(name))[1] = public.current_employee_id()::text
      or public.has_role('hr', 'finance', 'admin')
      or exists (
        select 1 from public.employees e
        where e.id::text = (storage.foldername(name))[1] and public.is_manager_of(e.id)
      )
    )
  );

create policy "delete own attachments" on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  );

-- ---------------------------------------------------------------------
-- Hourly reminders / escalation
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
select cron.schedule('workline-approval-reminders', '0 * * * *', $$select public.process_reminders()$$);

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description) values
  ('company_name',                '"Lumen Retail Pte Ltd"', 'Shown in the header'),
  ('decision_target_working_days', '2',  'Target for a decision (KPI)'),
  ('reminder_after_working_days',  '1',  'Remind the approver after this many working days'),
  ('escalate_after_working_days',  '2',  'Escalate to the approver''s manager after this many working days'),
  ('claim_late_after_days',        '90', 'Flag expense lines older than this many days')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Leave types (defaults — replace with contract figures)
-- ---------------------------------------------------------------------
insert into public.leave_types
  (code, name, description, default_days, is_paid, balance_check, prorate_for_joiners, requires_document,
   document_label, cap_includes_code, requires_exhausted_code, min_notice_days, max_consecutive_days,
   allow_half_day, color, sort_order)
values
  ('AL',  'Annual Leave',             'Paid annual leave per employment contract.',                  14, true,  true,  true,  false, null,        null, null, 7,  10,   true,  '#0875e1', 10),
  ('SL',  'Sick Leave (Outpatient)',  'Outpatient sick leave. Counts towards the hospitalisation cap.', 14, true,  true,  false, true,  'MC number', null, null, 0,  null, true,  '#e5484d', 20),
  ('HL',  'Hospitalisation Leave',    'Up to 60 days a year, inclusive of outpatient sick leave.',   60, true,  true,  false, true,  'MC / hospital memo number', 'SL', null, 0, null, false, '#c2410c', 30),
  ('CCL', 'Childcare Leave',          'For parents of Singapore citizen children under 7.',          6,  true,  true,  false, false, null,        null, null, 0,  null, true,  '#7c3aed', 40),
  ('CL',  'Compassionate Leave',      'Bereavement of an immediate family member.',                  3,  true,  true,  false, false, null,        null, null, 0,  null, false, '#475569', 50),
  ('UL',  'Unpaid Leave',             'Only after annual leave is used up. Requires approval.',      0,  false, false, false, false, null,        null, 'AL', 7, null, true,  '#94a3b8', 60)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Claim categories (defaults — replace with finance policy limits)
-- ---------------------------------------------------------------------
insert into public.claim_categories (code, name, requires_receipt, limit_per_line, gl_code, sort_order) values
  ('TRANSPORT', 'Local transport (taxi / private hire)', true,  60.00,  '6110', 10),
  ('MILEAGE',   'Mileage / parking',                     false, 80.00,  '6115', 20),
  ('MEALS',     'Meals & entertainment',                 true,  150.00, '6210', 30),
  ('TRAVEL',    'Overseas travel',                       true,  null,   '6310', 40),
  ('MEDICAL',   'Medical / dental',                      true,  100.00, '6410', 50),
  ('PHONE',     'Mobile & internet',                     true,  50.00,  '6510', 60),
  ('TRAINING',  'Training & courses',                    true,  500.00, '6610', 70),
  ('SUPPLIES',  'Office supplies',                       true,  200.00, '6710', 80)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Singapore gazetted public holidays (MOM) 2026–2027, incl. in-lieu days
-- ---------------------------------------------------------------------
insert into public.public_holidays (holiday_date, name, is_in_lieu) values
  ('2026-01-01', 'New Year''s Day', false),
  ('2026-02-17', 'Chinese New Year', false),
  ('2026-02-18', 'Chinese New Year (2nd day)', false),
  ('2026-03-21', 'Hari Raya Puasa', false),
  ('2026-04-03', 'Good Friday', false),
  ('2026-05-01', 'Labour Day', false),
  ('2026-05-27', 'Hari Raya Haji', false),
  ('2026-05-31', 'Vesak Day', false),
  ('2026-06-01', 'Vesak Day (in lieu)', true),
  ('2026-08-09', 'National Day', false),
  ('2026-08-10', 'National Day (in lieu)', true),
  ('2026-11-08', 'Deepavali', false),
  ('2026-11-09', 'Deepavali (in lieu)', true),
  ('2026-12-25', 'Christmas Day', false),
  ('2027-01-01', 'New Year''s Day', false),
  ('2027-02-06', 'Chinese New Year', false),
  ('2027-02-07', 'Chinese New Year (2nd day)', false),
  ('2027-02-08', 'Chinese New Year (in lieu)', true),
  ('2027-03-10', 'Hari Raya Puasa', false),
  ('2027-03-26', 'Good Friday', false),
  ('2027-05-01', 'Labour Day', false),
  ('2027-05-17', 'Hari Raya Haji', false),
  ('2027-05-20', 'Vesak Day', false),
  ('2027-08-09', 'National Day', false),
  ('2027-10-28', 'Deepavali', false),
  ('2027-12-25', 'Christmas Day', false)
on conflict (holiday_date) do nothing;
