'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Alert, FlagBadges, Modal, StatusBadge } from '@/components/ui';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtDate, fmtDateTime, fmtDays, fmtRange, money, sgToday } from '@/lib/format';
import type { AuditEntry, Claim, ClaimLine, LeaveRequest } from '@/lib/types';

export function AttachmentLink({ path, label = 'View attachment' }: { path: string | null | undefined; label?: string }) {
  const [busy, setBusy] = useState(false);
  if (!path) return null;
  return (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { data, error } = await supabase().storage.from('attachments').createSignedUrl(path, 300);
        setBusy(false);
        if (error || !data) {
          alert(errorMessage(error));
          return;
        }
        window.open(data.signedUrl, '_blank', 'noopener');
      }}
    >
      📎 {label}
    </button>
  );
}

const ACTION_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  resubmitted: 'Corrected and resubmitted',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  reminded: 'Reminder sent to approver',
  escalated: 'Escalated',
  paid: 'Paid',
  returned: 'Returned by Finance',
};

export function AuditTrail({ entityType, entityId }: { entityType: 'leave' | 'claim'; entityId: string }) {
  const app = useApp();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase()
      .from('audit_log')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at')
      .then(({ data }) => {
        if (alive) setRows((data ?? []) as AuditEntry[]);
      });
    return () => {
      alive = false;
    };
  }, [entityType, entityId]);

  if (!rows) return <p className="muted small">Loading history…</p>;
  if (rows.length === 0) return <p className="muted small">No history yet.</p>;
  return (
    <ol className="timeline">
      {rows.map((r) => (
        <li key={r.id} className={`tl-${r.action}`}>
          <div className="tl-head">
            <strong>{ACTION_LABELS[r.action] ?? r.action}</strong>
            <span className="muted small">{fmtDateTime(r.created_at)}</span>
          </div>
          <div className="muted small">
            {r.actor_id ? app.employeeById(r.actor_id)?.full_name ?? 'Unknown' : 'System'}
            {r.action === 'escalated' && typeof r.meta?.escalated_to === 'string'
              ? ` → ${app.employeeById(r.meta.escalated_to as string)?.full_name ?? ''}`
              : ''}
            {r.action === 'paid' && typeof r.meta?.payment_reference === 'string' ? ` · ref ${r.meta.payment_reference as string}` : ''}
          </div>
          {r.remark && <div className="tl-remark">“{r.remark}”</div>}
        </li>
      ))}
    </ol>
  );
}

export function LeaveDetailModal({
  request,
  onClose,
  onChanged,
}: {
  request: LeaveRequest;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const app = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = app.leaveTypeById(request.leave_type_id);
  const employee = app.employeeById(request.employee_id);
  const isMine = request.employee_id === app.me?.id;
  const today = sgToday();
  const canCancel =
    (isMine && (request.status === 'pending' || (request.status === 'approved' && request.start_date > today))) ||
    (app.isHr && !isMine && (request.status === 'pending' || request.status === 'approved'));

  const cancel = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase().rpc('cancel_leave_request', {
      p_request_id: request.id,
      p_reason: reason || null,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    onChanged?.();
    onClose();
  };

  const ev = request.evaluation;

  return (
    <Modal
      title={
        <>
          {request.reference} <StatusBadge status={request.status} />
        </>
      }
      onClose={onClose}
      wide
      footer={
        canCancel ? (
          <div className="row gap">
            <input
              className="grow"
              placeholder={isMine ? 'Reason for cancelling (optional)' : 'Reason (required when cancelling for someone)'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button className="btn btn-danger" disabled={busy} onClick={() => void cancel()}>
              {request.status === 'approved' ? 'Cancel approved leave' : 'Withdraw request'}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="detail-grid">
        <div>
          <dl className="dl">
            <dt>Employee</dt>
            <dd>{employee?.full_name ?? '—'}</dd>
            <dt>Leave type</dt>
            <dd>
              <span className="swatch" style={{ background: type?.color }} /> {type?.name}
            </dd>
            <dt>Dates</dt>
            <dd>{fmtRange(request.start_date, request.end_date, request.half_day)}</dd>
            <dt>Working days</dt>
            <dd>{fmtDays(request.days)}</dd>
            <dt>Reason</dt>
            <dd>{request.reason || '—'}</dd>
            {request.document_ref && (
              <>
                <dt>{type?.document_label ?? 'Document'}</dt>
                <dd>{request.document_ref}</dd>
              </>
            )}
            <dt>Approver</dt>
            <dd>
              {app.employeeById(request.approver_id)?.full_name ?? '—'}
              {request.escalated_to && <> → escalated to {app.employeeById(request.escalated_to)?.full_name}</>}
            </dd>
            <dt>Submitted</dt>
            <dd>{fmtDateTime(request.submitted_at)}</dd>
            {request.decided_at && (
              <>
                <dt>Decided</dt>
                <dd>
                  {fmtDateTime(request.decided_at)} by {app.employeeById(request.decided_by)?.full_name}
                </dd>
              </>
            )}
            {request.decision_remark && (
              <>
                <dt>Remark</dt>
                <dd>{request.decision_remark}</dd>
              </>
            )}
            {request.cancel_reason && (
              <>
                <dt>Cancel reason</dt>
                <dd>{request.cancel_reason}</dd>
              </>
            )}
          </dl>
          <FlagBadges flags={request.flags} />
          {ev?.notes && ev.notes.length > 0 && (
            <ul className="notes-list">
              {ev.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {ev?.balance?.checked && (
            <p className="muted small">
              At submission: {fmtDays(ev.balance.available)} day(s) available → {fmtDays(ev.balance.after)} after this request.
            </p>
          )}
          <AttachmentLink path={request.attachment_path} />
          {error && <Alert>{error}</Alert>}
        </div>
        <div>
          <h4>History</h4>
          <AuditTrail entityType="leave" entityId={request.id} />
        </div>
      </div>
    </Modal>
  );
}

export function ClaimDetailModal({
  claim,
  onClose,
  onChanged,
  onResubmit,
}: {
  claim: Claim;
  onClose: () => void;
  onChanged?: () => void;
  onResubmit?: (c: Claim, lines: ClaimLine[]) => void;
}) {
  const app = useApp();
  const [lines, setLines] = useState<ClaimLine[] | null>(claim.claim_lines ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMine = claim.employee_id === app.me?.id;

  useEffect(() => {
    if (claim.claim_lines) return;
    void supabase()
      .from('claim_lines')
      .select('*')
      .eq('claim_id', claim.id)
      .order('line_no')
      .then(({ data }) => setLines((data ?? []) as ClaimLine[]));
  }, [claim]);

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase().rpc('cancel_claim', { p_claim_id: claim.id });
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    onChanged?.();
    onClose();
  };

  return (
    <Modal
      title={
        <>
          {claim.reference} <StatusBadge status={claim.status} kind="claim" />
        </>
      }
      onClose={onClose}
      wide
      footer={
        isMine && (claim.status === 'pending' || claim.status === 'returned') ? (
          <div className="row gap end">
            {claim.status === 'returned' && onResubmit && lines && (
              <button className="btn btn-primary" onClick={() => onResubmit(claim, lines)}>
                Correct &amp; resubmit
              </button>
            )}
            <button className="btn btn-danger" disabled={busy} onClick={() => void withdraw()}>
              Withdraw claim
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="detail-grid">
        <div>
          <dl className="dl">
            <dt>Claimant</dt>
            <dd>{app.employeeById(claim.employee_id)?.full_name}</dd>
            <dt>Title</dt>
            <dd>{claim.title}</dd>
            <dt>Total</dt>
            <dd>
              <strong>{money(claim.total_amount, claim.currency)}</strong>
            </dd>
            <dt>Approver</dt>
            <dd>
              {app.employeeById(claim.approver_id)?.full_name ?? '—'}
              {claim.escalated_to && <> → escalated to {app.employeeById(claim.escalated_to)?.full_name}</>}
            </dd>
            <dt>Submitted</dt>
            <dd>{fmtDateTime(claim.submitted_at)}</dd>
            {claim.decision_remark && (
              <>
                <dt>Approver remark</dt>
                <dd>{claim.decision_remark}</dd>
              </>
            )}
            {claim.return_reason && (
              <>
                <dt>Returned because</dt>
                <dd>{claim.return_reason}</dd>
              </>
            )}
            {claim.status === 'paid' && (
              <>
                <dt>Paid</dt>
                <dd>
                  {fmtDate(claim.paid_on)} · ref {claim.payment_reference}
                </dd>
              </>
            )}
          </dl>
          <FlagBadges flags={claim.flags} />
          <table className="table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Category</th>
                <th>Description</th>
                <th>Receipt</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.line_no}</td>
                  <td>{fmtDate(l.expense_date)}</td>
                  <td>{app.categoryById(l.category_id)?.name}</td>
                  <td>
                    {l.description} <FlagBadges flags={l.flags} />
                  </td>
                  <td>
                    {l.receipt_no || '—'} <AttachmentLink path={l.receipt_path} label="" />
                  </td>
                  <td className="num">{money(l.amount, '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <Alert>{error}</Alert>}
        </div>
        <div>
          <h4>History</h4>
          <AuditTrail entityType="claim" entityId={claim.id} />
        </div>
      </div>
    </Modal>
  );
}
