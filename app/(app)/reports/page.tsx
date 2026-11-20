'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Card, Empty, PageHeader, Stat } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { downloadCsv, fmtDays, money, sgToday, workingDaysBetween } from '@/lib/format';
import type { Claim, ClaimLine, LedgerEntry, LeaveRequest } from '@/lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sgDate(ts: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(ts));
}

export default function ReportsPage() {
  const app = useApp();
  const thisYear = Number(sgToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loaded, setLoaded] = useState(false);
  const holidaySet = useMemo(() => new Set(app.holidays.map((h) => h.holiday_date)), [app.holidays]);

  useEffect(() => {
    const sb = supabase();
    void (async () => {
      const [r, l, c] = await Promise.all([
        sb.from('leave_requests').select('*').eq('year', year),
        sb.from('leave_ledger').select('*').eq('year', year),
        sb.from('claims').select('*, claim_lines(*)').gte('submitted_at', `${year}-01-01`).lt('submitted_at', `${year + 1}-01-01`),
      ]);
      setRequests((r.data ?? []) as LeaveRequest[]);
      setLedger((l.data ?? []) as LedgerEntry[]);
      setClaims((c.data ?? []) as Claim[]);
      setLoaded(true);
    })();
  }, [year]);

  const decisionDays = (submitted: string, decided: string) => {
    const s = sgDate(submitted);
    const d = sgDate(decided);
    if (d <= s) return 0;
    const next = new Date(s);
    next.setDate(next.getDate() + 1);
    return workingDaysBetween(next.toISOString().slice(0, 10), d, holidaySet);
  };

  const leaveKpi = useMemo(() => {
    const decided = requests.filter((r) => r.decided_at);
    const times = decided.map((r) => decisionDays(r.submitted_at, r.decided_at!));
    const within = times.filter((t) => t <= 2).length;
    return {
      total: requests.length,
      approved: requests.filter((r) => r.status === 'approved').length,
      rejected: requests.filter((r) => r.status === 'rejected').length,
      pending: requests.filter((r) => r.status === 'pending').length,
      withinPct: decided.length ? Math.round((within / decided.length) * 100) : null,
      avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, holidaySet]);

  const claimKpi = useMemo(() => {
    const submitted = claims.filter((c) => c.status !== 'cancelled');
    const everReturned = submitted.filter((c) => c.return_reason).length;
    return {
      total: submitted.length,
      paid: submitted.filter((c) => c.status === 'paid').reduce((s, c) => s + Number(c.total_amount), 0),
      withFinance: submitted.filter((c) => c.status === 'approved').reduce((s, c) => s + Number(c.total_amount), 0),
      returnedPct: submitted.length ? Math.round((everReturned / submitted.length) * 100) : null,
    };
  }, [claims]);

  // Leave days taken per month by type (from the Master Leave Record)
  const monthly = useMemo(() => {
    const grid = new Map<string, number[]>();
    ledger.forEach((l) => {
      const m = Number((l.start_date ?? `${year}-01-01`).slice(5, 7)) - 1;
      const arr = grid.get(l.leave_type_id) ?? new Array(12).fill(0);
      arr[m] += Number(l.days);
      grid.set(l.leave_type_id, arr);
    });
    const totals = new Array(12).fill(0) as number[];
    grid.forEach((arr) => arr.forEach((v, i) => (totals[i] += v)));
    return { grid, totals, max: Math.max(1, ...totals) };
  }, [ledger, year]);

  const byDept = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    ledger.forEach((l) => {
      const dept = app.employeeById(l.employee_id)?.department_id ?? 'none';
      const inner = m.get(dept) ?? new Map<string, number>();
      inner.set(l.leave_type_id, (inner.get(l.leave_type_id) ?? 0) + Number(l.days));
      m.set(dept, inner);
    });
    return m;
  }, [ledger, app]);

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    claims
      .filter((c) => c.status === 'paid' || c.status === 'approved')
      .forEach((c) => (c.claim_lines ?? []).forEach((l: ClaimLine) => m.set(l.category_id, (m.get(l.category_id) ?? 0) + Number(l.amount))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [claims]);

  const exportMonthly = () => {
    const rows: (string | number)[][] = [];
    app.leaveTypes.forEach((t) => {
      const arr = monthly.grid.get(t.id);
      if (arr) rows.push([t.code, t.name, ...arr.map((v) => Number(v.toFixed(1))), Number(arr.reduce((a, b) => a + b, 0).toFixed(1))]);
    });
    rows.push(['ALL', 'All leave', ...monthly.totals.map((v) => Number(v.toFixed(1))), Number(monthly.totals.reduce((a, b) => a + b, 0).toFixed(1))]);
    downloadCsv(`monthly-leave-summary-${year}.csv`, ['Code', 'Leave type', ...MONTHS, 'Total'], rows);
  };

  const typesUsed = app.leaveTypes.filter((t) => monthly.grid.has(t.id));
  const scope = app.isHr ? 'all staff' : app.isFinance ? 'your team (leave) and all claims' : 'your team';

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`Workflow KPIs and the monthly leave summary for ${scope}.`}
        actions={
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        }
      />
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="stats">
            <Stat label="Leave requests" value={leaveKpi.total} hint={`${leaveKpi.approved} approved · ${leaveKpi.rejected} rejected · ${leaveKpi.pending} pending`} />
            <Stat
              label="Decided within 2 working days"
              value={leaveKpi.withinPct === null ? '—' : `${leaveKpi.withinPct}%`}
              hint="Target: 90%+"
              tone={leaveKpi.withinPct === null ? undefined : leaveKpi.withinPct >= 90 ? 'good' : 'warn'}
            />
            <Stat label="Average time to decision" value={leaveKpi.avg === null ? '—' : `${leaveKpi.avg.toFixed(1)} days`} hint="working days" />
            <Stat label="Re-keying by HR" value="0" hint="Approvals post straight to the Master Leave Record" tone="good" />
          </div>
          <div className="stats">
            <Stat label="Claims submitted" value={claimKpi.total} />
            <Stat label="Paid" value={money(claimKpi.paid)} tone="good" />
            <Stat label="With Finance" value={money(claimKpi.withFinance)} />
            <Stat
              label="Returned for missing info"
              value={claimKpi.returnedPct === null ? '—' : `${claimKpi.returnedPct}%`}
              hint="Target: under 5%"
              tone={claimKpi.returnedPct === null ? undefined : claimKpi.returnedPct < 5 ? 'good' : 'warn'}
            />
          </div>

          <Card
            title={`Monthly leave summary ${year}`}
            actions={
              <button className="btn" onClick={exportMonthly} disabled={ledger.length === 0}>
                Export CSV
              </button>
            }
          >
            {ledger.length === 0 ? (
              <Empty>No approved leave recorded yet.</Empty>
            ) : (
              <>
                <div className="bars" role="img" aria-label="Leave days taken per month">
                  {monthly.totals.map((v, i) => (
                    <div key={MONTHS[i]} className="bar-col">
                      <div className="bar-stack" style={{ height: `${(v / monthly.max) * 100}%` }}>
                        {typesUsed.map((t) => {
                          const part = monthly.grid.get(t.id)![i]!;
                          return part > 0 ? <span key={t.id} style={{ flexGrow: part, background: t.color }} title={`${t.name}: ${fmtDays(part)}`} /> : null;
                        })}
                      </div>
                      <span className="bar-value small">{v ? fmtDays(v) : ''}</span>
                      <span className="bar-label small">{MONTHS[i]}</span>
                    </div>
                  ))}
                </div>
                <div className="legend">
                  {typesUsed.map((t) => (
                    <span key={t.id}>
                      <span className="swatch" style={{ background: t.color }} /> {t.name}
                    </span>
                  ))}
                </div>
              </>
            )}
          </Card>

          <div className="two-col">
            <Card title="Leave days by department">
              {byDept.size === 0 ? (
                <Empty>No data.</Empty>
              ) : (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Department</th>
                      {typesUsed.map((t) => (
                        <th key={t.id} className="num">
                          {t.code}
                        </th>
                      ))}
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...byDept.entries()].map(([deptId, inner]) => (
                      <tr key={deptId}>
                        <td>{app.departmentById(deptId)?.name ?? '—'}</td>
                        {typesUsed.map((t) => (
                          <td key={t.id} className="num">
                            {fmtDays(inner.get(t.id) ?? 0)}
                          </td>
                        ))}
                        <td className="num">
                          <strong>{fmtDays([...inner.values()].reduce((a, b) => a + b, 0))}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Approved claims by category">
              {byCategory.length === 0 ? (
                <Empty>No approved claims yet.</Empty>
              ) : (
                <ul className="list">
                  {byCategory.map(([catId, amt]) => (
                    <li key={catId} className="list-row">
                      <span>{app.categoryById(catId)?.name}</span>
                      <strong>{money(amt)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Waiting for a decision">
            {requests.filter((r) => r.status === 'pending').length + claims.filter((c) => c.status === 'pending').length === 0 ? (
              <Empty>Nothing is waiting.</Empty>
            ) : (
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Employee</th>
                    <th>Approver</th>
                    <th className="num">Working days waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {[...requests.filter((r) => r.status === 'pending'), ...claims.filter((c) => c.status === 'pending')].map((x) => {
                    const waited = decisionDays(x.submitted_at, new Date().toISOString());
                    return (
                      <tr key={x.id}>
                        <td className="mono">{x.reference}</td>
                        <td>{app.employeeById(x.employee_id)?.full_name}</td>
                        <td>{app.employeeById(x.escalated_to ?? x.approver_id)?.full_name}</td>
                        <td className={`num ${waited >= 2 ? 'neg' : ''}`}>{waited}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
