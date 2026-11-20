'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Alert, Card, Empty, FlagBadges, Modal, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { LeaveDetailModal } from '@/components/Details';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { downloadCsv, fmtDate, fmtDateTime, fmtDays, fmtRange, sgToday } from '@/lib/format';
import type { AppRole, Employee, LedgerEntry, LeaveBalance, LeaveRequest } from '@/lib/types';

type Tab = 'record' | 'balances' | 'requests' | 'workers' | 'holidays';

export default function HrPage() {
  const app = useApp();
  if (!app.isHr) {
    return <Empty>The HR workspace is available to HR and administrators.</Empty>;
  }
  return <HrWorkspace />;
}

function HrWorkspace() {
  const app = useApp();
  const thisYear = Number(sgToday().slice(0, 4));
  const [tab, setTab] = useState<Tab>('record');
  const [year, setYear] = useState(thisYear);
  const [dept, setDept] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runReminders = async () => {
    setError(null);
    const { data, error: err } = await supabase().rpc('process_reminders');
    if (err) setError(errorMessage(err));
    else {
      const r = data as { reminded: number; escalated: number };
      setFlash(`Reminders sent: ${r.reminded}. Escalated: ${r.escalated}. (This also runs automatically every hour.)`);
    }
  };

  return (
    <div>
      <PageHeader
        title="HR Workspace"
        subtitle="Master Leave Record, entitlements, worker records and public holidays."
        actions={
          <>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {app.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => void runReminders()}>
              Run reminders now
            </button>
          </>
        }
      />
      {flash && <Alert tone="success">{flash}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'record', label: 'Master Leave Record' },
          { id: 'balances', label: 'Balances & entitlements' },
          { id: 'requests', label: 'All leave requests' },
          { id: 'workers', label: 'Workers' },
          { id: 'holidays', label: 'Public holidays' },
        ]}
      />
      {tab === 'record' && <MasterRecord year={year} dept={dept} />}
      {tab === 'balances' && <Balances year={year} dept={dept} onFlash={setFlash} />}
      {tab === 'requests' && <AllRequests year={year} dept={dept} />}
      {tab === 'workers' && <Workers onFlash={setFlash} />}
      {tab === 'holidays' && <Holidays year={year} />}
    </div>
  );
}

function MasterRecord({ year, dept }: { year: number; dept: string }) {
  const app = useApp();
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [requests, setRequests] = useState<Map<string, LeaveRequest>>(new Map());
  const [type, setType] = useState('');

  useEffect(() => {
    void (async () => {
      const sb = supabase();
      const { data } = await sb.from('leave_ledger').select('*').eq('year', year).order('created_at', { ascending: false });
      const list = (data ?? []) as LedgerEntry[];
      setRows(list);
      const ids = [...new Set(list.map((l) => l.request_id).filter((x): x is string => !!x))];
      if (ids.length) {
        const { data: reqs } = await sb.from('leave_requests').select('*').in('id', ids);
        setRequests(new Map(((reqs ?? []) as LeaveRequest[]).map((r) => [r.id, r])));
      } else setRequests(new Map());
    })();
  }, [year]);

  const filtered = rows.filter((l) => {
    const emp = app.employeeById(l.employee_id);
    return (!dept || emp?.department_id === dept) && (!type || l.leave_type_id === type);
  });

  const exportCsv = () => {
    downloadCsv(
      `master-leave-record-${year}.csv`,
      ['Posted', 'Employee no', 'Employee', 'Department', 'Leave type', 'Reference', 'Start', 'End', 'Entry', 'Days', 'Approved by', 'Note'],
      filtered.map((l) => {
        const emp = app.employeeById(l.employee_id);
        const req = l.request_id ? requests.get(l.request_id) : undefined;
        return [
          fmtDateTime(l.created_at),
          emp?.employee_no,
          emp?.full_name,
          app.departmentById(emp?.department_id)?.name,
          app.leaveTypeById(l.leave_type_id)?.code,
          req?.reference,
          l.start_date,
          l.end_date,
          l.entry_type,
          Number(l.days),
          app.employeeById(req?.decided_by)?.full_name,
          l.note,
        ];
      }),
    );
  };

  return (
    <Card
      title={`Master Leave Record ${year}`}
      actions={
        <>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Leave type">
            <option value="">All leave types</option>
            {app.leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={exportCsv} disabled={filtered.length === 0}>
            Export CSV
          </button>
        </>
      }
    >
      <p className="muted small">Entries are written automatically when leave is approved or an approved request is cancelled. Nothing here is typed in by hand.</p>
      {filtered.length === 0 ? (
        <Empty>No entries.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Posted</th>
                <th>Employee</th>
                <th>Department</th>
                <th>Type</th>
                <th>Reference</th>
                <th>Dates</th>
                <th>Entry</th>
                <th className="num">Days</th>
                <th>Approved by</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                const emp = app.employeeById(l.employee_id);
                const req = l.request_id ? requests.get(l.request_id) : undefined;
                return (
                  <tr key={l.id}>
                    <td className="muted small">{fmtDateTime(l.created_at)}</td>
                    <td>{emp?.full_name}</td>
                    <td>{app.departmentById(emp?.department_id)?.name}</td>
                    <td>{app.leaveTypeById(l.leave_type_id)?.code}</td>
                    <td className="mono">{req?.reference ?? '—'}</td>
                    <td>{l.start_date ? fmtRange(l.start_date, l.end_date ?? l.start_date) : '—'}</td>
                    <td>{l.entry_type === 'taken' ? 'Taken' : 'Reversal'}</td>
                    <td className="num">{fmtDays(l.days)}</td>
                    <td>{app.employeeById(req?.decided_by)?.full_name ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Balances({ year, dept, onFlash }: { year: number; dept: string; onFlash: (s: string) => void }) {
  const app = useApp();
  const [rows, setRows] = useState<LeaveBalance[]>([]);
  const [edit, setEdit] = useState<LeaveBalance | null>(null);
  const [form, setForm] = useState({ entitled: '', carried: '', adjustment: '', note: '' });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase().from('leave_balances').select('*').eq('year', year);
    setRows((data ?? []) as LeaveBalance[]);
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const types = app.leaveTypes.filter((t) => t.is_active && t.balance_check);
  const people = app.employees.filter((e) => e.is_active && (!dept || e.department_id === dept));
  const cell = (empId: string, typeId: string) => rows.find((r) => r.employee_id === empId && r.leave_type_id === typeId);

  const generate = async () => {
    const { data, error: err } = await supabase().rpc('hr_generate_entitlements', { p_year: year });
    if (err) setError(errorMessage(err));
    else {
      onFlash(`Entitlements checked for ${String(data)} workers for ${year}. Existing figures were kept.`);
      await load();
    }
  };

  const save = async () => {
    if (!edit) return;
    setError(null);
    const { error: err } = await supabase().rpc('hr_set_entitlement', {
      p_employee_id: edit.employee_id,
      p_leave_type_id: edit.leave_type_id,
      p_year: year,
      p_entitled_days: Number(form.entitled),
      p_carried_forward: Number(form.carried || 0),
      p_adjustment: Number(form.adjustment || 0),
      p_note: form.note || null,
    });
    if (err) {
      setError(errorMessage(err));
      return;
    }
    onFlash(`Updated ${edit.name} for ${app.employeeById(edit.employee_id)?.full_name}.`);
    setEdit(null);
    await load();
  };

  const exportCsv = () => {
    const headers = ['Employee no', 'Employee', 'Department', ...types.flatMap((t) => [`${t.code} entitled`, `${t.code} taken`, `${t.code} pending`, `${t.code} available`])];
    downloadCsv(
      `leave-balances-${year}.csv`,
      headers,
      people.map((p) => [
        p.employee_no,
        p.full_name,
        app.departmentById(p.department_id)?.name,
        ...types.flatMap((t) => {
          const b = cell(p.id, t.id);
          return [b?.total_entitlement ?? '', b?.taken ?? '', b?.pending ?? '', b?.available ?? ''];
        }),
      ]),
    );
  };

  return (
    <Card
      title={`Balances ${year}`}
      actions={
        <>
          <button className="btn" onClick={() => void generate()}>
            Generate {year} entitlements
          </button>
          <button className="btn" onClick={exportCsv}>
            Export CSV
          </button>
        </>
      }
    >
      <p className="muted small">Available = contract entitlement + carry forward + adjustment − approved − pending. Click a figure to edit the entitlement.</p>
      {error && <Alert>{error}</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              {types.map((t) => (
                <th key={t.id} className="num">
                  {t.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.full_name}
                  <div className="muted small">
                    {app.departmentById(p.department_id)?.name} · joined {fmtDate(p.hire_date)}
                  </div>
                </td>
                {types.map((t) => {
                  const b = cell(p.id, t.id);
                  return (
                    <td key={t.id} className="num">
                      {b ? (
                        <button
                          className="cell-btn"
                          title={`${fmtDays(b.taken)} taken, ${fmtDays(b.pending)} pending`}
                          onClick={() => {
                            setEdit(b);
                            setForm({
                              entitled: String(b.entitled_days),
                              carried: String(b.carried_forward),
                              adjustment: String(b.adjustment),
                              note: '',
                            });
                          }}
                        >
                          <strong>{fmtDays(b.available)}</strong>
                          <span className="muted"> / {fmtDays(b.total_entitlement)}</span>
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal
          title={`${edit.name} · ${app.employeeById(edit.employee_id)?.full_name} · ${year}`}
          onClose={() => setEdit(null)}
          footer={
            <div className="row gap end">
              <button className="btn" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void save()}>
                Save
              </button>
            </div>
          }
        >
          <div className="form">
            <label>
              Contract entitlement (days)
              <input type="number" step="0.5" min="0" value={form.entitled} onChange={(e) => setForm({ ...form, entitled: e.target.value })} />
            </label>
            <div className="row gap">
              <label className="grow">
                Carried forward
                <input type="number" step="0.5" value={form.carried} onChange={(e) => setForm({ ...form, carried: e.target.value })} />
              </label>
              <label className="grow">
                Adjustment (+/−)
                <input type="number" step="0.5" value={form.adjustment} onChange={(e) => setForm({ ...form, adjustment: e.target.value })} />
              </label>
            </div>
            <label>
              Note for the audit trail
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Contract renewal 2027: 16 days" />
            </label>
            <p className="muted small">
              Currently {fmtDays(edit.taken)} taken and {fmtDays(edit.pending)} pending.
            </p>
            {error && <Alert>{error}</Alert>}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function AllRequests({ year, dept }: { year: number; dept: string }) {
  const app = useApp();
  const [rows, setRows] = useState<LeaveRequest[]>([]);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<LeaveRequest | null>(null);

  const load = useCallback(async () => {
    let q = supabase().from('leave_requests').select('*').eq('year', year).order('submitted_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data } = await q;
    setRows((data ?? []) as LeaveRequest[]);
  }, [year, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = rows.filter((r) => !dept || app.employeeById(r.employee_id)?.department_id === dept);

  return (
    <Card
      title="All leave requests"
      actions={
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="pending">Awaiting approval</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      }
    >
      {filtered.length === 0 ? (
        <Empty>No requests.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table hover">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Employee</th>
                <th>Type</th>
                <th>Dates</th>
                <th className="num">Days</th>
                <th>Status</th>
                <th>Approver</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r)}>
                  <td className="mono">{r.reference}</td>
                  <td>{app.employeeById(r.employee_id)?.full_name}</td>
                  <td>{app.leaveTypeById(r.leave_type_id)?.code}</td>
                  <td>{fmtRange(r.start_date, r.end_date, r.half_day)}</td>
                  <td className="num">{fmtDays(r.days)}</td>
                  <td>
                    <StatusBadge status={r.status} /> <FlagBadges flags={r.flags} />
                  </td>
                  <td>{app.employeeById(r.escalated_to ?? r.approver_id)?.full_name}</td>
                  <td className="muted small">{fmtDateTime(r.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <LeaveDetailModal request={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </Card>
  );
}

const ROLES: { id: AppRole; label: string }[] = [
  { id: 'employee', label: 'Employee' },
  { id: 'hr', label: 'HR' },
  { id: 'finance', label: 'Finance' },
  { id: 'admin', label: 'Administrator' },
];

type WorkerForm = {
  id?: string;
  employee_no: string;
  full_name: string;
  email: string;
  job_title: string;
  department_id: string;
  manager_id: string;
  role: AppRole;
  hire_date: string;
  is_active: boolean;
};

function Workers({ onFlash }: { onFlash: (s: string) => void }) {
  const app = useApp();
  const [form, setForm] = useState<WorkerForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nextNo = useMemo(() => {
    const max = app.employees.reduce((m, e) => Math.max(m, Number(e.employee_no.replace(/\D/g, '')) || 0), 0);
    return `E${String(max + 1).padStart(4, '0')}`;
  }, [app.employees]);

  const openNew = () =>
    setForm({
      employee_no: nextNo,
      full_name: '',
      email: '',
      job_title: '',
      department_id: '',
      manager_id: '',
      role: 'employee',
      hire_date: sgToday(),
      is_active: true,
    });

  const openEdit = (e: Employee) =>
    setForm({
      id: e.id,
      employee_no: e.employee_no,
      full_name: e.full_name,
      email: e.email,
      job_title: e.job_title ?? '',
      department_id: e.department_id ?? '',
      manager_id: e.manager_id ?? '',
      role: e.role,
      hire_date: e.hire_date,
      is_active: e.is_active,
    });

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    const row = {
      employee_no: form.employee_no.trim(),
      full_name: form.full_name.trim(),
      email: form.email.trim().toLowerCase(),
      job_title: form.job_title.trim() || null,
      department_id: form.department_id || null,
      manager_id: form.manager_id || null,
      role: form.role,
      hire_date: form.hire_date,
      is_active: form.is_active,
    };
    const sb = supabase();
    const { error: err } = form.id ? await sb.from('employees').update(row).eq('id', form.id) : await sb.from('employees').insert(row);
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    onFlash(
      form.id
        ? `Saved ${row.full_name}.`
        : `Added ${row.full_name}. They can now create an account with ${row.email} — it links to this record automatically.`,
    );
    setForm(null);
    await app.reload();
  };

  return (
    <Card
      title={`Workers (${app.employees.length})`}
      actions={
        <button className="btn btn-primary" onClick={openNew}>
          Add worker
        </button>
      }
    >
      <div className="table-wrap">
        <table className="table hover">
          <thead>
            <tr>
              <th>No.</th>
              <th>Name</th>
              <th>Job title</th>
              <th>Department</th>
              <th>Manager (approver)</th>
              <th>Role</th>
              <th>Hired</th>
              <th>Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {app.employees.map((e) => (
              <tr key={e.id} onClick={() => openEdit(e)} className={e.is_active ? '' : 'inactive'}>
                <td className="mono">{e.employee_no}</td>
                <td>
                  {e.full_name}
                  <div className="muted small">{e.email}</div>
                </td>
                <td>{e.job_title}</td>
                <td>{app.departmentById(e.department_id)?.name}</td>
                <td>{app.employeeById(e.manager_id)?.full_name ?? '—'}</td>
                <td>{ROLES.find((r) => r.id === e.role)?.label}</td>
                <td>{fmtDate(e.hire_date)}</td>
                <td>{e.user_id ? <span className="badge status-approved">Linked</span> : <span className="badge status-pending">Not yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && (
        <Modal
          title={form.id ? `Edit ${form.full_name}` : 'Add worker'}
          onClose={() => setForm(null)}
          footer={
            <div className="row gap end">
              <button className="btn" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                Save
              </button>
            </div>
          }
        >
          <div className="form">
            <div className="row gap">
              <label>
                Employee no.
                <input value={form.employee_no} onChange={(e) => setForm({ ...form, employee_no: e.target.value })} />
              </label>
              <label className="grow">
                Full name
                <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              </label>
            </div>
            <label>
              Work e-mail (used to link their sign-in)
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label>
              Job title
              <input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
            </label>
            <div className="row gap">
              <label className="grow">
                Department
                <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
                  <option value="">—</option>
                  {app.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Manager / approver
                <select value={form.manager_id} onChange={(e) => setForm({ ...form, manager_id: e.target.value })}>
                  <option value="">—</option>
                  {app.employees
                    .filter((e) => e.id !== form.id && e.is_active)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.full_name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="row gap">
              <label className="grow">
                Access role
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}>
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Hire date
                <input type="date" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              <span>Active</span>
            </label>
            <p className="muted small">New workers get this year’s entitlements automatically (annual leave pro-rated in the year they join).</p>
            {error && <Alert>{error}</Alert>}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Holidays({ year }: { year: number }) {
  const app = useApp();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = app.holidays.filter((h) => h.year === year);

  const add = async () => {
    setError(null);
    const { error: err } = await supabase().from('public_holidays').insert({ holiday_date: date, name: name.trim(), is_in_lieu: false });
    if (err) setError(errorMessage(err));
    else {
      setDate('');
      setName('');
      await app.reload();
    }
  };

  const remove = async (d: string) => {
    const { error: err } = await supabase().from('public_holidays').delete().eq('holiday_date', d);
    if (err) setError(errorMessage(err));
    else await app.reload();
  };

  return (
    <Card title={`Public holidays ${year}`}>
      <p className="muted small">Gazetted holidays (MOM). Days marked in lieu replace holidays that fall on a Sunday. Working-day counts skip all of these.</p>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Holiday</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((h) => (
            <tr key={h.holiday_date}>
              <td>{fmtDate(h.holiday_date)}</td>
              <td>
                {h.name} {h.is_in_lieu && <span className="badge">in lieu</span>}
              </td>
              <td className="num">
                <button className="link danger" onClick={() => void remove(h.holiday_date)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row gap">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Holiday date" />
        <input className="grow" placeholder="Holiday name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!date || !name.trim()} onClick={() => void add()}>
          Add holiday
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}
