'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Alert, Card, Empty, FlagBadges, Modal, PageHeader, Stat, StatusBadge, Tabs } from '@/components/ui';
import { ClaimDetailModal } from '@/components/Details';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { downloadCsv, fmtDate, fmtDateTime, money, sgToday } from '@/lib/format';
import type { Claim } from '@/lib/types';

type Tab = 'ready' | 'returned' | 'paid';

export default function FinancePage() {
  const app = useApp();
  if (!app.isFinance) return <Empty>The Finance workspace is available to Finance and administrators.</Empty>;
  return <FinanceWorkspace />;
}

function FinanceWorkspace() {
  const app = useApp();
  const today = sgToday();
  const [tab, setTab] = useState<Tab>('ready');
  const [claims, setClaims] = useState<Claim[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Claim | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [ref, setRef] = useState(`PAYROLL-${today.slice(0, 7)}`);
  const [returning, setReturning] = useState<Claim | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase()
      .from('claims')
      .select('*, claim_lines(*)')
      .in('status', ['approved', 'returned', 'paid'])
      .order('decided_at', { ascending: true });
    setClaims((data ?? []) as Claim[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = claims.filter((c) => c.status === 'approved');
  const returned = claims.filter((c) => c.status === 'returned');
  const paid = claims.filter((c) => c.status === 'paid').sort((a, b) => (b.paid_on ?? '').localeCompare(a.paid_on ?? ''));
  const selectedClaims = ready.filter((c) => selected.has(c.id));
  const selectedTotal = selectedClaims.reduce((s, c) => s + Number(c.total_amount), 0);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const pay = async () => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase().rpc('pay_claims', {
      p_claim_ids: [...selected],
      p_paid_on: paidOn,
      p_payment_reference: ref,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setFlash(`${String(data)} claim(s) marked paid under ${ref}. Staff have been notified.`);
    setSelected(new Set());
    setPayOpen(false);
    await load();
  };

  const doReturn = async () => {
    if (!returning) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase().rpc('return_claim', { p_claim_id: returning.id, p_reason: returnReason });
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setFlash(`${returning.reference} returned to ${app.employeeById(returning.employee_id)?.full_name}.`);
    setReturning(null);
    setReturnReason('');
    await load();
  };

  const exportRows = (list: Claim[], filename: string) => {
    const rows: (string | number | null | undefined)[][] = [];
    list.forEach((c) => {
      const emp = app.employeeById(c.employee_id);
      (c.claim_lines ?? [])
        .slice()
        .sort((a, b) => a.line_no - b.line_no)
        .forEach((l) => {
          const cat = app.categoryById(l.category_id);
          rows.push([
            c.reference,
            emp?.employee_no,
            emp?.full_name,
            app.departmentById(emp?.department_id)?.name,
            l.line_no,
            l.expense_date,
            cat?.code,
            cat?.gl_code,
            l.description,
            l.receipt_no,
            Number(l.amount).toFixed(2),
            c.status,
            app.employeeById(c.decided_by)?.full_name,
            c.paid_on,
            c.payment_reference,
          ]);
        });
    });
    downloadCsv(
      filename,
      ['Claim', 'Employee no', 'Employee', 'Department', 'Line', 'Expense date', 'Category', 'GL code', 'Description', 'Receipt no', 'Amount SGD', 'Status', 'Approved by', 'Paid on', 'Payment ref'],
      rows,
    );
  };

  const byMonth = useMemo(() => {
    const m = new Map<string, number>();
    paid.forEach((c) => {
      const k = (c.paid_on ?? '').slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + Number(c.total_amount));
    });
    return [...m.entries()].sort();
  }, [paid]);

  const list = tab === 'ready' ? ready : tab === 'returned' ? returned : paid;

  return (
    <div>
      <PageHeader title="Finance" subtitle="Claims approved by Department Heads, ready to pay in the next payroll." />
      <div className="stats">
        <Stat label="Ready to pay" value={money(ready.reduce((s, c) => s + Number(c.total_amount), 0))} hint={`${ready.length} claim(s)`} />
        <Stat label="Returned to staff" value={String(returned.length)} tone={returned.length ? 'warn' : undefined} />
        <Stat label={`Paid ${today.slice(0, 4)}`} value={money(paid.filter((c) => (c.paid_on ?? '').startsWith(today.slice(0, 4))).reduce((s, c) => s + Number(c.total_amount), 0))} tone="good" />
        <Stat label="Last payroll" value={byMonth.length ? byMonth[byMonth.length - 1]![0] : '—'} hint={byMonth.length ? money(byMonth[byMonth.length - 1]![1]) : undefined} />
      </div>
      {flash && <Alert tone="success">{flash}</Alert>}
      {error && !payOpen && !returning && <Alert>{error}</Alert>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'ready', label: `Ready to pay (${ready.length})` },
          { id: 'returned', label: `Returned (${returned.length})` },
          { id: 'paid', label: `Paid (${paid.length})` },
        ]}
      />
      <Card
        actions={
          <>
            {tab === 'ready' && (
              <button className="btn btn-primary" disabled={selected.size === 0} onClick={() => setPayOpen(true)}>
                Mark {selected.size || ''} paid{selected.size ? ` · ${money(selectedTotal)}` : ''}
              </button>
            )}
            <button className="btn" disabled={list.length === 0} onClick={() => exportRows(list, `claims-${tab}-${today}.csv`)}>
              Export CSV for payroll
            </button>
          </>
        }
      >
        {list.length === 0 ? (
          <Empty>{tab === 'ready' ? 'Nothing waiting for payment.' : 'Nothing here.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead>
                <tr>
                  {tab === 'ready' && (
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === ready.length && ready.length > 0}
                        onChange={(e) => setSelected(e.target.checked ? new Set(ready.map((c) => c.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th>Reference</th>
                  <th>Employee</th>
                  <th>Title</th>
                  <th className="num">Lines</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th>{tab === 'paid' ? 'Paid' : 'Approved'}</th>
                  {tab === 'ready' && <th />}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c)}>
                    {tab === 'ready' && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.reference}`} />
                      </td>
                    )}
                    <td className="mono">{c.reference}</td>
                    <td>{app.employeeById(c.employee_id)?.full_name}</td>
                    <td>
                      {c.title} <FlagBadges flags={c.flags} />
                      {c.return_reason && c.status === 'returned' && <div className="small warn-text">{c.return_reason}</div>}
                    </td>
                    <td className="num">{c.claim_lines?.length ?? 0}</td>
                    <td className="num">{money(c.total_amount)}</td>
                    <td>
                      <StatusBadge status={c.status} kind="claim" />
                    </td>
                    <td className="small">
                      {tab === 'paid' ? `${fmtDate(c.paid_on)} · ${c.payment_reference}` : `${fmtDateTime(c.decided_at)} · ${app.employeeById(c.decided_by)?.full_name ?? ''}`}
                    </td>
                    {tab === 'ready' && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="link danger" onClick={() => setReturning(c)}>
                          Return
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {payOpen && (
        <Modal
          title={`Record payment · ${selectedClaims.length} claim(s) · ${money(selectedTotal)}`}
          onClose={() => setPayOpen(false)}
          footer={
            <div className="row gap end">
              <button className="btn" onClick={() => setPayOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void pay()}>
                Mark paid
              </button>
            </div>
          }
        >
          <div className="form">
            <label>
              Payment date
              <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </label>
            <label>
              Payment / payroll reference
              <input value={ref} onChange={(e) => setRef(e.target.value)} />
            </label>
            <ul className="list">
              {selectedClaims.map((c) => (
                <li key={c.id} className="list-row">
                  <span>
                    {c.reference} · {app.employeeById(c.employee_id)?.full_name}
                  </span>
                  <span>{money(c.total_amount)}</span>
                </li>
              ))}
            </ul>
            {error && <Alert>{error}</Alert>}
          </div>
        </Modal>
      )}

      {returning && (
        <Modal
          title={`Return ${returning.reference} to staff`}
          onClose={() => setReturning(null)}
          footer={
            <div className="row gap end">
              <button className="btn" onClick={() => setReturning(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => void doReturn()}>
                Return claim
              </button>
            </div>
          }
        >
          <div className="form">
            <label>
              Reason (sent to the claimant and approver)
              <textarea rows={3} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="e.g. Receipt for line 2 is missing" />
            </label>
            {error && <Alert>{error}</Alert>}
          </div>
        </Modal>
      )}

      {open && <ClaimDetailModal claim={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </div>
  );
}
