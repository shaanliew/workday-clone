'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { Alert, Avatar, Card, Empty, PageHeader } from '@/components/ui';
import { supabase, errorMessage } from '@/lib/supabase/client';
import { fmtDate } from '@/lib/format';
import type { Employee } from '@/lib/types';

export default function DirectoryPage() {
  return (
    <Suspense>
      <Directory />
    </Suspense>
  );
}

function Directory() {
  const app = useApp();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [dept, setDept] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));

  useEffect(() => {
    setQ(params.get('q') ?? '');
    if (params.get('id')) setSelectedId(params.get('id'));
  }, [params]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return app.employees.filter(
      (e) =>
        e.is_active &&
        (!dept || e.department_id === dept) &&
        (!term ||
          e.full_name.toLowerCase().includes(term) ||
          (e.job_title ?? '').toLowerCase().includes(term) ||
          e.email.toLowerCase().includes(term) ||
          (app.departmentById(e.department_id)?.name ?? '').toLowerCase().includes(term)),
    );
  }, [app, q, dept]);

  const selected = app.employeeById(selectedId);

  return (
    <div>
      <PageHeader title="Directory" subtitle="Find workers, reporting lines and contact details." />
      <div className="row gap filters">
        <input className="grow" placeholder="Search by name, title, department or e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {app.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="two-col wide-left">
        <div className="people-grid">
          {list.length === 0 && <Empty>No workers match.</Empty>}
          {list.map((e) => (
            <button key={e.id} className={`person ${selectedId === e.id ? 'active' : ''}`} onClick={() => setSelectedId(e.id)}>
              <Avatar name={e.full_name} size={44} />
              <span className="person-text">
                <strong>{e.full_name}</strong>
                <span className="muted small">{e.job_title}</span>
                <span className="muted small">{app.departmentById(e.department_id)?.name}</span>
              </span>
            </button>
          ))}
        </div>
        <div>{selected ? <Profile employee={selected} onSelect={setSelectedId} /> : <Empty>Select a worker to see their profile.</Empty>}</div>
      </div>
    </div>
  );
}

function Profile({ employee, onSelect }: { employee: Employee; onSelect: (id: string) => void }) {
  const app = useApp();
  const isMe = employee.id === app.me?.id;
  const [preferred, setPreferred] = useState(employee.preferred_name ?? '');
  const [phone, setPhone] = useState(employee.phone ?? '');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setPreferred(employee.preferred_name ?? '');
    setPhone(employee.phone ?? '');
    setMsg(null);
  }, [employee]);

  const manager = app.employeeById(employee.manager_id);
  const reports = app.employees.filter((e) => e.manager_id === employee.id && e.is_active);
  const dept = app.departmentById(employee.department_id);

  const save = async () => {
    const { error } = await supabase().rpc('update_my_profile', { p_preferred_name: preferred, p_phone: phone });
    if (error) setMsg({ tone: 'error', text: errorMessage(error) });
    else {
      setMsg({ tone: 'success', text: 'Profile updated.' });
      await app.reload();
    }
  };

  return (
    <Card>
      <div className="profile-head">
        <Avatar name={employee.full_name} size={64} />
        <div>
          <h2>{employee.full_name}</h2>
          <div className="muted">{employee.job_title}</div>
          <div className="muted small">
            {dept?.name}
            {dept?.head_id === employee.id && ' · Department Head'}
          </div>
        </div>
      </div>
      <dl className="dl">
        <dt>Employee no.</dt>
        <dd>{employee.employee_no}</dd>
        <dt>E-mail</dt>
        <dd>
          <a href={`mailto:${employee.email}`}>{employee.email}</a>
        </dd>
        <dt>Phone</dt>
        <dd>{employee.phone ?? '—'}</dd>
        <dt>Location</dt>
        <dd>{employee.location}</dd>
        <dt>Hire date</dt>
        <dd>{fmtDate(employee.hire_date)}</dd>
        <dt>Manager</dt>
        <dd>
          {manager ? (
            <button className="link" onClick={() => onSelect(manager.id)}>
              {manager.full_name}
            </button>
          ) : (
            '—'
          )}
        </dd>
        <dt>Direct reports</dt>
        <dd>
          {reports.length === 0
            ? '—'
            : reports.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ', '}
                  <button className="link" onClick={() => onSelect(r.id)}>
                    {r.full_name}
                  </button>
                </span>
              ))}
        </dd>
      </dl>
      {isMe && (
        <div className="form">
          <h4>Edit my details</h4>
          <div className="row gap">
            <label className="grow">
              Preferred name
              <input value={preferred} onChange={(e) => setPreferred(e.target.value)} />
            </label>
            <label className="grow">
              Phone
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          <div className="row end">
            <button className="btn btn-primary" onClick={() => void save()}>
              Save
            </button>
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <p className="muted small">Name, department, manager and role are maintained by HR.</p>
        </div>
      )}
    </Card>
  );
}
