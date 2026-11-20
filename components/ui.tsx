'use client';

import { useEffect, type ReactNode } from 'react';
import { claimStatusLabel, flagLabel, initials, STATUS_LABELS } from '@/lib/format';

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function StatusBadge({ status, kind = 'leave' }: { status: string; kind?: 'leave' | 'claim' }) {
  const label = kind === 'claim' ? claimStatusLabel(status) : STATUS_LABELS[status] ?? status;
  return <span className={`badge status-${status}`}>{label}</span>;
}

export function FlagBadges({ flags }: { flags: string[] | null | undefined }) {
  if (!flags || flags.length === 0) return null;
  return (
    <span className="flag-row">
      {flags.map((f) => (
        <span key={f} className={`badge flag flag-${f}`}>
          ⚑ {flagLabel(f)}
        </span>
      ))}
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hash} 55% 42%)` }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" aria-hidden /> <span className="muted">{label}</span>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={`tab ${value === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
