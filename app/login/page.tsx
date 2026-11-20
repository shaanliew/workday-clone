'use client';

import { useState, type FormEvent } from 'react';
import { supabase, errorMessage } from '@/lib/supabase/client';

const DEMO_USERS: { email: string; name: string; role: string }[] = [
  { email: 'daniel.lim@lumen-demo.sg', name: 'Daniel Lim', role: 'Staff · Operations' },
  { email: 'nurul.huda@lumen-demo.sg', name: 'Nurul Huda', role: 'Staff · Sales' },
  { email: 'priya.nair@lumen-demo.sg', name: 'Priya Nair', role: 'Staff · HR (July 2026 joiner)' },
  { email: 'ahmad.rahman@lumen-demo.sg', name: 'Ahmad Rahman', role: 'Department Head · Operations' },
  { email: 'jason.teo@lumen-demo.sg', name: 'Jason Teo', role: 'Department Head · Sales' },
  { email: 'sarah.ng@lumen-demo.sg', name: 'Sarah Ng', role: 'HR & Office Manager' },
  { email: 'kumar.pillai@lumen-demo.sg', name: 'Kumar Pillai', role: 'Finance (payments)' },
  { email: 'grace.tan@lumen-demo.sg', name: 'Grace Tan', role: 'Managing Director · Admin' },
];

const DEMO_PASSWORD = 'Workline#2026';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const sb = supabase();
      if (mode === 'signin') {
        const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
        window.location.href = '/';
      } else {
        const { data, error: err } = await sb.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (err) throw err;
        if (data.session) window.location.href = '/';
        else setInfo('Check your inbox to confirm your e-mail, then sign in.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-hero">
        <div className="login-brand">
          <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="8" fill="#ffffff" />
            <path d="M7 10l4 12 5-9 5 9 4-12" fill="none" stroke="#0b5cab" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Workline</span>
        </div>
        <h1>Leave &amp; claims, decided in days — not weeks.</h1>
        <ul>
          <li>One template for leave and one for claims, checked as you type</li>
          <li>Routed to the right Department Head, with reminders and escalation</li>
          <li>Approved leave posts to the Master Leave Record — no re-keying</li>
          <li>Approved claims go straight to Finance for the next payroll</li>
        </ul>
      </div>
      <div className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <h2>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
          <p className="muted small">
            {mode === 'signin'
              ? 'Use your work e-mail.'
              : 'Use the work e-mail HR has on file — your account links to your staff record automatically.'}
          </p>
          <label>
            Work e-mail
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <div className="alert alert-error">{error}</div>}
          {info && <div className="alert alert-success">{info}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
              setInfo(null);
            }}
          >
            {mode === 'signin' ? 'First time here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>

        <div className="demo-box">
          <div className="demo-head">
            <strong>Demo accounts</strong>
            <span className="muted small">password {DEMO_PASSWORD}</span>
          </div>
          <div className="demo-grid">
            {DEMO_USERS.map((u) => (
              <button
                type="button"
                key={u.email}
                className="demo-user"
                onClick={() => {
                  setMode('signin');
                  setEmail(u.email);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                <span className="demo-name">{u.name}</span>
                <span className="muted small">{u.role}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
