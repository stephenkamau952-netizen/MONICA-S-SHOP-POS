import { useCallback, useEffect, useState } from 'react';
import { useReady } from '../auth/AuthProvider.tsx';
import { errorText, post, read } from '../lib/api.ts';
import { Banner, Button, Card, Field, Input, Modal, Select, Spinner, time } from '../ui/ui.tsx';
import { Table } from './Dashboard.tsx';

interface StaffRow { userId: string; email: string; displayName: string; role: 'OWNER' | 'CASHIER'; active: boolean; hasPin: boolean; createdAt: string }
interface Unassigned { userId: string; email: string; createdAt: string }

export function Staff() {
  const { ctx } = useReady();
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [pending, setPending] = useState<Unassigned[]>([]);
  const [assign, setAssign] = useState<Unassigned | null>(null);
  const [edit, setEdit] = useState<StaffRow | null>(null);
  const [pin, setPin] = useState<StaffRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStaff(await read<StaffRow[]>('owner_staff'));
      setPending(await read<Unassigned[]>('owner_unassigned_users'));
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const done = async () => { setAssign(null); setEdit(null); setPin(null); await load(); };

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info">
        To add someone: in Supabase, Authentication → Users → <strong>Invite user</strong> with their email (public sign-up is off).
        When they have accepted, they appear below under “New accounts” for you to give a role. Every person gets their own login and PIN.
      </Banner>
      {error && <Banner tone="error">{error}</Banner>}
      {pending.length > 0 && (
        <Card title="New accounts without a role">
          <Table head={['Email', 'Created', '']} rows={pending.map((u) => [u.email, time(u.createdAt), <Button onClick={() => setAssign(u)}>Assign role</Button>])} />
        </Card>
      )}
      {!staff ? <Spinner /> : (
        <Card title="Staff">
          <Table head={['Name', 'Email', 'Role', 'Status', 'PIN', '']}
            rows={staff.map((s) => [s.displayName, s.email, s.role === 'OWNER' ? 'Owner' : 'Cashier', s.active ? 'Active' : 'Deactivated',
              s.hasPin ? 'Set' : '⚠️ Not set',
              <span className="flex gap-1">
                <Button variant="ghost" onClick={() => setPin(s)}>Set PIN</Button>
                {s.userId !== ctx.userId && <Button variant="ghost" onClick={() => setEdit(s)}>Edit</Button>}
              </span>])} />
        </Card>
      )}
      {assign && <AssignDialog user={assign} onClose={() => setAssign(null)} onDone={done} />}
      {edit && <EditDialog row={edit} onClose={() => setEdit(null)} onDone={done} />}
      {pin && <PinDialog row={pin} onClose={() => setPin(null)} onDone={done} />}
    </div>
  );
}

function useAction(onDone: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return {
    error, busy, setError,
    run: async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try { await fn(); await onDone(); } catch (e) { setError(errorText(e)); setBusy(false); }
    },
  };
}

function AssignDialog({ user, onClose, onDone }: { user: Unassigned; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'CASHIER' | 'OWNER'>('CASHIER');
  const a = useAction(onDone);
  return (
    <Modal title={`Assign a role to ${user.email}`} onClose={onClose} locked={a.busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => post('owner/staff/assign', { userId: user.userId, role, displayName: name.trim() })); }}>
        <Field label="Name shown on receipts"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as 'CASHIER' | 'OWNER')}><option value="CASHIER">Cashier</option><option value="OWNER">Owner</option></Select></Field>
        {a.error && <Banner tone="error">{a.error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={a.busy}>Assign</Button></div>
      </form>
    </Modal>
  );
}

function EditDialog({ row, onClose, onDone }: { row: StaffRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(row.displayName);
  const [role, setRole] = useState(row.role);
  const [active, setActive] = useState(row.active);
  const a = useAction(onDone);
  return (
    <Modal title={`Edit ${row.displayName}`} onClose={onClose} locked={a.busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => post('owner/staff/update', { userId: row.userId, displayName: name.trim(), role, active })); }}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as 'CASHIER' | 'OWNER')}><option value="CASHIER">Cashier</option><option value="OWNER">Owner</option></Select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (unticking blocks this person immediately; their history is kept)</label>
        {a.error && <Banner tone="error">{a.error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={a.busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function PinDialog({ row, onClose, onDone }: { row: StaffRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const a = useAction(onDone);
  return (
    <Modal title={`Set PIN for ${row.displayName}`} onClose={onClose} locked={a.busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        if (!/^\d{6}$/.test(pin)) return a.setError('A PIN is exactly 6 digits.');
        if (pin !== pin2) return a.setError('The two PINs do not match.');
        void a.run(() => post('owner/staff/pin', { userId: row.userId, pin }));
      }}>
        <p className="text-sm text-ink-2">{row.role === 'OWNER' ? 'Owner PINs approve voids, refunds and overrides at the till. Never tell it to staff.' : 'Cashiers use their PIN to unlock the till.'}</p>
        <Field label="New 6-digit PIN"><Input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
        <Field label="Repeat PIN"><Input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></Field>
        {a.error && <Banner tone="error">{a.error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={a.busy}>Set PIN</Button></div>
      </form>
    </Modal>
  );
}
