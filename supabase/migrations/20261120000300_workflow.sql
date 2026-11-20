-- =====================================================================
-- Workflow logic: validation, routing, approvals, Master Leave Record,
-- claims, payments, reminders / escalation.
-- All writes go through these functions so every rule is enforced in
-- the database, whatever client calls it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small utilities
-- ---------------------------------------------------------------------
create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = p_key), p_default)
$$;

-- Working days between two dates (inclusive), excluding weekends and
-- gazetted public holidays. Half day = 0.5 when that date is a working day.
create or replace function public.count_working_days(p_start date, p_end date, p_half text default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_start is null or p_end is null or p_end < p_start then 0::numeric
    else (
      select count(*)::numeric * case when p_half is not null then 0.5 else 1 end
      from generate_series(p_start, p_end, interval '1 day') g(d)
      where extract(isodow from g.d) < 6
        and not exists (select 1 from public.public_holidays h where h.holiday_date = g.d::date)
    )
  end
$$;

create or replace function public._notify(
  p_recipient uuid, p_kind text, p_title text, p_body text,
  p_link text, p_entity_type text, p_entity_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (recipient_id, kind, title, body, link, entity_type, entity_id)
  select p_recipient, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id
  where p_recipient is not null
$$;

create or replace function public._notify_role(
  p_role public.app_role, p_kind text, p_title text, p_body text,
  p_link text, p_entity_type text, p_entity_id uuid, p_exclude uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (recipient_id, kind, title, body, link, entity_type, entity_id)
  select e.id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id
  from public.employees e
  where e.role = p_role and e.is_active and (p_exclude is null or e.id <> p_exclude)
$$;

create or replace function public._audit(
  p_entity_type text, p_entity_id uuid, p_action text, p_actor uuid,
  p_from text, p_to text, p_remark text, p_meta jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (entity_type, entity_id, action, actor_id, from_status, to_status, remark, meta)
  values (p_entity_type, p_entity_id, p_action, p_actor, p_from, p_to, p_remark, coalesce(p_meta, '{}'))
$$;

create or replace function public._require_employee()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.current_employee_id();
begin
  if v_me is null then
    raise exception 'Your sign-in is not linked to an active employee record. Please contact HR.';
  end if;
  return v_me;
end;
$$;

-- Approver routing: line manager; if none, the department head (never yourself).
create or replace function public._approver_for(p_employee uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.id from public.employees e join public.employees m on m.id = e.manager_id
      where e.id = p_employee and m.is_active),
    (select d.head_id from public.employees e join public.departments d on d.id = e.department_id
      join public.employees h on h.id = d.head_id
      where e.id = p_employee and d.head_id <> p_employee and h.is_active)
  )
$$;

-- ---------------------------------------------------------------------
-- Entitlements (contract entitlement, pro-rated in the year of joining)
-- ---------------------------------------------------------------------
create or replace function public.ensure_entitlements(p_employee uuid, p_year int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hire date;
begin
  select hire_date into v_hire from public.employees where id = p_employee;
  if v_hire is null then
    return;
  end if;

  insert into public.leave_entitlements (employee_id, leave_type_id, year, entitled_days, note)
  select p_employee, lt.id, p_year,
         case
           when extract(year from v_hire)::int > p_year then 0
           when lt.prorate_for_joiners and extract(year from v_hire)::int = p_year
             then round(lt.default_days * (13 - extract(month from v_hire)) / 12.0)
           else lt.default_days
         end,
         case
           when lt.prorate_for_joiners and extract(year from v_hire)::int = p_year
             then format('Pro-rated: joined %s', to_char(v_hire, 'DD Mon YYYY'))
         end
  from public.leave_types lt
  where lt.is_active
  on conflict (employee_id, leave_type_id, year) do nothing;
end;
$$;

create or replace function public.employees_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_entitlements(new.id, extract(year from public.sg_today())::int);
  return new;
end;
$$;

create trigger employees_entitlements
  after insert on public.employees
  for each row execute function public.employees_after_insert();

-- Self-service: make sure my entitlement rows exist for a year
create or replace function public.ensure_my_entitlements(p_year int default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_employee();
begin
  perform public.ensure_entitlements(v_me, coalesce(p_year, extract(year from public.sg_today())::int));
end;
$$;

-- HR: generate entitlement rows for every active employee for a year
create or replace function public.hr_generate_entitlements(p_year int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_employee();
  v_count int := 0;
  r record;
begin
  if not public.has_role('hr', 'admin') then
    raise exception 'Only HR can generate entitlements.';
  end if;
  for r in select id from public.employees where is_active loop
    perform public.ensure_entitlements(r.id, p_year);
    v_count := v_count + 1;
  end loop;
  perform public._audit('entitlement', null, 'generated', v_me, null, null, null, jsonb_build_object('year', p_year, 'employees', v_count));
  return v_count;
end;
$$;

-- HR: set contract entitlement / carry forward / adjustment (audited)
create or replace function public.hr_set_entitlement(
  p_employee_id uuid, p_leave_type_id uuid, p_year int,
  p_entitled_days numeric, p_carried_forward numeric default 0,
  p_adjustment numeric default 0, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_employee();
  v_old public.leave_entitlements%rowtype;
begin
  if not public.has_role('hr', 'admin') then
    raise exception 'Only HR can change leave entitlements.';
  end if;
  if p_entitled_days is null or p_entitled_days < 0 then
    raise exception 'Entitlement must be zero or more days.';
  end if;
  if p_entitled_days * 2 <> round(p_entitled_days * 2) then
    raise exception 'Entitlements are recorded in half-day steps.';
  end if;

  select * into v_old from public.leave_entitlements
   where employee_id = p_employee_id and leave_type_id = p_leave_type_id and year = p_year;

  insert into public.leave_entitlements (employee_id, leave_type_id, year, entitled_days, carried_forward, adjustment, note, updated_by, updated_at)
  values (p_employee_id, p_leave_type_id, p_year, p_entitled_days, coalesce(p_carried_forward, 0), coalesce(p_adjustment, 0), p_note, v_me, now())
  on conflict (employee_id, leave_type_id, year) do update
    set entitled_days = excluded.entitled_days,
        carried_forward = excluded.carried_forward,
        adjustment = excluded.adjustment,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = now();

  perform public._audit('entitlement', p_employee_id, 'entitlement_set', v_me, null, null, p_note,
    jsonb_build_object('leave_type_id', p_leave_type_id, 'year', p_year,
      'before', jsonb_build_object('entitled', v_old.entitled_days, 'carried', v_old.carried_forward, 'adjustment', v_old.adjustment),
      'after',  jsonb_build_object('entitled', p_entitled_days, 'carried', p_carried_forward, 'adjustment', p_adjustment)));
end;
$$;

-- ---------------------------------------------------------------------
-- Balance position for one type (handles capped types, e.g. the
-- hospitalisation cap also counts sick leave taken)
-- ---------------------------------------------------------------------
create or replace function public._leave_position(
  p_employee uuid, p_type uuid, p_year int, p_exclude uuid default null,
  out total numeric, out taken numeric, out pending numeric, out available numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type public.leave_types%rowtype;
begin
  select * into v_type from public.leave_types where id = p_type;

  select coalesce(le.entitled_days + le.carried_forward + le.adjustment, 0) into total
    from public.leave_entitlements le
   where le.employee_id = p_employee and le.leave_type_id = p_type and le.year = p_year;
  total := coalesce(total, 0);

  select coalesce(sum(l.days), 0) into taken
    from public.leave_ledger l join public.leave_types t on t.id = l.leave_type_id
   where l.employee_id = p_employee and l.year = p_year
     and (t.id = p_type or t.code = v_type.cap_includes_code);

  select coalesce(sum(r.days), 0) into pending
    from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
   where r.employee_id = p_employee and r.year = p_year and r.status = 'pending'
     and (p_exclude is null or r.id <> p_exclude)
     and (t.id = p_type or t.code = v_type.cap_includes_code);

  available := total - taken - pending;
end;
$$;

-- ---------------------------------------------------------------------
-- Leave validation (shared by preview, submit and approve)
-- errors block; flags are shown to the approver
-- ---------------------------------------------------------------------
create or replace function public._evaluate_leave(
  p_employee uuid, p_type uuid, p_start date, p_end date,
  p_half text, p_document_ref text, p_exclude uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp       public.employees%rowtype;
  v_type      public.leave_types%rowtype;
  v_capper    public.leave_types%rowtype;
  v_first     public.leave_types%rowtype;
  v_errors    text[] := '{}';
  v_flags     text[] := '{}';
  v_notes     text[] := '{}';
  v_days      numeric := 0;
  v_year      int;
  v_today     date := public.sg_today();
  v_pos       record;
  v_cap       record;
  v_first_pos record;
  v_overlap   record;
  v_clashes   jsonb := '[]';
  v_approver  uuid;
  v_appr_name text;
begin
  select * into v_emp from public.employees where id = p_employee;
  if not found then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('Employee record not found.'),
                              'flags', '[]'::jsonb, 'notes', '[]'::jsonb, 'days', 0);
  end if;

  select * into v_type from public.leave_types where id = p_type and is_active;
  if not found then
    v_errors := array_append(v_errors, 'Choose a valid leave type.');
  end if;

  if p_start is null or p_end is null then
    v_errors := array_append(v_errors, 'Start and end dates are required.');
  else
    if p_end < p_start then
      v_errors := array_append(v_errors, 'End date must be on or after the start date.');
    end if;
    if extract(year from p_start) <> extract(year from p_end) then
      v_errors := array_append(v_errors, 'Leave cannot span two calendar years — submit one request per year.');
    end if;
    if p_start < v_emp.hire_date then
      v_errors := array_append(v_errors, format('Leave cannot start before your hire date (%s).', to_char(v_emp.hire_date, 'DD Mon YYYY')));
    end if;
  end if;

  if p_half is not null then
    if p_half not in ('AM', 'PM') then
      v_errors := array_append(v_errors, 'Half day must be AM or PM.');
    elsif p_start is distinct from p_end then
      v_errors := array_append(v_errors, 'A half-day request must start and end on the same date.');
    elsif v_type.id is not null and not v_type.allow_half_day then
      v_errors := array_append(v_errors, format('%s cannot be taken as a half day.', v_type.name));
    end if;
  end if;

  if array_length(v_errors, 1) > 0 then
    return jsonb_build_object('ok', false, 'errors', to_jsonb(v_errors), 'flags', '[]'::jsonb,
                              'notes', '[]'::jsonb, 'days', 0);
  end if;

  v_year := extract(year from p_start)::int;
  v_days := public.count_working_days(p_start, p_end, p_half);

  if v_days = 0 then
    v_errors := array_append(v_errors, 'The selected dates fall only on weekends or public holidays — no leave is needed.');
  end if;

  -- overlap with my own pending / approved leave (AM + PM on the same day is fine)
  select r.reference, r.start_date, r.end_date into v_overlap
    from public.leave_requests r
   where r.employee_id = p_employee
     and r.status in ('pending', 'approved')
     and (p_exclude is null or r.id <> p_exclude)
     and r.start_date <= p_end and r.end_date >= p_start
     and not (r.half_day is not null and p_half is not null and r.half_day <> p_half)
   order by r.start_date
   limit 1;
  if found then
    v_errors := array_append(v_errors, format('These dates overlap your request %s (%s to %s).',
      v_overlap.reference, to_char(v_overlap.start_date, 'DD Mon YYYY'), to_char(v_overlap.end_date, 'DD Mon YYYY')));
  end if;

  -- supporting document (e.g. MC number)
  if v_type.requires_document and coalesce(btrim(p_document_ref), '') = '' then
    v_errors := array_append(v_errors, format('%s is required for %s.', coalesce(v_type.document_label, 'A supporting document reference'), v_type.name));
  end if;

  -- balances
  perform public.ensure_entitlements(p_employee, v_year);
  select * into v_pos from public._leave_position(p_employee, p_type, v_year, p_exclude);

  if v_type.balance_check and v_days > v_pos.available then
    v_errors := array_append(v_errors, format('Not enough %s: %s day(s) available, %s requested.',
      v_type.name, trim_scale(v_pos.available), trim_scale(v_days)));
  end if;

  -- caps that include this type (e.g. sick leave also uses the hospitalisation cap)
  for v_capper in select * from public.leave_types where cap_includes_code = v_type.code and is_active loop
    select * into v_cap from public._leave_position(p_employee, v_capper.id, v_year, p_exclude);
    if v_days > v_cap.available then
      v_errors := array_append(v_errors, format('This would exceed the %s cap: %s of %s day(s) left (%s counts towards it).',
        v_capper.name, trim_scale(v_cap.available), trim_scale(v_cap.total), v_type.name));
    end if;
  end loop;

  -- e.g. unpaid leave only after annual leave is used up
  if v_type.requires_exhausted_code is not null then
    select * into v_first from public.leave_types where code = v_type.requires_exhausted_code;
    if found then
      select * into v_first_pos from public._leave_position(p_employee, v_first.id, v_year, p_exclude);
      if v_first_pos.available > 0 then
        v_errors := array_append(v_errors, format('Use your remaining %s day(s) of %s before applying for %s.',
          trim_scale(v_first_pos.available), v_first.name, v_type.name));
      end if;
    end if;
  end if;

  -- routing
  v_approver := public._approver_for(p_employee);
  if v_approver is null then
    v_errors := array_append(v_errors, 'No approver is set up for you yet — please contact HR.');
  else
    select full_name into v_appr_name from public.employees where id = v_approver;
  end if;

  -- flags (shown to the approver, never block)
  if p_start < v_today then
    v_flags := array_append(v_flags, 'backdated');
    v_notes := array_append(v_notes, 'Backdated: starts before today.');
  elsif v_type.min_notice_days > 0 and (p_start - v_today) < v_type.min_notice_days then
    v_flags := array_append(v_flags, 'short_notice');
    v_notes := array_append(v_notes, format('Short notice: %s day(s) before start (policy %s days).', p_start - v_today, v_type.min_notice_days));
  end if;

  if v_type.max_consecutive_days is not null and v_days > v_type.max_consecutive_days then
    v_flags := array_append(v_flags, 'over_limit');
    v_notes := array_append(v_notes, format('Longer than %s consecutive working days.', trim_scale(v_type.max_consecutive_days)));
  end if;

  if v_emp.department_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', e.full_name, 'start', r.start_date, 'end', r.end_date, 'status', r.status)
             order by r.start_date), '[]'::jsonb)
      into v_clashes
      from public.leave_requests r
      join public.employees e on e.id = r.employee_id
     where e.department_id = v_emp.department_id
       and r.employee_id <> p_employee
       and r.status in ('pending', 'approved')
       and r.start_date <= p_end and r.end_date >= p_start;
    if jsonb_array_length(v_clashes) > 0 then
      v_flags := array_append(v_flags, 'team_clash');
      v_notes := array_append(v_notes, format('Team clash: %s teammate(s) away on overlapping dates.', jsonb_array_length(v_clashes)));
    end if;
  end if;

  return jsonb_build_object(
    'ok', coalesce(array_length(v_errors, 1), 0) = 0,
    'errors', to_jsonb(v_errors),
    'flags', to_jsonb(v_flags),
    'notes', to_jsonb(v_notes),
    'days', v_days,
    'year', v_year,
    'leave_type', v_type.code,
    'balance', jsonb_build_object(
       'checked', v_type.balance_check,
       'total', v_pos.total, 'taken', v_pos.taken, 'pending', v_pos.pending,
       'available', v_pos.available, 'after', v_pos.available - v_days),
    'clashes', v_clashes,
    'approver_id', v_approver,
    'approver_name', v_appr_name
  );
end;
$$;

-- Live check for the request form (nothing is saved)
create or replace function public.preview_leave_request(
  p_leave_type_id uuid, p_start date, p_end date,
  p_half_day text default null, p_document_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_employee();
begin
  return public._evaluate_leave(v_me, p_leave_type_id, p_start, p_end, nullif(p_half_day, ''), p_document_ref, null);
end;
$$;

create or replace function public.submit_leave_request(
  p_leave_type_id uuid, p_start date, p_end date,
  p_half_day text default null, p_reason text default null,
  p_document_ref text default null, p_attachment_path text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_eval  jsonb;
  v_req   public.leave_requests%rowtype;
  v_name  text;
  v_type  text;
begin
  perform pg_advisory_xact_lock(hashtext('leave:' || v_me::text));

  if p_attachment_path is not null and split_part(p_attachment_path, '/', 1) <> v_me::text then
    raise exception 'The attachment does not belong to you.';
  end if;

  v_eval := public._evaluate_leave(v_me, p_leave_type_id, p_start, p_end, nullif(p_half_day, ''), p_document_ref, null);
  if not (v_eval ->> 'ok')::boolean then
    raise exception '%', array_to_string(array(select jsonb_array_elements_text(v_eval -> 'errors')), E'\n');
  end if;

  insert into public.leave_requests
    (employee_id, leave_type_id, start_date, end_date, half_day, days, reason,
     document_ref, attachment_path, approver_id, flags, evaluation)
  values
    (v_me, p_leave_type_id, p_start, p_end, nullif(p_half_day, ''), (v_eval ->> 'days')::numeric,
     nullif(btrim(p_reason), ''), nullif(btrim(p_document_ref), ''), p_attachment_path,
     (v_eval ->> 'approver_id')::uuid,
     array(select jsonb_array_elements_text(v_eval -> 'flags')), v_eval)
  returning * into v_req;

  select full_name into v_name from public.employees where id = v_me;
  select name into v_type from public.leave_types where id = p_leave_type_id;

  perform public._audit('leave', v_req.id, 'submitted', v_me, null, 'pending', null,
    jsonb_build_object('days', v_req.days, 'flags', v_req.flags));
  perform public._notify(v_req.approver_id, 'action',
    format('Leave request %s needs your approval', v_req.reference),
    format('%s — %s, %s to %s (%s day(s))%s', v_name, v_type,
      to_char(v_req.start_date, 'DD Mon'), to_char(v_req.end_date, 'DD Mon YYYY'), trim_scale(v_req.days),
      case when cardinality(v_req.flags) > 0 then ' · flags: ' || array_to_string(v_req.flags, ', ') else '' end),
    '/inbox', 'leave', v_req.id);

  return jsonb_build_object('id', v_req.id, 'reference', v_req.reference, 'status', v_req.status,
                            'days', v_req.days, 'flags', to_jsonb(v_req.flags), 'approver', v_eval ->> 'approver_name');
end;
$$;

create or replace function public.decide_leave_request(p_request_id uuid, p_decision text, p_remark text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_req   public.leave_requests%rowtype;
  v_eval  jsonb;
  v_name  text;
  v_type  text;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.';
  end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found then
    raise exception 'Leave request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Leave request % is already %.', v_req.reference, v_req.status;
  end if;
  if v_req.employee_id = v_me then
    raise exception 'You cannot approve or reject your own request.';
  end if;
  if not (coalesce(v_req.approver_id = v_me, false) or coalesce(v_req.escalated_to = v_me, false) or public.has_role('admin')) then
    raise exception 'Only the assigned approver can decide leave request %.', v_req.reference;
  end if;
  if p_decision = 'reject' and coalesce(btrim(p_remark), '') = '' then
    raise exception 'Please add a remark explaining why the request is rejected.';
  end if;

  select e.full_name, lt.name into v_name, v_type
    from public.employees e, public.leave_types lt
   where e.id = v_req.employee_id and lt.id = v_req.leave_type_id;

  if p_decision = 'approve' then
    perform pg_advisory_xact_lock(hashtext('leave:' || v_req.employee_id::text));
    -- re-check against the latest balance (something may have changed since submission)
    v_eval := public._evaluate_leave(v_req.employee_id, v_req.leave_type_id, v_req.start_date, v_req.end_date,
                                     v_req.half_day, v_req.document_ref, v_req.id);
    if not (v_eval ->> 'ok')::boolean then
      raise exception 'Cannot approve %: %', v_req.reference,
        array_to_string(array(select jsonb_array_elements_text(v_eval -> 'errors')), ' ');
    end if;

    update public.leave_requests
       set status = 'approved', decided_by = v_me, decided_at = now(),
           decision_remark = nullif(btrim(p_remark), '')
     where id = v_req.id;

    -- Master Leave Record: written automatically, no re-keying
    insert into public.leave_ledger (employee_id, leave_type_id, year, request_id, entry_type, days, start_date, end_date, note, created_by)
    values (v_req.employee_id, v_req.leave_type_id, v_req.year, v_req.id, 'taken', v_req.days,
            v_req.start_date, v_req.end_date, format('Approved %s', v_req.reference), v_me);

    perform public._audit('leave', v_req.id, 'approved', v_me, 'pending', 'approved', nullif(btrim(p_remark), ''));
    perform public._notify(v_req.employee_id, 'success',
      format('Leave %s approved', v_req.reference),
      format('%s, %s to %s (%s day(s)). Balance after: %s day(s).', v_type,
        to_char(v_req.start_date, 'DD Mon'), to_char(v_req.end_date, 'DD Mon YYYY'), trim_scale(v_req.days),
        trim_scale((v_eval -> 'balance' ->> 'after')::numeric)),
      '/time-off', 'leave', v_req.id);
    perform public._notify_role('hr', 'info',
      format('Leave %s approved — recorded', v_req.reference),
      format('%s · %s · %s day(s). The Master Leave Record has been updated.', v_name, v_type, trim_scale(v_req.days)),
      '/hr', 'leave', v_req.id, v_req.employee_id);
  else
    update public.leave_requests
       set status = 'rejected', decided_by = v_me, decided_at = now(), decision_remark = btrim(p_remark)
     where id = v_req.id;
    perform public._audit('leave', v_req.id, 'rejected', v_me, 'pending', 'rejected', btrim(p_remark));
    perform public._notify(v_req.employee_id, 'warning',
      format('Leave %s rejected', v_req.reference), format('Remark: %s', btrim(p_remark)),
      '/time-off', 'leave', v_req.id);
  end if;

  return jsonb_build_object('id', v_req.id, 'reference', v_req.reference,
                            'status', case when p_decision = 'approve' then 'approved' else 'rejected' end);
end;
$$;

create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := public._require_employee();
  v_req    public.leave_requests%rowtype;
  v_is_hr  boolean := public.has_role('hr', 'admin');
begin
  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found then
    raise exception 'Leave request not found.';
  end if;
  if v_req.employee_id <> v_me and not v_is_hr then
    raise exception 'You can only cancel your own leave.';
  end if;
  if v_req.status not in ('pending', 'approved') then
    raise exception 'Leave request % is already %.', v_req.reference, v_req.status;
  end if;
  if v_req.status = 'approved' and v_req.start_date <= public.sg_today() and not v_is_hr then
    raise exception 'Leave that has already started cannot be cancelled here — please contact HR.';
  end if;
  if v_is_hr and v_req.employee_id <> v_me and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Please give a reason when cancelling leave on someone''s behalf.';
  end if;

  update public.leave_requests
     set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(btrim(p_reason), '')
   where id = v_req.id;

  if v_req.status = 'approved' then
    insert into public.leave_ledger (employee_id, leave_type_id, year, request_id, entry_type, days, start_date, end_date, note, created_by)
    values (v_req.employee_id, v_req.leave_type_id, v_req.year, v_req.id, 'reversal', -v_req.days,
            v_req.start_date, v_req.end_date, format('Cancelled %s', v_req.reference), v_me);
    perform public._notify_role('hr', 'info', format('Approved leave %s cancelled', v_req.reference),
      'The days have been returned to the balance in the Master Leave Record.', '/hr', 'leave', v_req.id, v_me);
  end if;

  perform public._audit('leave', v_req.id, 'cancelled', v_me, v_req.status::text, 'cancelled', nullif(btrim(p_reason), ''));
  perform public._notify(coalesce(v_req.escalated_to, v_req.approver_id), 'info',
    format('Leave %s was cancelled', v_req.reference), nullif(btrim(p_reason), ''), '/inbox', 'leave', v_req.id);
  if v_req.employee_id <> v_me then
    perform public._notify(v_req.employee_id, 'warning', format('Your leave %s was cancelled by HR', v_req.reference),
      btrim(p_reason), '/time-off', 'leave', v_req.id);
  end if;

  return jsonb_build_object('id', v_req.id, 'reference', v_req.reference, 'status', 'cancelled');
end;
$$;

-- Who is away: approved leave of my department; pending only for self / managers / HR.
-- Leave type is hidden from colleagues (shown as "Out of office").
create or replace function public.team_absence(p_from date, p_to date)
returns table (
  request_id uuid, employee_id uuid, full_name text, department text,
  start_date date, end_date date, half_day text, days numeric, status text,
  leave_code text, leave_name text, color text, is_mine boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_dept  uuid;
  v_hr    boolean := public.has_role('hr', 'admin');
begin
  select e0.department_id into v_dept from public.employees e0 where e0.id = v_me;
  return query
  select r.id, r.employee_id, e.full_name, d.name, r.start_date, r.end_date, r.half_day, r.days, r.status::text,
         case when r.employee_id = v_me or v_hr or public.is_manager_of(r.employee_id) then lt.code else 'OOO' end,
         case when r.employee_id = v_me or v_hr or public.is_manager_of(r.employee_id) then lt.name else 'Out of office' end,
         case when r.employee_id = v_me or v_hr or public.is_manager_of(r.employee_id) then lt.color else '#7b8794' end,
         r.employee_id = v_me
    from public.leave_requests r
    join public.employees e on e.id = r.employee_id
    join public.leave_types lt on lt.id = r.leave_type_id
    left join public.departments d on d.id = e.department_id
   where r.status in ('approved', 'pending')
     and r.start_date <= p_to and r.end_date >= p_from
     and (v_hr or r.employee_id = v_me or public.is_manager_of(r.employee_id)
          or (r.status = 'approved' and e.department_id = v_dept))
   order by r.start_date, e.full_name;
end;
$$;

-- ---------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------
create or replace function public.submit_claim(
  p_title text, p_lines jsonb, p_declaration boolean, p_claim_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me         uuid := public._require_employee();
  v_emp        public.employees%rowtype;
  v_claim      public.claims%rowtype;
  v_cat        public.claim_categories%rowtype;
  v_errors     text[] := '{}';
  v_flags      text[] := '{}';
  v_line_flags text[];
  v_receipts   text[] := '{}';
  v_line       jsonb;
  v_clean      jsonb := '[]';
  v_i          int := 0;
  v_date       date;
  v_amount     numeric;
  v_cat_id     uuid;
  v_desc       text;
  v_receipt    text;
  v_path       text;
  v_dup        text;
  v_total      numeric := 0;
  v_approver   uuid;
  v_today      date := public.sg_today();
  v_late_days  int := public.setting_int('claim_late_after_days', 90);
  v_resubmit   boolean := p_claim_id is not null;
  v_from       text;
begin
  perform pg_advisory_xact_lock(hashtext('claim:' || v_me::text));
  select * into v_emp from public.employees where id = v_me;

  if v_resubmit then
    select * into v_claim from public.claims where id = p_claim_id for update;
    if not found or v_claim.employee_id <> v_me then
      raise exception 'Claim not found.';
    end if;
    if v_claim.status <> 'returned' then
      raise exception 'Only claims returned by Finance can be corrected and resubmitted (% is %).', v_claim.reference, v_claim.status;
    end if;
    v_from := v_claim.status::text;
  end if;

  if coalesce(btrim(p_title), '') = '' then
    v_errors := array_append(v_errors, 'Give the claim a short title.');
  end if;
  if not coalesce(p_declaration, false) then
    v_errors := array_append(v_errors, 'Please tick the declaration that these expenses are genuine, work-related and not claimed elsewhere.');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    v_errors := array_append(v_errors, 'Add at least one expense line.');
  else
    for v_line in select value from jsonb_array_elements(p_lines) loop
      v_i := v_i + 1;
      v_line_flags := '{}';

      begin v_date := nullif(v_line ->> 'expense_date', '')::date; exception when others then v_date := null; end;
      begin v_amount := nullif(v_line ->> 'amount', '')::numeric; exception when others then v_amount := null; end;
      begin v_cat_id := nullif(v_line ->> 'category_id', '')::uuid; exception when others then v_cat_id := null; end;
      v_desc := btrim(coalesce(v_line ->> 'description', ''));
      v_receipt := nullif(btrim(coalesce(v_line ->> 'receipt_no', '')), '');
      v_path := nullif(btrim(coalesce(v_line ->> 'receipt_path', '')), '');

      select * into v_cat from public.claim_categories where id = v_cat_id and is_active;

      if v_date is null then
        v_errors := array_append(v_errors, format('Line %s: the expense date is required.', v_i));
      elsif v_date > v_today then
        v_errors := array_append(v_errors, format('Line %s: the expense date cannot be in the future.', v_i));
      elsif v_date < v_emp.hire_date then
        v_errors := array_append(v_errors, format('Line %s: the expense date is before your start date.', v_i));
      elsif v_date < v_today - v_late_days then
        v_line_flags := array_append(v_line_flags, 'late_submission');
      end if;

      if v_cat.id is null then
        v_errors := array_append(v_errors, format('Line %s: choose an expense category.', v_i));
      end if;
      if v_desc = '' then
        v_errors := array_append(v_errors, format('Line %s: add a description.', v_i));
      end if;
      if v_amount is null or v_amount <= 0 then
        v_errors := array_append(v_errors, format('Line %s: the amount must be greater than zero.', v_i));
      elsif v_amount <> round(v_amount, 2) then
        v_errors := array_append(v_errors, format('Line %s: the amount can have at most 2 decimal places.', v_i));
      elsif v_cat.limit_per_line is not null and v_amount > v_cat.limit_per_line then
        v_line_flags := array_append(v_line_flags, 'over_limit');
      end if;

      if v_cat.id is not null and v_cat.requires_receipt and v_receipt is null then
        v_errors := array_append(v_errors, format('Line %s: a receipt number is required for %s.', v_i, v_cat.name));
      end if;

      if v_path is not null and split_part(v_path, '/', 1) <> v_me::text then
        v_errors := array_append(v_errors, format('Line %s: the receipt attachment does not belong to you.', v_i));
      end if;

      if v_receipt is not null then
        if lower(v_receipt) = any (v_receipts) then
          v_errors := array_append(v_errors, format('Line %s: receipt %s appears twice in this claim.', v_i, v_receipt));
        end if;
        v_receipts := array_append(v_receipts, lower(v_receipt));

        select c.reference into v_dup
          from public.claim_lines l join public.claims c on c.id = l.claim_id
         where c.employee_id = v_me
           and c.status not in ('rejected', 'cancelled')
           and lower(l.receipt_no) = lower(v_receipt)
           and (p_claim_id is null or c.id <> p_claim_id)
         limit 1;
        if found then
          v_errors := array_append(v_errors, format('Line %s: receipt %s was already claimed on %s.', v_i, v_receipt, v_dup));
        end if;
      end if;

      v_total := v_total + coalesce(v_amount, 0);
      v_flags := v_flags || v_line_flags;
      v_clean := v_clean || jsonb_build_array(jsonb_build_object(
        'expense_date', v_date, 'category_id', v_cat_id, 'description', v_desc,
        'amount', v_amount, 'receipt_no', v_receipt, 'receipt_path', v_path, 'flags', to_jsonb(v_line_flags)));
    end loop;
  end if;

  v_approver := public._approver_for(v_me);
  if v_approver is null then
    v_errors := array_append(v_errors, 'No approver is set up for you yet — please contact HR.');
  end if;

  if array_length(v_errors, 1) > 0 then
    raise exception '%', array_to_string(v_errors, E'\n');
  end if;

  v_flags := array(select distinct unnest(v_flags));

  if v_resubmit then
    update public.claims
       set title = btrim(p_title), total_amount = v_total, approver_id = v_approver,
           declaration_accepted = true, flags = v_flags, status = 'pending', submitted_at = now(),
           decided_by = null, decided_at = null, decision_remark = null,
           finance_by = null, finance_at = null,
           reminded_at = null, escalated_at = null, escalated_to = null
     where id = p_claim_id
     returning * into v_claim;
    delete from public.claim_lines where claim_id = p_claim_id;
  else
    insert into public.claims (employee_id, title, total_amount, approver_id, declaration_accepted, flags)
    values (v_me, btrim(p_title), v_total, v_approver, true, v_flags)
    returning * into v_claim;
  end if;

  insert into public.claim_lines (claim_id, line_no, expense_date, category_id, description, amount, receipt_no, receipt_path, flags)
  select v_claim.id, t.ord, (t.x ->> 'expense_date')::date, (t.x ->> 'category_id')::uuid, t.x ->> 'description',
         (t.x ->> 'amount')::numeric, t.x ->> 'receipt_no', t.x ->> 'receipt_path',
         array(select jsonb_array_elements_text(t.x -> 'flags'))
    from jsonb_array_elements(v_clean) with ordinality as t(x, ord);

  perform public._audit('claim', v_claim.id, case when v_resubmit then 'resubmitted' else 'submitted' end, v_me,
    v_from, 'pending', null, jsonb_build_object('total', v_total, 'lines', v_i, 'flags', v_flags));
  perform public._notify(v_approver, 'action',
    format('Claim %s needs your approval', v_claim.reference),
    format('%s — %s · SGD %s (%s line(s))%s', v_emp.full_name, btrim(p_title), to_char(v_total, 'FM999,999,990.00'), v_i,
      case when cardinality(v_flags) > 0 then ' · flags: ' || array_to_string(v_flags, ', ') else '' end),
    '/inbox', 'claim', v_claim.id);

  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', 'pending',
                            'total', v_total, 'flags', to_jsonb(v_flags));
end;
$$;

create or replace function public.decide_claim(p_claim_id uuid, p_decision text, p_remark text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_claim public.claims%rowtype;
  v_name  text;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.';
  end if;
  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found then
    raise exception 'Claim not found.';
  end if;
  if v_claim.status <> 'pending' then
    raise exception 'Claim % is already %.', v_claim.reference, v_claim.status;
  end if;
  if v_claim.employee_id = v_me then
    raise exception 'You cannot approve or reject your own claim.';
  end if;
  if not (coalesce(v_claim.approver_id = v_me, false) or coalesce(v_claim.escalated_to = v_me, false) or public.has_role('admin')) then
    raise exception 'Only the assigned approver can decide claim %.', v_claim.reference;
  end if;
  if p_decision = 'reject' and coalesce(btrim(p_remark), '') = '' then
    raise exception 'Please add a remark explaining why the claim is rejected.';
  end if;

  select full_name into v_name from public.employees where id = v_claim.employee_id;

  if p_decision = 'approve' then
    update public.claims
       set status = 'approved', decided_by = v_me, decided_at = now(), decision_remark = nullif(btrim(p_remark), '')
     where id = v_claim.id;
    perform public._audit('claim', v_claim.id, 'approved', v_me, 'pending', 'approved', nullif(btrim(p_remark), ''));
    perform public._notify(v_claim.employee_id, 'success', format('Claim %s approved', v_claim.reference),
      format('SGD %s has been submitted to Finance for the next payroll.', to_char(v_claim.total_amount, 'FM999,999,990.00')),
      '/expenses', 'claim', v_claim.id);
    perform public._notify_role('finance', 'action', format('Claim %s ready for payment', v_claim.reference),
      format('%s · %s · SGD %s', v_name, v_claim.title, to_char(v_claim.total_amount, 'FM999,999,990.00')),
      '/finance', 'claim', v_claim.id, v_claim.employee_id);
  else
    update public.claims
       set status = 'rejected', decided_by = v_me, decided_at = now(), decision_remark = btrim(p_remark)
     where id = v_claim.id;
    perform public._audit('claim', v_claim.id, 'rejected', v_me, 'pending', 'rejected', btrim(p_remark));
    perform public._notify(v_claim.employee_id, 'warning', format('Claim %s rejected', v_claim.reference),
      format('Remark: %s', btrim(p_remark)), '/expenses', 'claim', v_claim.id);
  end if;

  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference,
                            'status', case when p_decision = 'approve' then 'approved' else 'rejected' end);
end;
$$;

-- Finance: mark one or more approved claims as paid in a payroll run
create or replace function public.pay_claims(p_claim_ids uuid[], p_paid_on date, p_payment_reference text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_claim public.claims%rowtype;
  v_count int := 0;
  v_id    uuid;
begin
  if not public.has_role('finance', 'admin') then
    raise exception 'Only Finance can record claim payments.';
  end if;
  if p_claim_ids is null or cardinality(p_claim_ids) = 0 then
    raise exception 'Select at least one claim to pay.';
  end if;
  if coalesce(btrim(p_payment_reference), '') = '' then
    raise exception 'Enter the payment reference (e.g. PAYROLL-2026-11).';
  end if;
  if p_paid_on is null then
    raise exception 'Enter the payment date.';
  end if;
  if p_paid_on > public.sg_today() + 31 then
    raise exception 'The payment date is too far in the future.';
  end if;

  foreach v_id in array p_claim_ids loop
    select * into v_claim from public.claims where id = v_id for update;
    if not found then
      raise exception 'Claim not found.';
    end if;
    if v_claim.status <> 'approved' then
      raise exception 'Claim % is % — only claims approved by the Department Head can be paid.', v_claim.reference, v_claim.status;
    end if;
    if v_claim.employee_id = v_me then
      raise exception 'You cannot pay your own claim (%).', v_claim.reference;
    end if;

    update public.claims
       set status = 'paid', paid_on = p_paid_on, payment_reference = btrim(p_payment_reference),
           finance_by = v_me, finance_at = now()
     where id = v_id;
    perform public._audit('claim', v_id, 'paid', v_me, 'approved', 'paid', null,
      jsonb_build_object('paid_on', p_paid_on, 'payment_reference', btrim(p_payment_reference)));
    perform public._notify(v_claim.employee_id, 'success', format('Claim %s paid', v_claim.reference),
      format('SGD %s paid on %s (ref %s).', to_char(v_claim.total_amount, 'FM999,999,990.00'),
        to_char(p_paid_on, 'DD Mon YYYY'), btrim(p_payment_reference)),
      '/expenses', 'claim', v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.return_claim(p_claim_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_claim public.claims%rowtype;
begin
  if not public.has_role('finance', 'admin') then
    raise exception 'Only Finance can return a claim.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Please say why the claim is being returned (e.g. receipt missing).';
  end if;
  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found then
    raise exception 'Claim not found.';
  end if;
  if v_claim.status <> 'approved' then
    raise exception 'Claim % is % — only claims awaiting payment can be returned.', v_claim.reference, v_claim.status;
  end if;

  update public.claims
     set status = 'returned', return_reason = btrim(p_reason), finance_by = v_me, finance_at = now()
   where id = p_claim_id;
  perform public._audit('claim', p_claim_id, 'returned', v_me, 'approved', 'returned', btrim(p_reason));
  perform public._notify(v_claim.employee_id, 'warning', format('Claim %s returned by Finance', v_claim.reference),
    format('%s — correct it and resubmit.', btrim(p_reason)), '/expenses', 'claim', p_claim_id);
  perform public._notify(v_claim.decided_by, 'info', format('Claim %s returned by Finance', v_claim.reference),
    btrim(p_reason), '/inbox', 'claim', p_claim_id);
  return jsonb_build_object('id', p_claim_id, 'reference', v_claim.reference, 'status', 'returned');
end;
$$;

create or replace function public.cancel_claim(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public._require_employee();
  v_claim public.claims%rowtype;
begin
  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found or v_claim.employee_id <> v_me then
    raise exception 'Claim not found.';
  end if;
  if v_claim.status not in ('pending', 'returned') then
    raise exception 'Claim % is % and can no longer be withdrawn.', v_claim.reference, v_claim.status;
  end if;
  update public.claims set status = 'cancelled' where id = p_claim_id;
  perform public._audit('claim', p_claim_id, 'cancelled', v_me, v_claim.status::text, 'cancelled', null);
  if v_claim.status = 'pending' then
    perform public._notify(coalesce(v_claim.escalated_to, v_claim.approver_id), 'info',
      format('Claim %s was withdrawn', v_claim.reference), null, '/inbox', 'claim', p_claim_id);
  end if;
  return jsonb_build_object('id', p_claim_id, 'reference', v_claim.reference, 'status', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------
-- Reminders & escalation (run hourly by pg_cron, or on demand by HR)
--  * remind the approver after N working days (default 1)
--  * escalate to the approver's manager after M working days (default 2)
-- ---------------------------------------------------------------------
create or replace function public.process_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remind_after int := public.setting_int('reminder_after_working_days', 1);
  v_escalate_after int := public.setting_int('escalate_after_working_days', 2);
  v_today date := public.sg_today();
  v_elapsed numeric;
  v_up uuid;
  v_reminded int := 0;
  v_escalated int := 0;
  r record;
begin
  if auth.uid() is not null and not public.has_role('hr', 'admin') then
    raise exception 'Only HR or an administrator can run reminders.';
  end if;

  for r in
    select 'leave' as kind, lr.id, lr.reference, lr.employee_id, lr.approver_id, lr.submitted_at,
           lr.reminded_at, lr.escalated_at, e.full_name
      from public.leave_requests lr join public.employees e on e.id = lr.employee_id
     where lr.status = 'pending'
    union all
    select 'claim', c.id, c.reference, c.employee_id, c.approver_id, c.submitted_at,
           c.reminded_at, c.escalated_at, e.full_name
      from public.claims c join public.employees e on e.id = c.employee_id
     where c.status = 'pending'
  loop
    v_elapsed := public.count_working_days(((r.submitted_at at time zone 'Asia/Singapore')::date + 1), v_today, null);

    if v_elapsed >= v_escalate_after and r.escalated_at is null then
      v_up := null;
      select m.id into v_up
        from public.employees a join public.employees m on m.id = a.manager_id
       where a.id = r.approver_id and m.is_active and m.id <> r.employee_id;
      if v_up is not null then
        if r.kind = 'leave' then
          update public.leave_requests set escalated_at = now(), escalated_to = v_up,
                 flags = array_append(array_remove(flags, 'escalated'), 'escalated') where id = r.id;
        else
          update public.claims set escalated_at = now(), escalated_to = v_up,
                 flags = array_append(array_remove(flags, 'escalated'), 'escalated') where id = r.id;
        end if;
        perform public._audit(r.kind, r.id, 'escalated', null, 'pending', 'pending',
          format('No decision after %s working day(s)', trim_scale(v_elapsed)), jsonb_build_object('escalated_to', v_up));
        perform public._notify(v_up, 'action', format('Escalated: %s awaiting a decision', r.reference),
          format('%s''s %s request has waited %s working day(s). You can now decide it.', r.full_name, r.kind, trim_scale(v_elapsed)),
          '/inbox', r.kind, r.id);
        perform public._notify(r.approver_id, 'warning', format('%s escalated to your manager', r.reference),
          'It passed the 2-working-day decision target.', '/inbox', r.kind, r.id);
        v_escalated := v_escalated + 1;
      end if;
    elsif v_elapsed >= v_remind_after and r.reminded_at is null then
      if r.kind = 'leave' then
        update public.leave_requests set reminded_at = now() where id = r.id;
      else
        update public.claims set reminded_at = now() where id = r.id;
      end if;
      perform public._audit(r.kind, r.id, 'reminded', null, 'pending', 'pending', null);
      perform public._notify(r.approver_id, 'action', format('Reminder: %s is waiting for you', r.reference),
        format('%s''s %s request was submitted %s working day(s) ago.', r.full_name, r.kind, trim_scale(v_elapsed)),
        '/inbox', r.kind, r.id);
      v_reminded := v_reminded + 1;
    end if;
  end loop;

  return jsonb_build_object('reminded', v_reminded, 'escalated', v_escalated);
end;
$$;

-- ---------------------------------------------------------------------
-- Self-service profile
-- ---------------------------------------------------------------------
create or replace function public.update_my_profile(p_preferred_name text, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_employee();
begin
  update public.employees
     set preferred_name = nullif(btrim(p_preferred_name), ''), phone = nullif(btrim(p_phone), '')
   where id = v_me;
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges: internal helpers are not callable from the API
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.sg_today(),
  public.current_employee_id(),
  public.has_role(public.app_role[]),
  public.is_manager_of(uuid),
  public.count_working_days(date, date, text),
  public.ensure_my_entitlements(int),
  public.hr_generate_entitlements(int),
  public.hr_set_entitlement(uuid, uuid, int, numeric, numeric, numeric, text),
  public.preview_leave_request(uuid, date, date, text, text),
  public.submit_leave_request(uuid, date, date, text, text, text, text),
  public.decide_leave_request(uuid, text, text),
  public.cancel_leave_request(uuid, text),
  public.team_absence(date, date),
  public.submit_claim(text, jsonb, boolean, uuid),
  public.decide_claim(uuid, text, text),
  public.pay_claims(uuid[], date, text),
  public.return_claim(uuid, text),
  public.cancel_claim(uuid),
  public.process_reminders(),
  public.update_my_profile(text, text)
to authenticated;
