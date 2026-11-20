'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useApp } from '@/components/AppProvider';
import { Alert, Card, Empty, FlagBadges, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { LeaveDetailModal } from '@/components/Details';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtDate, fmtDateTime, fmtDays, fmtRange, sgToday } from '@/lib/format';
import type { LedgerEntry, LeaveBalance, LeaveEvaluation, LeaveRequest } from '@/lib/types';

export default function TimeOffPage() {
  return (
    <Suspense>
      <TimeOff />
    </Suspense>
  );
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
}

function TimeOff() {
  const app = useApp();
  const me = app.me!;
  const params = useSearchParams();
  const today = sgToday();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [tab, setTab] = useState<'requests' | 'record'>('requests');
  const [selected, setSelected] = useState<LeaveRequest | null>(null);

  const types = app.leaveTypes.filter((t) => t.is_active);
  const [typeId, setTypeId] = useState<string>('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [half, setHalf] = useState<'' | 'AM' | 'PM'>('');
  const [reason, setReason] = useState('');
  const [docRef, setDocRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LeaveEvaluation | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!typeId && types.length) setTypeId(types[0]!.id);
  }, [types, typeId]);

  useEffect(() => {
    if (params.get('new') === '1') formRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [params]);

  const type = app.leaveTypeById(typeId);

  const load = useCallback(async () => {
    const sb = supabase();
    await sb.rpc('ensure_my_entitlements', { p_year: year });
    const [b, r, l] = await Promise.all([
      sb.from('leave_balances').select('*').eq('employee_id', me.id).eq('year', year).order('sort_order'),
      sb.from('leave_requests').select('*').eq('employee_id', me.id).eq('year', year).order('start_date', { ascending: false }),
      sb.from('leave_ledger').select('*').eq('employee_id', me.id).eq('year', year).order('created_at', { ascending: false }),
    ]);
    setBalances((b.data ?? []) as LeaveBalance[]);
    setRequests((r.data ?? []) as LeaveRequest[]);
    setLedger((l.data ?? []) as LedgerEntry[]);
  }, [me.id, year]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live validation against the server rules (nothing is saved)
  useEffect(() => {
    if (!typeId || !start || !end) {
      setPreview(null);
      return;
    }
    const t = setTimeout(async () => {
      setPreviewing(true);
      const { data, error: err } = await supabase().rpc('preview_leave_request', {
        p_leave_type_id: typeId,
        p_start: start,
        p_end: end,
        p_half_day: half || null,
        p_document_ref: docRef || null,
      });
      setPreviewing(false);
      if (err) setPreview({ ok: false, errors: [errorMessage(err)], flags: [], notes: [], days: 0 });
      else setPreview(data as LeaveEvaluation);
    }, 350);
    return () => clearTimeout(t);
  }, [typeId, start, end, half, docRef]);

  const resetForm = () => {
    setStart('');
    setEnd('');
    setHalf('');
    setReason('');
    setDocRef('');
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    setPreview(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const sb = supabase();
      let path: string | null = null;
      if (file) {
        if (file.size > 5 * 1024 * 1024) throw new Error('Attachments must be 5 MB or smaller.');
        path = `${me.id}/${Date.now()}-${safeFileName(file.name)}`;
        const up = await sb.storage.from('attachments').upload(path, file, { upsert: false });
        if (up.error) throw up.error;
      }
      const { data, error: err } = await sb.rpc('submit_leave_request', {
        p_leave_type_id: typeId,
        p_start: start,
        p_end: end,
        p_half_day: half || null,
        p_reason: reason || null,
        p_document_ref: docRef || null,
        p_attachment_path: path,
      });
      if (err) throw err;
      const res = data as { reference: string; approver: string | null; days: number };
      setSuccess(`Submitted ${res.reference} (${fmtDays(res.days)} day(s)). It is now with ${res.approver ?? 'your approver'} for a decision.`);
      resetForm();
      await load();
      void app.refreshActivity();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const sameDay = start && end && start === end;
  const canSubmit = !!preview?.ok && !submitting && !previewing;

  const usedByType = useMemo(() => {
    const m = new Map<string, number>();
    ledger.forEach((l) => m.set(l.leave_type_id, (m.get(l.leave_type_id) ?? 0) + Number(l.days)));
    return m;
  }, [ledger]);

  return (
    <div>
      <PageHeader
        title="Time Off"
        subtitle="Balances are your contract entitlement minus approved leave in the Master Leave Record."
        actions={
          <>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <Link href="/time-off/calendar" className="btn">
              Team calendar
            </Link>
          </>
        }
      />

      <div className="balance-cards">
        {balances.map((b) => (
          <div key={b.leave_type_id} className="balance-card" style={{ borderTopColor: b.color }}>
            <div className="balance-name">{b.name}</div>
            {b.balance_check ? (
              <>
                <div className="balance-value">
                  {fmtDays(b.available)}
                  <span className="muted"> / {fmtDays(b.total_entitlement)}</span>
                </div>
                <div className="meter">
                  <span
                    style={{
                      width: `${Math.min(100, Number(b.total_entitlement) ? (Number(b.taken) / Number(b.total_entitlement)) * 100 : 0)}%`,
                      background: b.color,
                    }}
                  />
                  <span
                    className="meter-pending"
                    style={{
                      width: `${Math.min(100, Number(b.total_entitlement) ? (Number(b.pending) / Number(b.total_entitlement)) * 100 : 0)}%`,
                    }}
                  />
                </div>
                <div className="muted small">
                  {fmtDays(b.taken)} taken{Number(b.pending) > 0 && ` · ${fmtDays(b.pending)} pending`}
                  {Number(b.carried_forward) > 0 && ` · ${fmtDays(b.carried_forward)} carried fwd`}
                </div>
              </>
            ) : (
              <>
                <div className="balance-value">{fmtDays(usedByType.get(b.leave_type_id) ?? 0)}</div>
                <div className="muted small">days taken · no fixed entitlement</div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="two-col" ref={formRef}>
        <Card title="Request time off">
          <div className="form">
            <label>
              Leave type
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            {type?.description && <p className="muted small hint">{type.description}</p>}
            <div className="row gap">
              <label className="grow">
                From
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    if (!end || end < e.target.value) setEnd(e.target.value);
                  }}
                />
              </label>
              <label className="grow">
                To
                <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
            {sameDay && type?.allow_half_day && (
              <div className="segmented" role="radiogroup" aria-label="Day portion">
                {(['', 'AM', 'PM'] as const).map((h) => (
                  <button key={h || 'full'} type="button" className={half === h ? 'active' : ''} onClick={() => setHalf(h)}>
                    {h === '' ? 'Full day' : `Half day (${h})`}
                  </button>
                ))}
              </div>
            )}
            {type?.requires_document && (
              <label>
                {type.document_label ?? 'Document reference'} <span className="req">*</span>
                <input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="e.g. MC-2026-118734" />
              </label>
            )}
            <label>
              Reason / comment
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional for most leave types" />
            </label>
            <label>
              Attachment (MC, memo — PDF or image, max 5 MB)
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {error && <Alert>{error}</Alert>}
            {success && <Alert tone="success">{success}</Alert>}
            <div className="row gap end">
              <button type="button" className="btn" onClick={resetForm} disabled={submitting}>
                Clear
              </button>
              <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </div>
        </Card>

        <Card title="Check before you submit">
          {!preview && !previewing && <Empty>Pick a leave type and dates to see working days, your balance and any clashes.</Empty>}
          {previewing && <p className="muted">Checking…</p>}
          {preview && !previewing && (
            <div className="preview">
              <div className="preview-stats">
                <div>
                  <span className="muted small">Working days</span>
                  <strong>{fmtDays(preview.days)}</strong>
                </div>
                {preview.balance?.checked && (
                  <>
                    <div>
                      <span className="muted small">Available now</span>
                      <strong>{fmtDays(preview.balance.available)}</strong>
                    </div>
                    <div>
                      <span className="muted small">After this</span>
                      <strong className={Number(preview.balance.after) < 0 ? 'neg' : ''}>{fmtDays(preview.balance.after)}</strong>
                    </div>
                  </>
                )}
              </div>
              {preview.approver_name && (
                <p className="small">
                  Routed to <strong>{preview.approver_name}</strong> for approval.
                </p>
              )}
              {preview.errors.length > 0 && (
                <div className="alert alert-error">
                  <strong>Please fix:</strong>
                  <ul>
                    {preview.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.errors.length === 0 && <Alert tone="success">All checks passed — ready to submit.</Alert>}
              {preview.flags.length > 0 && (
                <div className="alert alert-warning">
                  <FlagBadges flags={preview.flags} />
                  <ul>
                    {preview.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                  <span className="small">Flags don’t block your request; they are shown to your approver.</span>
                </div>
              )}
              {preview.clashes && preview.clashes.length > 0 && (
                <div>
                  <h4>Teammates away</h4>
                  <ul className="list">
                    {preview.clashes.map((c) => (
                      <li key={`${c.name}-${c.start}`} className="list-row">
                        <span>{c.name}</span>
                        <span className="muted small">
                          {fmtRange(c.start, c.end)} · {c.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'requests', label: `My requests (${requests.length})` },
            { id: 'record', label: 'My leave record' },
          ]}
        />
        {tab === 'requests' &&
          (requests.length === 0 ? (
            <Empty>No leave requests in {year}.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table hover">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th className="num">Days</th>
                    <th>Status</th>
                    <th>Approver</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} onClick={() => setSelected(r)}>
                      <td className="mono">{r.reference}</td>
                      <td>
                        <span className="swatch" style={{ background: app.leaveTypeById(r.leave_type_id)?.color }} />{' '}
                        {app.leaveTypeById(r.leave_type_id)?.name}
                      </td>
                      <td>{fmtRange(r.start_date, r.end_date, r.half_day)}</td>
                      <td className="num">{fmtDays(r.days)}</td>
                      <td>
                        <StatusBadge status={r.status} /> <FlagBadges flags={r.flags} />
                      </td>
                      <td>{app.employeeById(r.escalated_to ?? r.approver_id)?.full_name ?? '—'}</td>
                      <td className="muted small">{fmtDateTime(r.submitted_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'record' &&
          (ledger.length === 0 ? (
            <Empty>No approved leave recorded in {year} yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Posted</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Entry</th>
                    <th className="num">Days</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="muted small">{fmtDateTime(l.created_at)}</td>
                      <td>{app.leaveTypeById(l.leave_type_id)?.name}</td>
                      <td>{l.start_date ? fmtRange(l.start_date, l.end_date ?? l.start_date) : '—'}</td>
                      <td>{l.entry_type === 'taken' ? 'Taken' : 'Reversed'}</td>
                      <td className="num">{fmtDays(l.days)}</td>
                      <td>{l.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        <p className="muted small">Public holidays this year: {app.holidays.filter((h) => h.year === year).map((h) => `${h.name} (${fmtDate(h.holiday_date)})`).join(' · ') || '—'}</p>
      </Card>

      {selected && <LeaveDetailModal request={selected} onClose={() => setSelected(null)} onChanged={() => void load()} />}
    </div>
  );
}
