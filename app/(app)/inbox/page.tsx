'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { Alert, Avatar, Card, Empty, FlagBadges, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { AttachmentLink, ClaimDetailModal, LeaveDetailModal } from '@/components/Details';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtDate, fmtDateTime, fmtDays, fmtRange, money, sgToday, workingDaysBetween } from '@/lib/format';
import type { Claim, LeaveRequest } from '@/lib/types';

type Tab = 'leave' | 'claims' | 'decided';

export default function InboxPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}

function Inbox() {
  const app = useApp();
  const me = app.me!;
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'claims' ? 'claims' : 'leave');
  const [leave, setLeave] = useState<LeaveRequest[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [decidedLeave, setDecidedLeave] = useState<LeaveRequest[]>([]);
  const [decidedClaims, setDecidedClaims] = useState<Claim[]>([]);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [openLeave, setOpenLeave] = useState<LeaveRequest | null>(null);
  const [openClaim, setOpenClaim] = useState<Claim | null>(null);
  const holidaySet = useMemo(() => new Set(app.holidays.map((h) => h.holiday_date)), [app.holidays]);
  const today = sgToday();

  const load = useCallback(async () => {
    const sb = supabase();
    const mine = `approver_id.eq.${me.id},escalated_to.eq.${me.id}`;
    const [l, c, dl, dc] = await Promise.all([
      sb.from('leave_requests').select('*').eq('status', 'pending').or(mine).neq('employee_id', me.id).order('submitted_at'),
      sb.from('claims').select('*, claim_lines(*)').eq('status', 'pending').or(mine).neq('employee_id', me.id).order('submitted_at'),
      sb.from('leave_requests').select('*').eq('decided_by', me.id).order('decided_at', { ascending: false }).limit(25),
      sb.from('claims').select('*').eq('decided_by', me.id).order('decided_at', { ascending: false }).limit(25),
    ]);
    setLeave((l.data ?? []) as LeaveRequest[]);
    setClaims(
      ((c.data ?? []) as Claim[]).map((x) => ({
        ...x,
        claim_lines: [...(x.claim_lines ?? [])].sort((a, b) => a.line_no - b.line_no),
      })),
    );
    setDecidedLeave((dl.data ?? []) as LeaveRequest[]);
    setDecidedClaims((dc.data ?? []) as Claim[]);
  }, [me.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = (submittedAt: string) => {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(submittedAt));
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const n = d >= today ? 0 : workingDaysBetween(next.toISOString().slice(0, 10), today, holidaySet);
    return n;
  };

  const decide = async (kind: 'leave' | 'claim', id: string, decision: 'approve' | 'reject', reference: string) => {
    setBusyId(id);
    setErrors((e) => ({ ...e, [id]: '' }));
    const remark = remarks[id] ?? '';
    const { error } =
      kind === 'leave'
        ? await supabase().rpc('decide_leave_request', { p_request_id: id, p_decision: decision, p_remark: remark || null })
        : await supabase().rpc('decide_claim', { p_claim_id: id, p_decision: decision, p_remark: remark || null });
    setBusyId(null);
    if (error) {
      setErrors((e) => ({ ...e, [id]: errorMessage(error) }));
      return;
    }
    setFlash(
      `${reference} ${decision === 'approve' ? 'approved' : 'rejected'}.${
        decision === 'approve' ? (kind === 'leave' ? ' The Master Leave Record has been updated.' : ' It is now with Finance for payment.') : ''
      }`,
    );
    await load();
    void app.refreshActivity();
  };

  const SlaChip = ({ submittedAt }: { submittedAt: string }) => {
    const n = waiting(submittedAt);
    const tone = n >= 2 ? 'bad' : n >= 1 ? 'warn' : 'good';
    return <span className={`sla sla-${tone}`}>{n === 0 ? 'Submitted today' : `Waiting ${n} working day${n === 1 ? '' : 's'}`}</span>;
  };

  return (
    <div>
      <PageHeader title="Inbox" subtitle="Decide within 2 working days. Requests are reminded after 1 day and escalated to your manager after 2." />
      {flash && <Alert tone="success">{flash}</Alert>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'leave', label: `Leave (${leave.length})` },
          { id: 'claims', label: `Claims (${claims.length})` },
          { id: 'decided', label: 'Recently decided' },
        ]}
      />

      {tab === 'leave' && (
        <div className="stack">
          {leave.length === 0 && <Empty>No leave requests are waiting for you.</Empty>}
          {leave.map((r) => {
            const emp = app.employeeById(r.employee_id);
            const type = app.leaveTypeById(r.leave_type_id);
            const ev = r.evaluation;
            return (
              <Card key={r.id} className="task">
                <div className="task-head">
                  <Avatar name={emp?.full_name ?? '?'} size={40} />
                  <div className="grow">
                    <div>
                      <strong>{emp?.full_name}</strong> <span className="muted">· {emp?.job_title}</span>
                    </div>
                    <div className="muted small">
                      {r.reference} · submitted {fmtDateTime(r.submitted_at)}
                      {r.escalated_to === me.id && ' · escalated to you'}
                    </div>
                  </div>
                  <SlaChip submittedAt={r.submitted_at} />
                </div>
                <div className="task-body">
                  <div className="task-main">
                    <div className="task-title">
                      <span className="swatch" style={{ background: type?.color }} /> {type?.name} · {fmtRange(r.start_date, r.end_date, r.half_day)} ·{' '}
                      <strong>{fmtDays(r.days)} working day(s)</strong>
                    </div>
                    {r.reason && <p>“{r.reason}”</p>}
                    {r.document_ref && (
                      <p className="small">
                        {type?.document_label ?? 'Document'}: <strong>{r.document_ref}</strong>
                      </p>
                    )}
                    <AttachmentLink path={r.attachment_path} />
                    <FlagBadges flags={r.flags} />
                    {ev?.notes && ev.notes.length > 0 && (
                      <ul className="notes-list">
                        {ev.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                    {ev?.clashes && ev.clashes.length > 0 && (
                      <p className="small">
                        Also away: {ev.clashes.map((c) => `${c.name} (${fmtRange(c.start, c.end)}, ${c.status})`).join('; ')}
                      </p>
                    )}
                  </div>
                  {ev?.balance?.checked && (
                    <div className="task-side">
                      <div className="muted small">Balance at submission</div>
                      <div>
                        <strong>{fmtDays(ev.balance.available)}</strong> available
                      </div>
                      <div>
                        <strong>{fmtDays(ev.balance.after)}</strong> after approval
                      </div>
                      <div className="muted small">of {fmtDays(ev.balance.total)} entitled</div>
                    </div>
                  )}
                </div>
                <div className="task-actions">
                  <input
                    className="grow"
                    placeholder="Remark (required to reject)"
                    value={remarks[r.id] ?? ''}
                    onChange={(e) => setRemarks((m) => ({ ...m, [r.id]: e.target.value }))}
                  />
                  <button className="btn" onClick={() => setOpenLeave(r)}>
                    Details
                  </button>
                  <button className="btn btn-danger-outline" disabled={busyId === r.id} onClick={() => void decide('leave', r.id, 'reject', r.reference)}>
                    Reject
                  </button>
                  <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => void decide('leave', r.id, 'approve', r.reference)}>
                    Approve
                  </button>
                </div>
                {errors[r.id] && <Alert>{errors[r.id]}</Alert>}
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'claims' && (
        <div className="stack">
          {claims.length === 0 && <Empty>No claims are waiting for you.</Empty>}
          {claims.map((c) => {
            const emp = app.employeeById(c.employee_id);
            return (
              <Card key={c.id} className="task">
                <div className="task-head">
                  <Avatar name={emp?.full_name ?? '?'} size={40} />
                  <div className="grow">
                    <div>
                      <strong>{emp?.full_name}</strong> <span className="muted">· {emp?.job_title}</span>
                    </div>
                    <div className="muted small">
                      {c.reference} · submitted {fmtDateTime(c.submitted_at)}
                      {c.escalated_to === me.id && ' · escalated to you'}
                    </div>
                  </div>
                  <SlaChip submittedAt={c.submitted_at} />
                </div>
                <div className="task-title">
                  {c.title} · <strong>{money(c.total_amount)}</strong> <FlagBadges flags={c.flags} />
                </div>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th>Receipt</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(c.claim_lines ?? []).map((l) => {
                      const cat = app.categoryById(l.category_id);
                      return (
                        <tr key={l.id}>
                          <td>{fmtDate(l.expense_date)}</td>
                          <td>{cat?.name}</td>
                          <td>
                            {l.description} <FlagBadges flags={l.flags} />
                            {l.flags.includes('over_limit') && cat?.limit_per_line && (
                              <span className="muted small"> (guideline {money(cat.limit_per_line)})</span>
                            )}
                          </td>
                          <td>
                            {l.receipt_no || '—'} <AttachmentLink path={l.receipt_path} label="" />
                          </td>
                          <td className="num">{money(l.amount, '')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="task-actions">
                  <input
                    className="grow"
                    placeholder="Remark (required to reject)"
                    value={remarks[c.id] ?? ''}
                    onChange={(e) => setRemarks((m) => ({ ...m, [c.id]: e.target.value }))}
                  />
                  <button className="btn" onClick={() => setOpenClaim(c)}>
                    Details
                  </button>
                  <button className="btn btn-danger-outline" disabled={busyId === c.id} onClick={() => void decide('claim', c.id, 'reject', c.reference)}>
                    Reject
                  </button>
                  <button className="btn btn-primary" disabled={busyId === c.id} onClick={() => void decide('claim', c.id, 'approve', c.reference)}>
                    Approve
                  </button>
                </div>
                {errors[c.id] && <Alert>{errors[c.id]}</Alert>}
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'decided' && (
        <Card>
          {decidedLeave.length + decidedClaims.length === 0 ? (
            <Empty>You haven’t decided anything yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table hover">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Employee</th>
                    <th>Item</th>
                    <th>Decision</th>
                    <th>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {decidedLeave.map((r) => (
                    <tr key={r.id} onClick={() => setOpenLeave(r)}>
                      <td className="mono">{r.reference}</td>
                      <td>{app.employeeById(r.employee_id)?.full_name}</td>
                      <td>
                        {app.leaveTypeById(r.leave_type_id)?.name} · {fmtRange(r.start_date, r.end_date, r.half_day)}
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="muted small">{fmtDateTime(r.decided_at)}</td>
                    </tr>
                  ))}
                  {decidedClaims.map((c) => (
                    <tr key={c.id} onClick={() => setOpenClaim(c)}>
                      <td className="mono">{c.reference}</td>
                      <td>{app.employeeById(c.employee_id)?.full_name}</td>
                      <td>
                        {c.title} · {money(c.total_amount)}
                      </td>
                      <td>
                        <StatusBadge status={c.status} kind="claim" />
                      </td>
                      <td className="muted small">{fmtDateTime(c.decided_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {openLeave && <LeaveDetailModal request={openLeave} onClose={() => setOpenLeave(null)} onChanged={() => void load()} />}
      {openClaim && <ClaimDetailModal claim={openClaim} onClose={() => setOpenClaim(null)} onChanged={() => void load()} />}
    </div>
  );
}
