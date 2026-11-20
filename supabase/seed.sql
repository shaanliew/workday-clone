-- =====================================================================
-- Demo organisation: Lumen Retail Pte Ltd (fictional)
-- 9 staff in 4 departments + Managing Director, incl. a July 2026 joiner.
-- Every demo user signs in with password:  Workline#2026
-- !! Demo data only — delete these users before real use. !!
-- =====================================================================

insert into public.departments (code, name) values
  ('OPS', 'Operations'),
  ('FIN', 'Finance'),
  ('HR',  'Human Resources'),
  ('SAL', 'Sales')
on conflict (code) do nothing;

-- Managing Director (top of the reporting line)
insert into public.employees (employee_no, full_name, email, job_title, department_id, role, hire_date, phone)
select 'E0001', 'Grace Tan', 'grace.tan@lumen-demo.sg', 'Managing Director', d.id, 'admin', '2018-03-01', '+65 9100 0001'
from public.departments d where d.code = 'OPS'
on conflict (employee_no) do nothing;

-- Department heads (report to the MD)
insert into public.employees (employee_no, full_name, email, job_title, department_id, manager_id, role, hire_date, phone)
select v.no, v.name, v.email, v.title, d.id, (select id from public.employees where employee_no = 'E0001'), v.role::public.app_role, v.hired::date, v.phone
from (values
  ('E0002', 'Ahmad Rahman',  'ahmad.rahman@lumen-demo.sg',  'Head of Operations', 'OPS', 'employee', '2019-06-03', '+65 9100 0002'),
  ('E0004', 'Mei Ling Wong', 'meiling.wong@lumen-demo.sg',  'Head of Finance',    'FIN', 'finance',  '2020-01-06', '+65 9100 0004'),
  ('E0006', 'Sarah Ng',      'sarah.ng@lumen-demo.sg',      'HR & Office Manager','HR',  'hr',       '2019-09-02', '+65 9100 0006'),
  ('E0008', 'Jason Teo',     'jason.teo@lumen-demo.sg',     'Head of Sales',      'SAL', 'employee', '2021-02-01', '+65 9100 0008')
) as v(no, name, email, title, dept, role, hired, phone)
join public.departments d on d.code = v.dept
on conflict (employee_no) do nothing;

-- Staff
insert into public.employees (employee_no, full_name, email, job_title, department_id, manager_id, role, hire_date, phone)
select v.no, v.name, v.email, v.title, d.id, (select id from public.employees where employee_no = v.mgr), v.role::public.app_role, v.hired::date, v.phone
from (values
  ('E0003', 'Daniel Lim',    'daniel.lim@lumen-demo.sg',    'Operations Executive', 'OPS', 'E0002', 'employee', '2022-04-04', '+65 9100 0003'),
  ('E0009', 'Siti Aminah',   'siti.aminah@lumen-demo.sg',   'Store Supervisor',     'OPS', 'E0002', 'employee', '2023-08-14', '+65 9100 0009'),
  ('E0005', 'Kumar Pillai',  'kumar.pillai@lumen-demo.sg',  'Finance Executive',    'FIN', 'E0004', 'finance',  '2021-11-01', '+65 9100 0005'),
  ('E0007', 'Priya Nair',    'priya.nair@lumen-demo.sg',    'HR & Admin Assistant', 'HR',  'E0006', 'employee', '2026-07-01', '+65 9100 0007'),
  ('E0010', 'Nurul Huda',    'nurul.huda@lumen-demo.sg',    'Sales Associate',      'SAL', 'E0008', 'employee', '2024-05-02', '+65 9100 0010')
) as v(no, name, email, title, dept, mgr, role, hired, phone)
join public.departments d on d.code = v.dept
on conflict (employee_no) do nothing;

update public.departments d set head_id = e.id
from public.employees e
where (d.code, e.employee_no) in (('OPS', 'E0002'), ('FIN', 'E0004'), ('HR', 'E0006'), ('SAL', 'E0008'));

-- Sign-ins (the on_auth_user_created trigger links each one to its employee record by e-mail)
do $$
declare
  r record;
  v_uid uuid;
begin
  for r in select email from public.employees where user_id is null loop
    if exists (select 1 from auth.users where lower(email) = lower(r.email)) then
      continue;
    end if;
    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, reauthentication_token, phone_change, phone_change_token)
    values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', r.email,
      extensions.crypt('Workline#2026', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, v_uid::text,
            jsonb_build_object('sub', v_uid::text, 'email', r.email, 'email_verified', true),
            'email', now(), now(), now());
  end loop;
end $$;

-- Entitlements for 2026 (created by trigger) and 2027
select public.ensure_entitlements(id, 2027) from public.employees;
