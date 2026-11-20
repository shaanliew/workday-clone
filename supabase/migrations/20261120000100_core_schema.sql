-- =====================================================================
-- Workline (Workday-style HCM) — core schema
-- Leave & Claims Approval Workflow (Activities 1.1 / 1.2)
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.app_role as enum ('employee', 'hr', 'finance', 'admin');
create type public.leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
-- claim lifecycle: pending -> approved ("Submitted to Finance") -> paid
--                         -> rejected            approved -> returned (by Finance)
create type public.claim_status as enum ('pending', 'approved', 'rejected', 'returned', 'paid', 'cancelled');

-- ---------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------
create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  head_id     uuid,                      -- FK added after employees exists
  created_at  timestamptz not null default now()
);

create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users (id) on delete set null,
  employee_no     text not null unique,
  full_name       text not null,
  preferred_name  text,
  email           text not null,
  job_title       text,
  department_id   uuid references public.departments (id) on delete set null,
  manager_id      uuid,
  role            public.app_role not null default 'employee',
  hire_date       date not null,
  end_date        date,
  is_active       boolean not null default true,
  phone           text,
  location        text not null default 'Singapore',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint employees_manager_fkey foreign key (manager_id) references public.employees (id) on delete set null,
  constraint employees_not_own_manager check (manager_id is null or manager_id <> id)
);
create unique index employees_email_lower_key on public.employees (lower(email));
create index employees_manager_idx on public.employees (manager_id);
create index employees_department_idx on public.employees (department_id);

alter table public.departments
  add constraint departments_head_fkey foreign key (head_id) references public.employees (id) on delete set null;

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------
create table public.public_holidays (
  holiday_date  date primary key,
  name          text not null,
  is_in_lieu    boolean not null default false,
  year          int generated always as (extract(year from holiday_date)::int) stored
);

create table public.leave_types (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique,
  name                     text not null,
  description              text,
  default_days             numeric(5,1) not null default 0,
  is_paid                  boolean not null default true,
  balance_check            boolean not null default true,   -- false = no balance limit (e.g. unpaid)
  prorate_for_joiners      boolean not null default false,  -- pro-rate entitlement in year of joining
  requires_document        boolean not null default false,  -- e.g. MC number for sick leave
  document_label           text,
  cap_includes_code        text,   -- this type's cap also consumes days of that code (HL cap includes SL)
  requires_exhausted_code  text,   -- that code's balance must be used up first (UL requires AL = 0)
  min_notice_days          int not null default 0,          -- flag (not block) if shorter notice
  max_consecutive_days     numeric(5,1),                    -- flag (not block) if longer
  allow_half_day           boolean not null default true,
  color                    text not null default '#0875e1',
  sort_order               int not null default 0,
  is_active                boolean not null default true
);

create table public.claim_categories (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  requires_receipt  boolean not null default true,
  limit_per_line    numeric(10,2),        -- flag (not block) when exceeded
  gl_code           text,
  sort_order        int not null default 0,
  is_active         boolean not null default true
);

create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------
create table public.leave_entitlements (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.employees (id) on delete cascade,
  leave_type_id    uuid not null references public.leave_types (id),
  year             int not null,
  entitled_days    numeric(5,1) not null default 0,   -- contract entitlement (pro-rated for joiners)
  carried_forward  numeric(5,1) not null default 0,
  adjustment       numeric(5,1) not null default 0,
  note             text,
  updated_by       uuid references public.employees (id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (employee_id, leave_type_id, year)
);

create sequence public.leave_ref_seq;
create sequence public.claim_ref_seq;

create table public.leave_requests (
  id               uuid primary key default gen_random_uuid(),
  reference        text not null unique default
                     ('LV-' || to_char(now() at time zone 'Asia/Singapore', 'YYYY') || '-' || lpad(nextval('public.leave_ref_seq')::text, 4, '0')),
  employee_id      uuid not null,
  leave_type_id    uuid not null references public.leave_types (id),
  start_date       date not null,
  end_date         date not null,
  half_day         text,
  days             numeric(5,1) not null,
  year             int generated always as (extract(year from start_date)::int) stored,
  reason           text,
  document_ref     text,          -- MC no. etc.
  attachment_path  text,          -- storage object in 'attachments' bucket
  status           public.leave_status not null default 'pending',
  approver_id      uuid,
  flags            text[] not null default '{}',
  evaluation       jsonb,         -- balance / clash snapshot shown to the approver
  submitted_at     timestamptz not null default now(),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_remark  text,
  cancelled_at     timestamptz,
  cancel_reason    text,
  reminded_at      timestamptz,
  escalated_at     timestamptz,
  escalated_to     uuid,
  updated_at       timestamptz not null default now(),
  constraint leave_requests_employee_id_fkey  foreign key (employee_id)  references public.employees (id) on delete cascade,
  constraint leave_requests_approver_id_fkey  foreign key (approver_id)  references public.employees (id) on delete set null,
  constraint leave_requests_decided_by_fkey   foreign key (decided_by)   references public.employees (id) on delete set null,
  constraint leave_requests_escalated_to_fkey foreign key (escalated_to) references public.employees (id) on delete set null,
  constraint leave_requests_dates_check  check (end_date >= start_date),
  constraint leave_requests_same_year    check (extract(year from start_date) = extract(year from end_date)),
  constraint leave_requests_half_day     check (half_day is null or (half_day in ('AM', 'PM') and start_date = end_date)),
  constraint leave_requests_days_check   check (days > 0)
);
create index leave_requests_employee_idx on public.leave_requests (employee_id, year);
create index leave_requests_approver_idx on public.leave_requests (approver_id) where status = 'pending';
create index leave_requests_escalated_idx on public.leave_requests (escalated_to) where status = 'pending';
create index leave_requests_dates_idx on public.leave_requests (start_date, end_date);

-- Master Leave Record: written automatically on approval / cancellation. Never re-keyed.
create table public.leave_ledger (
  id             bigint generated always as identity primary key,
  employee_id    uuid not null references public.employees (id) on delete cascade,
  leave_type_id  uuid not null references public.leave_types (id),
  year           int not null,
  request_id     uuid references public.leave_requests (id) on delete set null,
  entry_type     text not null check (entry_type in ('taken', 'reversal')),
  days           numeric(5,1) not null,   -- +days consumed, -days restored
  start_date     date,
  end_date       date,
  note           text,
  created_by     uuid references public.employees (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index leave_ledger_employee_idx on public.leave_ledger (employee_id, year);
create index leave_ledger_request_idx on public.leave_ledger (request_id);

-- ---------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------
create table public.claims (
  id                    uuid primary key default gen_random_uuid(),
  reference             text not null unique default
                          ('CL-' || to_char(now() at time zone 'Asia/Singapore', 'YYYY') || '-' || lpad(nextval('public.claim_ref_seq')::text, 4, '0')),
  employee_id           uuid not null,
  title                 text not null,
  total_amount          numeric(12,2) not null default 0,
  currency              text not null default 'SGD',
  status                public.claim_status not null default 'pending',
  approver_id           uuid,
  declaration_accepted  boolean not null default false,
  flags                 text[] not null default '{}',
  submitted_at          timestamptz not null default now(),
  decided_by            uuid,
  decided_at            timestamptz,
  decision_remark       text,
  finance_by            uuid,
  finance_at            timestamptz,
  return_reason         text,
  paid_on               date,
  payment_reference     text,
  reminded_at           timestamptz,
  escalated_at          timestamptz,
  escalated_to          uuid,
  updated_at            timestamptz not null default now(),
  constraint claims_employee_id_fkey  foreign key (employee_id)  references public.employees (id) on delete cascade,
  constraint claims_approver_id_fkey  foreign key (approver_id)  references public.employees (id) on delete set null,
  constraint claims_decided_by_fkey   foreign key (decided_by)   references public.employees (id) on delete set null,
  constraint claims_finance_by_fkey   foreign key (finance_by)   references public.employees (id) on delete set null,
  constraint claims_escalated_to_fkey foreign key (escalated_to) references public.employees (id) on delete set null,
  constraint claims_paid_check check (status <> 'paid' or (paid_on is not null and coalesce(payment_reference, '') <> ''))
);
create index claims_employee_idx on public.claims (employee_id);
create index claims_approver_idx on public.claims (approver_id) where status = 'pending';
create index claims_status_idx on public.claims (status);

create table public.claim_lines (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.claims (id) on delete cascade,
  line_no       int not null,
  expense_date  date not null,
  category_id   uuid not null references public.claim_categories (id),
  description   text not null,
  amount        numeric(10,2) not null check (amount > 0),
  receipt_no    text,
  receipt_path  text,
  flags         text[] not null default '{}',
  unique (claim_id, line_no)
);
create index claim_lines_claim_idx on public.claim_lines (claim_id);
create index claim_lines_receipt_idx on public.claim_lines (lower(receipt_no));

-- ---------------------------------------------------------------------
-- Audit trail & notifications
-- ---------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  entity_type  text not null,           -- leave | claim | entitlement | employee | holiday | system
  entity_id    uuid,
  action       text not null,
  actor_id     uuid references public.employees (id) on delete set null,
  from_status  text,
  to_status    text,
  remark       text,
  meta         jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.employees (id) on delete cascade,
  kind          text not null default 'info',
  title         text not null,
  body          text,
  link          text,
  entity_type   text,
  entity_id     uuid,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger employees_touch       before update on public.employees       for each row execute function public.touch_updated_at();
create trigger leave_requests_touch  before update on public.leave_requests  for each row execute function public.touch_updated_at();
create trigger claims_touch          before update on public.claims          for each row execute function public.touch_updated_at();
