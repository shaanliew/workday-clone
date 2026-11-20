'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Card, Empty, StatusBadge } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { claimStatusLabel, fmtDays, fmtRange, fmtShort, money, sgToday } from '@/lib/format';
import type { Claim, LeaveBalance, LeaveRequest } from '@/lib/types';

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat('en-SG', { hour: 'numeric', hour12: false, timeZone: 'Asia/Singapore' }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function HomePage() {
  const app = useApp();
  const me = app.me!;
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [myLeave, setMyLeave] = useState<LeaveRequest[]>([]);
  const [myClaims, setMyClaims] = useState<Claim[]>([]);
  const [toDecide, setToDecide] = useState<{ leave: LeaveRequest[]; claims: Claim[] }>({ leave: [], claims: [] });
  const today = sgToday();
  const year = Number(today.slice(0, 4));

  useEffect(() => {
    const sb = supabase();
    void (async () => {
      await sb.rpc('ensure_my_entitlements', { p_year: year });
      const [b, l, c, pl, pc] = await Promise.all([
        sb.from('leave_balances').select('*').eq('employee_id', me.id).eq('year', year).order('sort_order'),
        sb.from('leave_requests').select('*').eq('employee_id', me.id).order('start_date', { ascending: false }).limit(20),
        sb.from('claims').select('*').eq('employee_id', me.id).order('submitted_at', { ascending: false }).limit(5),
        sb
          .from('leave_requests')
          .select('*')
          .eq('status', 'pending')
          .or(`approver_id.eq.${me.id},escalated_to.eq.${me.id}`)
          .neq('employee_id', me.id)
          .order('submitted_at'),
        sb
          .from('claims')
          .select('*')
          .eq('status', 'pending')
          .or(`approver_id.eq.${me.id},escalated_to.eq.${me.id}`)
          .neq('employee_id', me.id)
          .order('submitted_at'),
      ]);
      setBalances((b.data ?? []) as LeaveBalance[]);
      setMyLeave((l.data ?? []) as LeaveRequest[]);
      setMyClaims((c.data ?? []) as Claim[]);
      setToDecide({ leave: (pl.data ?? []) as LeaveRequest[], claims: (pc.data ?? []) as Claim[] });
    })();
  }, [me.id, year]);

  const upcoming = myLeave
    .filter((r) => r.end_date >= today && (r.status === 'approved' || r.status === 'pending'))
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .slice(0, 4);
  const nextHolidays = app.holidays.filter((h) => h.holiday_date >= today).slice(0, 4);
  const al = balances.find((b) => b.code === 'AL');
  const awaiting = toDecide.leave.length + toDecide.claims.length;

  const apps: { href: string; label: string; icon: string; show: boolean; hint: string }[] = [
    { href: '/time-off', label: 'Time Off', icon: '🌴', show: true, hint: 'Request leave, see balances' },
    { href: '/expenses', label: 'Expenses', icon: '🧾', show: true, hint: 'Submit and track claims' },
    { href: '/inbox', label: 'Inbox', icon: '✅', show: true, hint: `${awaiting} awaiting you` },
    { href: '/time-off/calendar', label: 'Team Calendar', icon: '📅', show: true, hint: 'Who is away' },
    { href: '/directory', label: 'Directory', icon: '👥', show: true, hint: 'Find workers' },
    { href: '/hr', label: 'HR Workspace', icon: '🗂️', show: app.isHr, hint: 'Master Leave Record' },
    { href: '/finance', label: 'Finance', icon: '💳', show: app.isFinance, hint: 'Pay approved claims' },
    { href: '/reports', label: 'Reports', icon: '📊', show: app.isHr || app.isFinance || app.isManager, hint: 'KPIs & summaries' },
  ];

  return (
    <div className="home">
      <section className="hero">
        <div>
          <div className="hero-date">{fmtShort(today)}</div>
          <h1>
            {greeting()}, {me.preferred_name || me.full_name.split(' ')[0]}
          </h1>
          <p>
            {me.job_title} · {app.departmentById(me.department_id)?.name ?? '—'}
          </p>
        </div>
        <div className="hero-actions">
          <Link href="/time-off?new=1" className="btn btn-light">
            Request time off
          </Link>
          <Link href="/expenses?new=1" className="btn btn-outline-light">
            New expense claim
          </Link>
        </div>
      </section>

      <div className="home-grid">
        <div className="col">
          <Card
            title="Awaiting your action"
            actions={
              <Link href="/inbox" className="link">
                Go to inbox →
              </Link>
            }
          >
            {awaiting === 0 ? (
              <Empty>Nothing needs your approval right now.</Empty>
            ) : (
              <ul className="list">
                {toDecide.leave.map((r) => (
                  <li key={r.id}>
                    <Link href="/inbox" className="list-link">
                      <span>
                        <strong>{app.employeeById(r.employee_id)?.full_name}</strong> ·{' '}
                        {app.leaveTypeById(r.leave_type_id)?.name} · {fmtRange(r.start_date, r.end_date, r.half_day)}
                      </span>
                      <span className="muted small">{r.reference}</span>
                    </Link>
                  </li>
                ))}
                {toDecide.claims.map((c) => (
                  <li key={c.id}>
                    <Link href="/inbox?tab=claims" className="list-link">
                      <span>
                        <strong>{app.employeeById(c.employee_id)?.full_name}</strong> · {c.title} · {money(c.total_amount)}
                      </span>
                      <span className="muted small">{c.reference}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Your top apps">
            <div className="apps">
              {apps
                .filter((a) => a.show)
                .map((a) => (
                  <Link key={a.href} href={a.href} className="app-tile">
                    <span className="app-icon" aria-hidden>
                      {a.icon}
                    </span>
                    <span className="app-label">{a.label}</span>
                    <span className="muted small">{a.hint}</span>
                  </Link>
                ))}
            </div>
          </Card>
        </div>

        <div className="col">
          <Card title={`Time off balance ${year}`} actions={<Link href="/time-off" className="link">Details →</Link>}>
            {al && (
              <div className="big-balance">
                <span className="big-number">{fmtDays(al.available)}</span>
                <span className="muted">
                  of {fmtDays(al.total_entitlement)} days annual leave available
                  {Number(al.pending) > 0 && ` · ${fmtDays(al.pending)} pending`}
                </span>
              </div>
            )}
            <div className="mini-balances">
              {balances
                .filter((b) => b.balance_check && b.code !== 'AL')
                .map((b) => (
                  <div key={b.leave_type_id} className="mini-balance">
                    <span className="swatch" style={{ background: b.color }} />
                    <span className="grow">{b.name}</span>
                    <strong>{fmtDays(b.available)}</strong>
                    <span className="muted small">/ {fmtDays(b.total_entitlement)}</span>
                  </div>
                ))}
            </div>
          </Card>

          <Card title="Coming up">
            <ul className="list">
              {upcoming.map((r) => (
                <li key={r.id} className="list-row">
                  <span>
                    <span className="swatch" style={{ background: app.leaveTypeById(r.leave_type_id)?.color }} />{' '}
                    {app.leaveTypeById(r.leave_type_id)?.name} · {fmtRange(r.start_date, r.end_date, r.half_day)}
                  </span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
              {nextHolidays.map((h) => (
                <li key={h.holiday_date} className="list-row">
                  <span>🎉 {h.name}</span>
                  <span className="muted small">{fmtShort(h.holiday_date)}</span>
                </li>
              ))}
              {upcoming.length === 0 && nextHolidays.length === 0 && <Empty>Nothing scheduled.</Empty>}
            </ul>
          </Card>

          <Card title="Recent claims" actions={<Link href="/expenses" className="link">All claims →</Link>}>
            {myClaims.length === 0 ? (
              <Empty>No claims yet.</Empty>
            ) : (
              <ul className="list">
                {myClaims.map((c) => (
                  <li key={c.id} className="list-row">
                    <span>
                      {c.reference} · {c.title}
                    </span>
                    <span className="small">
                      {money(c.total_amount)} · <span className={`status-text status-${c.status}`}>{claimStatusLabel(c.status)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
