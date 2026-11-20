'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { Card, PageHeader } from '@/components/ui';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtRange, monthLabel, parseDate, sgToday, toIso } from '@/lib/format';
import type { TeamAbsence } from '@/lib/types';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function CalendarPage() {
  const app = useApp();
  const today = sgToday();
  const [cursor, setCursor] = useState(() => {
    const d = parseDate(today);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [rows, setRows] = useState<TeamAbsence[]>([]);
  const [error, setError] = useState<string | null>(null);

  const from = toIso(new Date(cursor.y, cursor.m, 1));
  const to = toIso(new Date(cursor.y, cursor.m + 1, 0));

  useEffect(() => {
    void supabase()
      .rpc('team_absence', { p_from: from, p_to: to })
      .then(({ data, error: err }) => {
        if (err) setError(errorMessage(err));
        else {
          setError(null);
          setRows((data ?? []) as TeamAbsence[]);
        }
      });
  }, [from, to]);

  const holidays = useMemo(() => new Map(app.holidays.map((h) => [h.holiday_date, h.name])), [app.holidays]);

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const list: (string | null)[] = [];
    for (let i = 0; i < lead; i += 1) list.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) list.push(toIso(new Date(cursor.y, cursor.m, d)));
    while (list.length % 7 !== 0) list.push(null);
    return list;
  }, [cursor]);

  const move = (delta: number) => {
    const d = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };

  const people = useMemo(() => {
    const m = new Map<string, TeamAbsence[]>();
    rows.forEach((r) => m.set(r.full_name, [...(m.get(r.full_name) ?? []), r]));
    return [...m.entries()];
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Team Calendar"
        subtitle="Approved leave in your department, plus anything you can see as a manager or HR. Colleagues’ leave types stay private."
        actions={
          <div className="row gap">
            <button className="btn" onClick={() => move(-1)} aria-label="Previous month">
              ‹
            </button>
            <strong className="month-label">{monthLabel(cursor.y, cursor.m)}</strong>
            <button className="btn" onClick={() => move(1)} aria-label="Next month">
              ›
            </button>
            <button
              className="btn"
              onClick={() => {
                const d = parseDate(today);
                setCursor({ y: d.getFullYear(), m: d.getMonth() });
              }}
            >
              Today
            </button>
          </div>
        }
      />
      {error && <div className="alert alert-error">{error}</div>}
      <div className="calendar">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-head">
            {w}
          </div>
        ))}
        {cells.map((iso, i) => {
          if (!iso) return <div key={`x${i}`} className="cal-cell empty" />;
          const d = parseDate(iso);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          const hol = holidays.get(iso);
          const away = rows.filter((r) => r.start_date <= iso && r.end_date >= iso);
          return (
            <div key={iso} className={`cal-cell ${weekend ? 'weekend' : ''} ${hol ? 'holiday' : ''} ${iso === today ? 'today' : ''}`}>
              <div className="cal-date">{d.getDate()}</div>
              {hol && <div className="cal-hol">🎉 {hol}</div>}
              {!weekend &&
                !hol &&
                away.map((r) => (
                  <div
                    key={r.request_id}
                    className={`cal-chip ${r.status === 'pending' ? 'pending' : ''}`}
                    style={{ borderLeftColor: r.color }}
                    title={`${r.full_name} · ${r.leave_name} · ${fmtRange(r.start_date, r.end_date, r.half_day)} · ${r.status}`}
                  >
                    {r.is_mine ? 'You' : r.full_name.split(' ')[0]}
                    {r.half_day ? ` (${r.half_day})` : ''}
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <Card title="Who’s away this month">
        {people.length === 0 ? (
          <p className="muted">No one is away this month.</p>
        ) : (
          <ul className="list">
            {people.map(([name, list]) => (
              <li key={name} className="list-row">
                <strong>{name}</strong>
                <span className="small">
                  {list.map((r) => (
                    <span key={r.request_id} className="pill" style={{ borderColor: r.color }}>
                      {r.leave_name} · {fmtRange(r.start_date, r.end_date, r.half_day)}
                      {r.status === 'pending' ? ' · pending' : ''}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Pending requests appear with a dashed outline.</p>
      </Card>
    </div>
  );
}
