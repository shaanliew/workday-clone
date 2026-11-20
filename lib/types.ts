export type AppRole = 'employee' | 'hr' | 'finance' | 'admin';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type ClaimStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'paid' | 'cancelled';

export interface Department {
  id: string;
  code: string;
  name: string;
  head_id: string | null;
}

export interface Employee {
  id: string;
  user_id: string | null;
  employee_no: string;
  full_name: string;
  preferred_name: string | null;
  email: string;
  job_title: string | null;
  department_id: string | null;
  manager_id: string | null;
  role: AppRole;
  hire_date: string;
  end_date: string | null;
  is_active: boolean;
  phone: string | null;
  location: string;
}

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_days: number;
  is_paid: boolean;
  balance_check: boolean;
  prorate_for_joiners: boolean;
  requires_document: boolean;
  document_label: string | null;
  cap_includes_code: string | null;
  requires_exhausted_code: string | null;
  min_notice_days: number;
  max_consecutive_days: number | null;
  allow_half_day: boolean;
  color: string;
  sort_order: number;
  is_active: boolean;
}

export interface ClaimCategory {
  id: string;
  code: string;
  name: string;
  requires_receipt: boolean;
  limit_per_line: number | null;
  gl_code: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface Holiday {
  holiday_date: string;
  name: string;
  is_in_lieu: boolean;
  year: number;
}

export interface LeaveBalance {
  employee_id: string;
  year: number;
  leave_type_id: string;
  code: string;
  name: string;
  color: string;
  balance_check: boolean;
  sort_order: number;
  entitled_days: number;
  carried_forward: number;
  adjustment: number;
  total_entitlement: number;
  taken: number;
  pending: number;
  remaining: number;
  available: number;
}

export interface LeaveEvaluation {
  ok: boolean;
  errors: string[];
  flags: string[];
  notes: string[];
  days: number;
  year?: number;
  leave_type?: string;
  balance?: {
    checked: boolean;
    total: number;
    taken: number;
    pending: number;
    available: number;
    after: number;
  };
  clashes?: { name: string; start: string; end: string; status: string }[];
  approver_id?: string | null;
  approver_name?: string | null;
}

export interface LeaveRequest {
  id: string;
  reference: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  half_day: 'AM' | 'PM' | null;
  days: number;
  year: number;
  reason: string | null;
  document_ref: string | null;
  attachment_path: string | null;
  status: LeaveStatus;
  approver_id: string | null;
  flags: string[];
  evaluation: LeaveEvaluation | null;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_remark: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  reminded_at: string | null;
  escalated_at: string | null;
  escalated_to: string | null;
}

export interface LedgerEntry {
  id: number;
  employee_id: string;
  leave_type_id: string;
  year: number;
  request_id: string | null;
  entry_type: 'taken' | 'reversal';
  days: number;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Claim {
  id: string;
  reference: string;
  employee_id: string;
  title: string;
  total_amount: number;
  currency: string;
  status: ClaimStatus;
  approver_id: string | null;
  declaration_accepted: boolean;
  flags: string[];
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_remark: string | null;
  finance_by: string | null;
  finance_at: string | null;
  return_reason: string | null;
  paid_on: string | null;
  payment_reference: string | null;
  escalated_to: string | null;
  claim_lines?: ClaimLine[];
}

export interface ClaimLine {
  id: string;
  claim_id: string;
  line_no: number;
  expense_date: string;
  category_id: string;
  description: string;
  amount: number;
  receipt_no: string | null;
  receipt_path: string | null;
  flags: string[];
}

export interface AuditEntry {
  id: number;
  entity_type: string;
  entity_id: string | null;
  action: string;
  actor_id: string | null;
  from_status: string | null;
  to_status: string | null;
  remark: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Notification {
  id: string;
  recipient_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface TeamAbsence {
  request_id: string;
  employee_id: string;
  full_name: string;
  department: string | null;
  start_date: string;
  end_date: string;
  half_day: string | null;
  days: number;
  status: string;
  leave_code: string;
  leave_name: string;
  color: string;
  is_mine: boolean;
}
