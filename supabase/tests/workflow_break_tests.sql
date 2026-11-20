-- =====================================================================
-- "Deliberately break it" tests (Activity 1.2 / 2.2).
-- Run in the Supabase SQL editor against the seeded demo data.
-- Everything runs inside a transaction that is rolled back — nothing is saved.
-- Each row should read "BLOCKED: <clear message>".
-- =====================================================================
begin;

create or replace function pg_temp.as_user(p_email text) returns void language plpgsql security definer as $$
declare v uuid; begin
  select id into v from auth.users where email = p_email;
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.lt(p_code text) returns uuid language sql as $$ select id from public.leave_types where code = p_code $$;
create or replace function pg_temp.cat(p_code text) returns uuid language sql as $$ select id from public.claim_categories where code = p_code $$;
create or replace function pg_temp.try(p_name text, p_email text, p_sql text) returns table(test text, outcome text) language plpgsql as $$
begin
  perform pg_temp.as_user(p_email);
  begin
    execute p_sql;
    return query select p_name, 'NOT BLOCKED';
  exception when others then
    return query select p_name, 'BLOCKED: ' || sqlerrm;
  end;
end $$;

select * from pg_temp.try('1 overlap', 'daniel.lim@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-12-09', '2026-12-11')$q$)
union all select * from pg_temp.try('2 over balance', 'priya.nair@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-12-21', '2026-12-31')$q$)
union all select * from pg_temp.try('3 across years', 'daniel.lim@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-12-30', '2027-01-04')$q$)
union all select * from pg_temp.try('4 sick leave without MC', 'nurul.huda@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('SL'), '2026-11-19', '2026-11-19')$q$)
union all select * from pg_temp.try('5 unpaid before annual', 'nurul.huda@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('UL'), '2026-12-21', '2026-12-22')$q$)
union all select * from pg_temp.try('6 holiday-only day', 'daniel.lim@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-12-25', '2026-12-25')$q$)
union all select * from pg_temp.try('7 claim without receipt', 'daniel.lim@lumen-demo.sg', $q$select public.submit_claim('Lunch', jsonb_build_array(jsonb_build_object('expense_date','2026-11-18','category_id',pg_temp.cat('MEALS'),'description','Team lunch','amount',45)), true)$q$)
union all select * from pg_temp.try('8 claim without declaration', 'daniel.lim@lumen-demo.sg', $q$select public.submit_claim('Lunch', jsonb_build_array(jsonb_build_object('expense_date','2026-11-18','category_id',pg_temp.cat('MEALS'),'description','Team lunch','amount',45,'receipt_no','R-1')), false)$q$)
union all select * from pg_temp.try('9 reject without remark', 'ahmad.rahman@lumen-demo.sg', $q$select public.decide_leave_request((select id from public.leave_requests where reference='LV-2026-0004'), 'reject', '  ')$q$)
union all select * from pg_temp.try('10 pay without reference', 'kumar.pillai@lumen-demo.sg', $q$select public.pay_claims(array[(select id from public.claims where reference='CL-2026-0002')], '2026-11-25', '')$q$)
union all select * from pg_temp.try('11 wrong approver', 'jason.teo@lumen-demo.sg', $q$select public.decide_leave_request((select id from public.leave_requests where reference='LV-2026-0004'), 'approve', null)$q$)
union all select * from pg_temp.try('12 pay a claim not yet approved', 'kumar.pillai@lumen-demo.sg', $q$select public.pay_claims(array[(select id from public.claims where reference='CL-2026-0002')], '2026-11-25', 'PAYROLL-2026-11')$q$)
union all select * from pg_temp.try('13 non-finance pays', 'daniel.lim@lumen-demo.sg', $q$select public.pay_claims(array[(select id from public.claims where reference='CL-2026-0001')], '2026-11-25', 'X')$q$)
union all select * from pg_temp.try('14 duplicate receipt', 'nurul.huda@lumen-demo.sg', $q$select public.submit_claim('Again', jsonb_build_array(jsonb_build_object('expense_date','2026-11-04','category_id',pg_temp.cat('TRANSPORT'),'description','Grab','amount',28.4,'receipt_no','grb-88213')), true)$q$)
union all select * from pg_temp.try('15 half day across dates', 'daniel.lim@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-12-14', '2026-12-15', 'AM')$q$)
union all select * from pg_temp.try('16 before hire date', 'priya.nair@lumen-demo.sg', $q$select public.submit_leave_request(pg_temp.lt('AL'), '2026-06-15', '2026-06-16')$q$)
union all select * from pg_temp.try('17 future expense', 'daniel.lim@lumen-demo.sg', $q$select public.submit_claim('Future', jsonb_build_array(jsonb_build_object('expense_date','2099-12-18','category_id',pg_temp.cat('MILEAGE'),'description','Parking','amount',5)), true)$q$);

rollback;
