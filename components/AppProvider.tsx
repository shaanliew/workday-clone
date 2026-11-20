'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase, errorMessage } from '@/lib/supabase/client';
import type { ClaimCategory, Department, Employee, Holiday, LeaveType, Notification } from '@/lib/types';

interface AppState {
  loading: boolean;
  error: string | null;
  userEmail: string | null;
  me: Employee | null;
  employees: Employee[];
  departments: Department[];
  leaveTypes: LeaveType[];
  categories: ClaimCategory[];
  holidays: Holiday[];
  companyName: string;
  notifications: Notification[];
  inboxCount: number;
  isHr: boolean;
  isFinance: boolean;
  isAdmin: boolean;
  isManager: boolean;
  employeeById: (id: string | null | undefined) => Employee | undefined;
  departmentById: (id: string | null | undefined) => Department | undefined;
  leaveTypeById: (id: string | null | undefined) => LeaveType | undefined;
  categoryById: (id: string | null | undefined) => ClaimCategory | undefined;
  reload: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [me, setMe] = useState<Employee | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [categories, setCategories] = useState<ClaimCategory[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [companyName, setCompanyName] = useState('Workline');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [inboxCount, setInboxCount] = useState(0);

  const refreshActivity = useCallback(async () => {
    const sb = supabase();
    const { data: userData } = await sb.auth.getUser();
    if (!userData.user) return;
    const { data: emp } = await sb.from('employees').select('id').eq('user_id', userData.user.id).maybeSingle();
    if (!emp) return;
    const myId = (emp as { id: string }).id;
    const [notes, leaveQ, claimQ] = await Promise.all([
      sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30),
      sb
        .from('leave_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .or(`approver_id.eq.${myId},escalated_to.eq.${myId}`)
        .neq('employee_id', myId),
      sb
        .from('claims')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .or(`approver_id.eq.${myId},escalated_to.eq.${myId}`)
        .neq('employee_id', myId),
    ]);
    setNotifications((notes.data ?? []) as Notification[]);
    setInboxCount((leaveQ.count ?? 0) + (claimQ.count ?? 0));
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const sb = supabase();
      const { data: userData } = await sb.auth.getUser();
      const user = userData.user;
      setUserEmail(user?.email ?? null);
      if (!user) {
        setMe(null);
        return;
      }
      const [emps, depts, types, cats, hols, settings] = await Promise.all([
        sb.from('employees').select('*').order('full_name'),
        sb.from('departments').select('*').order('name'),
        sb.from('leave_types').select('*').order('sort_order'),
        sb.from('claim_categories').select('*').order('sort_order'),
        sb.from('public_holidays').select('*').order('holiday_date'),
        sb.from('app_settings').select('key,value').eq('key', 'company_name').maybeSingle(),
      ]);
      const firstError = emps.error ?? depts.error ?? types.error ?? cats.error ?? hols.error;
      if (firstError) throw firstError;
      const all = (emps.data ?? []) as Employee[];
      setEmployees(all);
      setDepartments((depts.data ?? []) as Department[]);
      setLeaveTypes((types.data ?? []) as LeaveType[]);
      setCategories((cats.data ?? []) as ClaimCategory[]);
      setHolidays((hols.data ?? []) as Holiday[]);
      const name = (settings.data as { value?: unknown } | null)?.value;
      if (typeof name === 'string') setCompanyName(name);
      setMe(all.find((e) => e.user_id === user.id) ?? null);
      await refreshActivity();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [refreshActivity]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void refreshActivity(), 60_000);
    return () => clearInterval(t);
  }, [reload, refreshActivity]);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut();
    window.location.href = '/login';
  }, []);

  const value = useMemo<AppState>(() => {
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const deptMap = new Map(departments.map((d) => [d.id, d]));
    const typeMap = new Map(leaveTypes.map((t) => [t.id, t]));
    const catMap = new Map(categories.map((c) => [c.id, c]));
    const role = me?.role;
    return {
      loading,
      error,
      userEmail,
      me,
      employees,
      departments,
      leaveTypes,
      categories,
      holidays,
      companyName,
      notifications,
      inboxCount,
      isHr: role === 'hr' || role === 'admin',
      isFinance: role === 'finance' || role === 'admin',
      isAdmin: role === 'admin',
      isManager: !!me && (employees.some((e) => e.manager_id === me.id) || departments.some((d) => d.head_id === me.id)),
      employeeById: (id) => (id ? empMap.get(id) : undefined),
      departmentById: (id) => (id ? deptMap.get(id) : undefined),
      leaveTypeById: (id) => (id ? typeMap.get(id) : undefined),
      categoryById: (id) => (id ? catMap.get(id) : undefined),
      reload,
      refreshActivity,
      signOut,
    };
  }, [loading, error, userEmail, me, employees, departments, leaveTypes, categories, holidays, companyName, notifications, inboxCount, reload, refreshActivity, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
