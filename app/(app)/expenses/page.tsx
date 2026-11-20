'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { Alert, Card, Empty, FlagBadges, PageHeader, StatusBadge, Stat } from '@/components/ui';
import { ClaimDetailModal } from '@/components/Details';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtDate, fmtDateTime, money, sgToday } from '@/lib/format';
import type { Claim, ClaimLine } from '@/lib/types';

interface DraftLine {
  key: string;
  expense_date: string;
  category_id: string;
  description: string;
  amount: string;
  receipt_no: string;
  receipt_path: string | null;
  file: File | null;
}

let lineSeq = 0;
function blankLine(): DraftLine {
  lineSeq += 1;
  return { key: `l${lineSeq}`, expense_date: '', category_id: '', description: '', amount: '', receipt_no: '', receipt_path: null, file: null };
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
}

export default function ExpensesPage() {
  return (
    <Suspense>
      <Expenses />
    </Suspense>
  );
}

function Expenses() {
  const app = useApp();
  const me = app.me!;
  const params = useSearchParams();
  const today = sgToday();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [selected, setSelected] = useState<Claim | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [resubmitId, setResubmitId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data } = await supabase()
      .from('claims')
      .select('*')
      .eq('employee_id', me.id)
      .order('submitted_at', { ascending: false });
    setClaims((data ?? []) as Claim[]);
  }, [me.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (params.get('new') === '1') setShowForm(true);
  }, [params]);

  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [showForm]);

  const activeCats = app.categories.filter((c) => c.is_active);
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Client-side hints (the database re-checks everything on submit)
  const hints = useMemo(() => {
    const out: string[] = [];
    lines.forEach((l, i) => {
      const cat = app.categoryById(l.category_id);
      if (l.expense_date && l.expense_date > today) out.push(`Line ${i + 1}: date is in the future.`);
      if (cat?.requires_receipt && !l.receipt_no.trim()) out.push(`Line ${i + 1}: ${cat.name} needs a receipt number.`);
      if (cat?.limit_per_line && Number(l.amount) > Number(cat.limit_per_line))
        out.push(`Line ${i + 1}: above the ${money(cat.limit_per_line)} guideline for ${cat.name} — it will be flagged for your approver.`);
    });
    return out;
  }, [lines, app, today]);

  const resetForm = () => {
    setTitle('');
    setLines([blankLine()]);
    setDeclared(false);
    setResubmitId(null);
  };

  const startResubmit = (c: Claim, existing: ClaimLine[]) => {
    setSelected(null);
    setResubmitId(c.id);
    setTitle(c.title);
    setLines(
      existing.map((l) => {
        lineSeq += 1;
        return {
          key: `l${lineSeq}`,
          expense_date: l.expense_date,
          category_id: l.category_id,
          description: l.description,
          amount: String(l.amount),
          receipt_no: l.receipt_no ?? '',
          receipt_path: l.receipt_path,
          file: null,
        };
      }),
    );
    setDeclared(false);
    setShowForm(true);
    setError(null);
    setSuccess(`Correcting ${c.reference}. Finance said: “${c.return_reason ?? ''}”`);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const sb = supabase();
      const payload: Record<string, string | null>[] = [];
      for (const l of lines) {
        let path = l.receipt_path;
        if (l.file) {
          if (l.file.size > 5 * 1024 * 1024) throw new Error('Receipts must be 5 MB or smaller.');
          path = `${me.id}/${Date.now()}-${safeFileName(l.file.name)}`;
          const up = await sb.storage.from('attachments').upload(path, l.file);
          if (up.error) throw up.error;
        }
        payload.push({
          expense_date: l.expense_date,
          category_id: l.category_id,
          description: l.description,
          amount: l.amount,
          receipt_no: l.receipt_no,
          receipt_path: path,
        });
      }
      const { data, error: err } = await sb.rpc('submit_claim', {
        p_title: title,
        p_lines: payload,
        p_declaration: declared,
        p_claim_id: resubmitId,
      });
      if (err) throw err;
      const res = data as { reference: string; total: number; flags: string[] };
      setSuccess(`Submitted ${res.reference} for ${money(res.total)}. Your Department Head will be notified.`);
      resetForm();
      setShowForm(false);
      await load();
      void app.refreshActivity();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sum = (s: Claim['status'][]) => claims.filter((c) => s.includes(c.status)).reduce((a, c) => a + Number(c.total_amount), 0);

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Claims go to your Department Head, then straight to Finance for the next payroll."
        actions={
          !showForm && (
            <button
              className="btn btn-primary"
              onClick={() => {
                resetForm();
                setShowForm(true);
                setSuccess(null);
              }}
            >
              New expense claim
            </button>
          )
        }
      />

      <div className="stats">
        <Stat label="Awaiting approval" value={money(sum(['pending']))} />
        <Stat label="With Finance" value={money(sum(['approved']))} />
        <Stat label="Returned to you" value={String(claims.filter((c) => c.status === 'returned').length)} tone={claims.some((c) => c.status === 'returned') ? 'warn' : undefined} />
        <Stat label={`Paid ${today.slice(0, 4)}`} value={money(claims.filter((c) => c.status === 'paid' && (c.paid_on ?? '').startsWith(today.slice(0, 4))).reduce((a, c) => a + Number(c.total_amount), 0))} tone="good" />
      </div>

      {success && !showForm && <Alert tone="success">{success}</Alert>}

      {showForm && (
        <div ref={formRef}>
          <Card title={resubmitId ? 'Correct & resubmit claim' : 'New expense claim'}>
            {success && <Alert tone="info">{success}</Alert>}
            <div className="form">
              <label>
                Claim title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Client visits – November" />
              </label>
              <div className="table-wrap">
                <table className="table lines">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Date</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th>Amount (SGD)</th>
                      <th>Receipt no.</th>
                      <th>Receipt file</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const cat = app.categoryById(l.category_id);
                      return (
                        <tr key={l.key}>
                          <td>{i + 1}</td>
                          <td>
                            <input type="date" max={today} value={l.expense_date} onChange={(e) => update(l.key, { expense_date: e.target.value })} />
                          </td>
                          <td>
                            <select value={l.category_id} onChange={(e) => update(l.key, { category_id: e.target.value })}>
                              <option value="">Choose…</option>
                              {activeCats.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} placeholder="What and why" />
                          </td>
                          <td>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="0.01"
                              value={l.amount}
                              onChange={(e) => update(l.key, { amount: e.target.value })}
                              className="num"
                            />
                          </td>
                          <td>
                            <input
                              value={l.receipt_no}
                              onChange={(e) => update(l.key, { receipt_no: e.target.value })}
                              placeholder={cat?.requires_receipt ? 'Required' : 'Optional'}
                            />
                          </td>
                          <td>
                            <input type="file" accept="application/pdf,image/*" onChange={(e) => update(l.key, { file: e.target.files?.[0] ?? null })} />
                            {l.receipt_path && !l.file && <span className="muted small">attached</span>}
                          </td>
                          <td>
                            {lines.length > 1 && (
                              <button className="icon-btn" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                                ✕
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        <button className="btn btn-small" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                          + Add line
                        </button>
                      </td>
                      <td className="num">
                        <strong>{money(total)}</strong>
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {hints.length > 0 && (
                <div className="alert alert-warning">
                  <ul>
                    {hints.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
                <span>
                  I declare these expenses were incurred for company business, are supported by the receipts listed, and have not
                  been claimed elsewhere.
                </span>
              </label>
              {error && <Alert>{error}</Alert>}
              <div className="row gap end">
                <button
                  className="btn"
                  onClick={() => {
                    resetForm();
                    setShowForm(false);
                    setError(null);
                    setSuccess(null);
                  }}
                >
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                  {busy ? 'Submitting…' : resubmitId ? 'Resubmit claim' : 'Submit claim'}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card title="My claims">
        {claims.length === 0 ? (
          <Empty>No claims yet. Use “New expense claim” to start one.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Title</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id} onClick={() => setSelected(c)}>
                    <td className="mono">{c.reference}</td>
                    <td>
                      {c.title}
                      {c.status === 'returned' && <div className="small warn-text">Returned: {c.return_reason}</div>}
                    </td>
                    <td className="num">{money(c.total_amount)}</td>
                    <td>
                      <StatusBadge status={c.status} kind="claim" /> <FlagBadges flags={c.flags} />
                    </td>
                    <td className="muted small">{fmtDateTime(c.submitted_at)}</td>
                    <td className="small">{c.paid_on ? `${fmtDate(c.paid_on)} · ${c.payment_reference}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <ClaimDetailModal claim={selected} onClose={() => setSelected(null)} onChanged={() => void load()} onResubmit={startResubmit} />
      )}
    </div>
  );
}
