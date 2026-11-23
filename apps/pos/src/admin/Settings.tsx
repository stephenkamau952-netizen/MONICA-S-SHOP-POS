import { useCallback, useEffect, useState } from 'react';
import { formatKes, parseKesToCents, type RouteInput } from '@shop/shared';
import { errorText, post, read } from '../lib/api.ts';
import { Banner, Button, Card, Field, Input, Modal, Spinner } from '../ui/ui.tsx';
import { Table } from './Dashboard.tsx';

interface S {
  varianceThresholdCents: number; staleShiftHours: number; allowNegativeStock: boolean; refundWindowDays: number;
  voidCountThreshold: number; voidRateBps: number; overrideBatchThreshold: number; cartLineRemovalThreshold: number;
  cartCancelThreshold: number; tillIdleLockSeconds: number; approvalTtlSeconds: number; updatedAt: string;
}
interface Register { id: string; code: string; name: string; float_cents: number; active: boolean; next_receipt_no: number }

const INT_FIELDS: [keyof S, string, string][] = [
  ['staleShiftHours', 'Alert when a shift is open longer than (hours)', ''],
  ['refundWindowDays', 'Refund window (days)', ''],
  ['voidCountThreshold', 'Alert above this many voids/refunds per shift', ''],
  ['voidRateBps', 'Alert when voids/refunds exceed this share of shift sales (basis points; 200 = 2%)', ''],
  ['overrideBatchThreshold', 'Batch alert above this many price overrides per shift', ''],
  ['cartLineRemovalThreshold', 'Alert above this many removed lines per shift', ''],
  ['cartCancelThreshold', 'Alert above this many cancelled carts per shift', ''],
  ['tillIdleLockSeconds', 'Lock the till after this many idle seconds', ''],
  ['approvalTtlSeconds', 'Owner approval valid for (seconds)', ''],
];

export function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [neg, setNeg] = useState(false);
  const [regs, setRegs] = useState<Register[]>([]);
  const [editReg, setEditReg] = useState<Register | null | 'new'>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'good'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await read<S>('owner_settings');
      setS(v);
      setNeg(v.allowNegativeStock);
      setForm({
        varianceThresholdCents: String(v.varianceThresholdCents / 100),
        ...Object.fromEntries(INT_FIELDS.map(([k]) => [k, String(v[k])])),
      });
      setRegs(await read<Register[]>('owner_registers'));
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!s) return msg ? <Banner tone="error">{msg.text}</Banner> : <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Alert thresholds and till rules">
        <form className="grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const variance = parseKesToCents(form.varianceThresholdCents ?? '');
          if (variance === null) return setMsg({ tone: 'error', text: 'Variance threshold must be an amount in shillings.' });
          const body: Record<string, number | boolean> = { varianceThresholdCents: variance, allowNegativeStock: neg };
          for (const [k] of INT_FIELDS) {
            const v = form[k] ?? '';
            if (!/^\d{1,6}$/.test(v)) return setMsg({ tone: 'error', text: `"${k}" must be a whole number.` });
            body[k] = Number(v);
          }
          try {
            await post('owner/settings', body as RouteInput<'owner/settings'>);
            setMsg({ tone: 'good', text: 'Settings saved (and recorded in the audit log).' });
            await load();
          } catch (err) { setMsg({ tone: 'error', text: errorText(err) }); }
        }}>
          <Field label="Cash variance that raises a HIGH alert (KES, ±)">
            <Input inputMode="decimal" value={form.varianceThresholdCents ?? ''} onChange={(e) => setForm((f) => ({ ...f, varianceThresholdCents: e.target.value }))} />
          </Field>
          {INT_FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <Input inputMode="numeric" value={form[k] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={neg} onChange={(e) => setNeg(e.target.checked)} />
            Allow selling below zero stock (each such sale raises a NEGATIVE_STOCK alert)
          </label>
          {msg && <div className="md:col-span-2"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
          <div className="md:col-span-2"><Button variant="primary" type="submit">Save settings</Button></div>
        </form>
      </Card>

      <Card title="Tills" actions={<Button onClick={() => setEditReg('new')}>Add till</Button>}>
        <Table head={['Code', 'Name', 'Opening float', 'Next receipt', 'Status', '']} right={[2, 3]}
          rows={regs.map((r) => [r.code, r.name, formatKes(r.float_cents), r.next_receipt_no, r.active ? 'Active' : 'Inactive',
            <Button variant="ghost" onClick={() => setEditReg(r)}>Edit</Button>])} />
      </Card>
      {editReg && <RegisterDialog reg={editReg === 'new' ? null : editReg} onClose={() => setEditReg(null)} onDone={async () => { setEditReg(null); await load(); }} />}
    </div>
  );
}

function RegisterDialog({ reg, onClose, onDone }: { reg: Register | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [code, setCode] = useState(reg?.code ?? '');
  const [name, setName] = useState(reg?.name ?? '');
  const [float, setFloat] = useState(reg ? String(reg.float_cents / 100) : '');
  const [active, setActive] = useState(reg?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={reg ? `Edit till ${reg.code}` : 'Add till'} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const floatCents = parseKesToCents(float || '0');
        if (floatCents === null) return setError('Float must be an amount in shillings.');
        try {
          await post('owner/registers/upsert', reg
            ? { id: reg.id, name: name.trim(), floatCents, active }
            : { code: code.trim().toUpperCase(), name: name.trim(), floatCents, active });
          await onDone();
        } catch (err) { setError(errorText(err)); }
      }}>
        {!reg && <Field label="Code (printed on receipts, cannot change later)"><Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} pattern="[A-Za-z0-9]{1,6}" required autoFocus /></Field>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></Field>
        <Field label="Opening float the cashier receives (KES)"><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Modal>
  );
}
