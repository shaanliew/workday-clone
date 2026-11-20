const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse a YYYY-MM-DD string as a local calendar date (no timezone shift). */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today in Singapore as YYYY-MM-DD. */
export function sgToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDate(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDate(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function fmtRange(start: string, end: string, half?: string | null): string {
  if (start === end) return `${fmtDate(start)}${half ? ` (${half})` : ''}`;
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

export function fmtDays(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function money(n: number | string | null | undefined, currency = 'SGD'): string {
  const v = Number(n ?? 0);
  return `${currency} ${v.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function monthLabel(year: number, monthIndex: number): string {
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][monthIndex]} ${year}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Working days between two dates inclusive, skipping weekends and holidays. */
export function workingDaysBetween(startIso: string, endIso: string, holidays: Set<string>): number {
  let count = 0;
  const d = parseDate(startIso);
  const end = parseDate(endIso);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(toIso(d))) count += 1;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

export const FLAG_LABELS: Record<string, string> = {
  short_notice: 'Short notice',
  over_limit: 'Over limit',
  team_clash: 'Team clash',
  backdated: 'Backdated',
  escalated: 'Escalated',
  late_submission: 'Late submission',
};

export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ');
}

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  returned: 'Returned',
  paid: 'Paid',
};

export function claimStatusLabel(s: string): string {
  if (s === 'approved') return 'Submitted to Finance';
  return STATUS_LABELS[s] ?? s;
}

/** Build and download a CSV file in the browser. */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
