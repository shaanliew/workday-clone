-- =====================================================================
-- Identity helpers, sign-in linking, row level security
-- =====================================================================

-- Today's date in Singapore (the business calendar)
create or replace function public.sg_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Singapore')::date $$;

-- The employee record linked to the signed-in user
create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from public.employees e
  where e.user_id = auth.uid() and e.is_active
  limit 1
$$;

create or replace function public.has_role(variadic roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    where e.user_id = auth.uid() and e.is_active and e.role = any (roles)
  )
$$;

-- True when the signed-in user sits above the employee in the reporting line
-- (direct manager, skip-level, ... up to 6 levels) or heads their department.
create or replace function public.is_manager_of(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive me as (
    select public.current_employee_id() as id
  ),
  chain as (
    select e.manager_id, 1 as lvl from public.employees e where e.id = p_employee
    union all
    select e.manager_id, c.lvl + 1
    from chain c join public.employees e on e.id = c.manager_id
    where c.lvl < 6 and c.manager_id is not null
  )
  select (select id from me) is not null and (
    exists (select 1 from chain where manager_id = (select id from me))
    or exists (
      select 1 from public.employees e
      join public.departments d on d.id = e.department_id
      where e.id = p_employee and d.head_id = (select id from me) and e.id <> (select id from me)
    )
  )
$$;

-- Link sign-ins to staff records: a new auth user is attached to the
-- employee record with the same work e-mail. Nobody can "pick a name".
create or replace function public.link_auth_user_to_employee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.employees
     set user_id = new.id
   where lower(email) = lower(new.email)
     and user_id is null;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_auth_user_to_employee();

-- ---------------------------------------------------------------------
-- Row level security
-- Writes to requests, claims, ledger, audit and notifications happen
-- only through the SECURITY DEFINER functions in the workflow migration,
-- so those tables get SELECT policies only.
-- ---------------------------------------------------------------------
alter table public.departments        enable row level security;
alter table public.employees          enable row level security;
alter table public.public_holidays    enable row level security;
alter table public.leave_types        enable row level security;
alter table public.claim_categories   enable row level security;
alter table public.app_settings       enable row level security;
alter table public.leave_entitlements enable row level security;
alter table public.leave_requests     enable row level security;
alter table public.leave_ledger       enable row level security;
alter table public.claims             enable row level security;
alter table public.claim_lines        enable row level security;
alter table public.audit_log          enable row level security;
alter table public.notifications      enable row level security;

-- Reference data: readable by every signed-in user, maintained by HR / admin
create policy "read departments" on public.departments for select to authenticated using (true);
create policy "hr manages departments" on public.departments for all to authenticated
  using (public.has_role('hr', 'admin')) with check (public.has_role('hr', 'admin'));

create policy "read holidays" on public.public_holidays for select to authenticated using (true);
create policy "hr manages holidays" on public.public_holidays for all to authenticated
  using (public.has_role('hr', 'admin')) with check (public.has_role('hr', 'admin'));

create policy "read leave types" on public.leave_types for select to authenticated using (true);
create policy "hr manages leave types" on public.leave_types for all to authenticated
  using (public.has_role('hr', 'admin')) with check (public.has_role('hr', 'admin'));

create policy "read claim categories" on public.claim_categories for select to authenticated using (true);
create policy "finance manages claim categories" on public.claim_categories for all to authenticated
  using (public.has_role('finance', 'admin')) with check (public.has_role('finance', 'admin'));

create policy "read settings" on public.app_settings for select to authenticated using (true);
create policy "admin manages settings" on public.app_settings for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Worker directory is visible to all staff; HR / admin maintain it
create policy "read directory" on public.employees for select to authenticated using (true);
create policy "hr inserts employees" on public.employees for insert to authenticated
  with check (public.has_role('hr', 'admin'));
create policy "hr updates employees" on public.employees for update to authenticated
  using (public.has_role('hr', 'admin')) with check (public.has_role('hr', 'admin'));
create policy "admin deletes employees" on public.employees for delete to authenticated
  using (public.has_role('admin'));

-- Entitlements: own, line managers, HR
create policy "read entitlements" on public.leave_entitlements for select to authenticated
  using (employee_id = public.current_employee_id() or public.is_manager_of(employee_id) or public.has_role('hr', 'admin'));
create policy "hr manages entitlements" on public.leave_entitlements for all to authenticated
  using (public.has_role('hr', 'admin')) with check (public.has_role('hr', 'admin'));

-- Leave requests: applicant, assigned / escalated approver, management chain, HR
create policy "read leave requests" on public.leave_requests for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or approver_id = public.current_employee_id()
    or escalated_to = public.current_employee_id()
    or public.is_manager_of(employee_id)
    or public.has_role('hr', 'admin')
  );

-- Master Leave Record
create policy "read leave ledger" on public.leave_ledger for select to authenticated
  using (employee_id = public.current_employee_id() or public.is_manager_of(employee_id) or public.has_role('hr', 'admin'));

-- Claims: claimant, approver, management chain, Finance
create policy "read claims" on public.claims for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or approver_id = public.current_employee_id()
    or escalated_to = public.current_employee_id()
    or public.is_manager_of(employee_id)
    or public.has_role('finance', 'admin')
  );
create policy "read claim lines" on public.claim_lines for select to authenticated
  using (exists (select 1 from public.claims c where c.id = claim_id));   -- inherits claims RLS

-- Audit trail follows visibility of the underlying record
create policy "read audit trail" on public.audit_log for select to authenticated
  using (
    public.has_role('hr', 'admin')
    or (entity_type = 'leave' and exists (select 1 from public.leave_requests r where r.id = entity_id))
    or (entity_type = 'claim' and exists (select 1 from public.claims c where c.id = entity_id))
  );

-- Notifications: own only; users may only mark them read
create policy "read own notifications" on public.notifications for select to authenticated
  using (recipient_id = public.current_employee_id());
create policy "mark own notifications read" on public.notifications for update to authenticated
  using (recipient_id = public.current_employee_id()) with check (recipient_id = public.current_employee_id());
revoke update on public.notifications from authenticated, anon;
grant update (read_at) on public.notifications to authenticated;

-- Nothing is exposed to anonymous visitors
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------------
-- Balances view (runs with the caller's RLS)
-- taken  = approved days in the Master Leave Record (incl. capped types,
--          e.g. hospitalisation cap also counts sick leave)
-- pending = days awaiting approval
-- ---------------------------------------------------------------------
create or replace view public.leave_balances
with (security_invoker = true) as
select
  le.employee_id,
  le.year,
  lt.id   as leave_type_id,
  lt.code,
  lt.name,
  lt.color,
  lt.balance_check,
  lt.sort_order,
  le.entitled_days,
  le.carried_forward,
  le.adjustment,
  (le.entitled_days + le.carried_forward + le.adjustment) as total_entitlement,
  coalesce(t.taken, 0)   as taken,
  coalesce(p.pending, 0) as pending,
  (le.entitled_days + le.carried_forward + le.adjustment) - coalesce(t.taken, 0) as remaining,
  (le.entitled_days + le.carried_forward + le.adjustment) - coalesce(t.taken, 0) - coalesce(p.pending, 0) as available
from public.leave_entitlements le
join public.leave_types lt on lt.id = le.leave_type_id
left join lateral (
  select sum(l.days) as taken
  from public.leave_ledger l
  join public.leave_types t2 on t2.id = l.leave_type_id
  where l.employee_id = le.employee_id and l.year = le.year
    and (t2.id = lt.id or t2.code = lt.cap_includes_code)
) t on true
left join lateral (
  select sum(r.days) as pending
  from public.leave_requests r
  join public.leave_types t3 on t3.id = r.leave_type_id
  where r.employee_id = le.employee_id and r.year = le.year and r.status = 'pending'
    and (t3.id = lt.id or t3.code = lt.cap_includes_code)
) p on true;

grant select on public.leave_balances to authenticated;
