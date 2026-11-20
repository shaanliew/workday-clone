'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '@/components/AppProvider';
import { Avatar, Spinner } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { fmtDateTime } from '@/lib/format';

function Logo() {
  return (
    <Link href="/" className="logo" aria-label="Workline home">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#0b5cab" />
        <path d="M7 10l4 12 5-9 5 9 4-12" fill="none" stroke="#ffb547" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="logo-text">Workline</span>
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [openMenu, setOpenMenu] = useState<'notes' | 'user' | null>(null);
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    setOpenMenu(null);
  }, [pathname]);

  if (app.loading) {
    return (
      <div className="center-screen">
        <Spinner label="Loading your workspace…" />
      </div>
    );
  }

  if (app.error) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <div className="card-body">
            <h2>We couldn’t load your workspace</h2>
            <p className="muted">{app.error}</p>
            <button className="btn" onClick={() => void app.reload()}>Try again</button>
          </div>
        </div>
      </div>
    );
  }

  if (!app.me) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <div className="card-body">
            <h2>Your sign-in isn’t linked to a staff record</h2>
            <p className="muted">
              You are signed in as <strong>{app.userEmail}</strong>, but no active employee record uses this work
              e-mail. Ask HR to add you to the worker directory with this e-mail address — your account links
              automatically.
            </p>
            <button className="btn" onClick={() => void app.signOut()}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  const nav: { href: string; label: string; show: boolean; badge?: number }[] = [
    { href: '/', label: 'Home', show: true },
    { href: '/time-off', label: 'Time Off', show: true },
    { href: '/expenses', label: 'Expenses', show: true },
    { href: '/inbox', label: 'Inbox', show: true, badge: app.inboxCount },
    { href: '/time-off/calendar', label: 'Team Calendar', show: true },
    { href: '/directory', label: 'Directory', show: true },
    { href: '/hr', label: 'HR', show: app.isHr },
    { href: '/finance', label: 'Finance', show: app.isFinance },
    { href: '/reports', label: 'Reports', show: app.isHr || app.isFinance || app.isManager },
  ];

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || (pathname.startsWith(href + '/') && href !== '/time-off');

  const unread = app.notifications.filter((n) => !n.read_at).length;

  const markAllRead = async () => {
    const ids = app.notifications.filter((n) => !n.read_at).map((n) => n.id);
    if (ids.length === 0) return;
    await supabase().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
    await app.refreshActivity();
  };

  const openNotification = async (id: string, link: string | null) => {
    await supabase().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    void app.refreshActivity();
    setOpenMenu(null);
    if (link) router.push(link);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Logo />
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              router.push(`/directory?q=${encodeURIComponent(query)}`);
            }}
          >
            <span aria-hidden>⌕</span>
            <input
              placeholder="Search workers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search workers"
            />
          </form>
          <div className="topbar-right" ref={menuRef}>
            <span className="company">{app.companyName}</span>
            <Link href="/inbox" className="icon-btn" title="Inbox" aria-label="Inbox">
              ✉{app.inboxCount > 0 && <span className="dot">{app.inboxCount}</span>}
            </Link>
            <div className="menu-wrap">
              <button
                className="icon-btn"
                title="Notifications"
                aria-label="Notifications"
                onClick={() => setOpenMenu(openMenu === 'notes' ? null : 'notes')}
              >
                🔔{unread > 0 && <span className="dot">{unread}</span>}
              </button>
              {openMenu === 'notes' && (
                <div className="dropdown notes">
                  <div className="dropdown-head">
                    <strong>Notifications</strong>
                    <button className="link" onClick={() => void markAllRead()}>
                      Mark all read
                    </button>
                  </div>
                  {app.notifications.length === 0 && <div className="muted pad">You’re all caught up.</div>}
                  {app.notifications.map((n) => (
                    <button
                      key={n.id}
                      className={`note ${n.read_at ? '' : 'unread'} note-${n.kind}`}
                      onClick={() => void openNotification(n.id, n.link)}
                    >
                      <span className="note-title">{n.title}</span>
                      {n.body && <span className="note-body">{n.body}</span>}
                      <span className="note-time">{fmtDateTime(n.created_at)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="menu-wrap">
              <button className="avatar-btn" onClick={() => setOpenMenu(openMenu === 'user' ? null : 'user')} aria-label="Account menu">
                <Avatar name={app.me.full_name} size={34} />
              </button>
              {openMenu === 'user' && (
                <div className="dropdown user">
                  <div className="pad">
                    <strong>{app.me.preferred_name || app.me.full_name}</strong>
                    <div className="muted small">{app.me.job_title}</div>
                    <div className="muted small">{app.me.email}</div>
                    <div className="role-chip">{app.me.role === 'employee' ? 'Employee' : app.me.role.toUpperCase()}</div>
                  </div>
                  <Link className="dropdown-item" href={`/directory?id=${app.me.id}`}>
                    My profile
                  </Link>
                  <button className="dropdown-item" onClick={() => void app.signOut()}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <nav className="subnav">
          <div className="subnav-inner">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link key={n.href} href={n.href} className={`subnav-link ${isActive(n.href) ? 'active' : ''}`}>
                  {n.label}
                  {!!n.badge && <span className="count">{n.badge}</span>}
                </Link>
              ))}
          </div>
        </nav>
      </header>
      <main className="content">{children}</main>
      <footer className="footer muted small">
        Workline · a Workday-style demo for the Leave &amp; Claims Approval Workflow · data secured by Supabase RLS
      </footer>
    </div>
  );
}
