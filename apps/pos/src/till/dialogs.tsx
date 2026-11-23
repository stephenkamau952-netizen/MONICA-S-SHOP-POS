import { useState } from 'react';
import {
  CASH_REASONS, REVERSAL_REASONS, formatKes, parseKesToCents,
  type CashReason, type ReversalReason, type RouteInput,
} from '@shop/shared';
import { useReady } from '../auth/AuthProvider.tsx';
import { errorText, post, read } from '../lib/api.ts';
import { printLines, reasonLabel, slipLines } from '../lib/printer.ts';
import { Banner, Button, Field, Input, Modal, Select } from '../ui/ui.tsx';
import { ApprovalModal, type Approved } from './ApprovalModal.tsx';
import type { CartLine } from './SaleScreen.tsx';

// ---------------------------------------------------------------------------
export function QtyDialog({ line, onSave, onClose }: { line: CartLine; onSave: (qty: number) => void; onClose: () => void }) {
  const [qty, setQty] = useState(String(line.qty));
  const n = /^\d{1,3}$/.test(qty) ? Number(qty) : NaN;
  return (
    <Modal title={`Quantity: ${line.name}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (n >= 0 && n <= 999) onSave(n); }}>
        <Field label="Quantity (0 removes the line)" hint="Reducing a quantity after scanning is recorded.">
          <Input inputMode="numeric" value={qty} autoFocus onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 3))}
            onFocus={(e) => e.currentTarget.select()} className="text-lg tabular" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Back</Button>
          <Button variant="primary" type="submit" disabled={Number.isNaN(n)}>Set (Enter)</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ReasonSelect<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
    </Select>
  );
}

export function OverrideDialog({ line, shiftId, ownerDirect, onApplied, onClose }: {
  line: CartLine;
  shiftId: string;
  ownerDirect: boolean;
  onApplied: (o: { priceCents: number; approvalId?: string; expiresAt?: string }) => void;
  onClose: () => void;
}) {
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState<ReversalReason>('PRICE_ERROR');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<RouteInput<'approvals/request'> | null>(null);
  const cents = parseKesToCents(price);

  if (request) {
    return (
      <ApprovalModal
        request={request}
        onCancel={onClose}
        onApproved={(a: Approved) => onApplied({ priceCents: cents!, approvalId: a.approvalId, expiresAt: a.expiresAt })}
      />
    );
  }

  return (
    <Modal title={`Price override: ${line.name}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (cents === null) return setError('Type the new unit price in shillings.');
          if (cents === line.listPriceCents) return setError('That is the current price.');
          if (reason === 'OTHER' && note.trim() === '') return setError('Write a note for OTHER.');
          if (ownerDirect) return onApplied({ priceCents: cents });
          setRequest({ action: 'PRICE_OVERRIDE', shiftId, productId: line.productId, priceCents: cents, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) });
        }}
      >
        <p className="text-sm text-ink-2">Current price {formatKes(line.listPriceCents)}. The owner must approve; the approval lasts 2 minutes.</p>
        <Field label="New unit price (KES)"><Input inputMode="decimal" value={price} autoFocus onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Reason"><ReasonSelect value={reason} options={REVERSAL_REASONS} onChange={setReason} /></Field>
        <Field label="Note"><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Back</Button>
          <Button variant="primary" type="submit">{ownerDirect ? 'Apply' : 'Ask owner'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
type CashKind = 'DROP' | 'PAID_IN' | 'PAID_OUT' | 'NO_SALE';
const CASH_KINDS: { kind: CashKind; label: string; approval: boolean; defaultReason: CashReason }[] = [
  { kind: 'DROP', label: 'Cash drop to safe', approval: false, defaultReason: 'SAFE_DROP' },
  { kind: 'PAID_IN', label: 'Paid in', approval: false, defaultReason: 'FLOAT_TOP_UP' },
  { kind: 'PAID_OUT', label: 'Paid out', approval: true, defaultReason: 'PETTY_EXPENSE' },
  { kind: 'NO_SALE', label: 'Open drawer (no sale)', approval: true, defaultReason: 'CHANGE_GIVEN' },
];

export function CashDialog({ shiftId, ownerDirect, onDone, onClose }: {
  shiftId: string; ownerDirect: boolean; onDone: (text: string) => void; onClose: () => void;
}) {
  const { ctx } = useReady();
  const [kind, setKind] = useState<CashKind>('DROP');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<CashReason>('SAFE_DROP');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<RouteInput<'approvals/request'> | null>(null);
  const def = CASH_KINDS.find((k) => k.kind === kind)!;
  const cents = parseKesToCents(amount);

  const record = async (approvalId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('cash-movements', {
        shiftId, kind, reasonCode: reason,
        ...(kind === 'NO_SALE' ? {} : { amountCents: cents! }),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(approvalId ? { approvalId } : {}),
      });
      const warn = await printLines(slipLines({
        title: def.label.toUpperCase(), storeName: ctx.storeName ?? '', cashierName: ctx.displayName ?? '',
        createdAt: new Date().toISOString(),
        rows: [['Reason', reasonLabel(reason)], ...(kind === 'NO_SALE' ? [] : [['Amount KES', formatKes(r.amountCents).replace('KES ', '')] as [string, string]])],
        footer: note.trim() || undefined,
      }), r.openDrawer);
      onDone(`${def.label} recorded.${warn ? ` ${warn}` : ''}`);
    } catch (e) {
      setRequest(null);
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (request) return <ApprovalModal request={request} onCancel={() => setRequest(null)} onApproved={(a) => void record(a.approvalId)} />;

  return (
    <Modal title="Drawer and cash" onClose={onClose} locked={busy}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind !== 'NO_SALE' && (cents === null || cents <= 0)) return setError('Type the amount in shillings.');
          if (reason === 'OTHER' && note.trim() === '') return setError('Write a note for OTHER.');
          if (def.approval && !ownerDirect) {
            setRequest(kind === 'PAID_OUT'
              ? { action: 'PAID_OUT', shiftId, amountCents: cents!, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) }
              : { action: 'NO_SALE', shiftId, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) });
          } else void record();
        }}
      >
        <Field label="What">
          <Select value={kind} autoFocus onChange={(e) => {
            const k = e.target.value as CashKind;
            setKind(k);
            setReason(CASH_KINDS.find((x) => x.kind === k)!.defaultReason);
          }}>
            {CASH_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}{k.approval ? ' (owner approval)' : ''}</option>)}
          </Select>
        </Field>
        {kind !== 'NO_SALE' && <Field label="Amount (KES)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        <Field label="Reason"><ReasonSelect value={reason} options={CASH_REASONS} onChange={setReason} /></Field>
        <Field label="Note"><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>Back</Button>
          <Button variant="primary" type="submit" disabled={busy}>{def.approval && !ownerDirect ? 'Ask owner' : 'Record'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
interface LookupLine { saleLineId: string; name: string; qty: number; unitPriceCents: number; lineTotalCents: number; reversedQty: number }
interface Lookup {
  saleId: string; receiptLabel: string; createdAt: string; cashierName: string; totalCents: number;
  canVoid: boolean; withinRefundWindow: boolean; hasReversals: boolean;
  lines: LookupLine[]; payments: { method: 'CASH' | 'MPESA' | 'CARD'; amountCents: number }[];
}

export function ReversalDialog({ shiftId, ownerDirect, onDone, onClose }: {
  shiftId: string; ownerDirect: boolean; onDone: (text: string) => void; onClose: () => void;
}) {
  const { ctx } = useReady();
  const [receipt, setReceipt] = useState('');
  const [sale, setSale] = useState<Lookup | null>(null);
  const [kind, setKind] = useState<'VOID' | 'REFUND'>('REFUND');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<'CASH' | 'MPESA' | 'CARD'>('CASH');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState<ReversalReason>('CUSTOMER_RETURN');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<RouteInput<'approvals/request'> | null>(null);

  const lines = sale
    ? sale.lines.map((l) => ({ saleLineId: l.saleLineId, qty: Number(qty[l.saleLineId] || 0) })).filter((l) => l.qty > 0)
    : [];
  const amount = sale
    ? kind === 'VOID' ? sale.totalCents
      : lines.reduce((s, l) => s + l.qty * sale.lines.find((x) => x.saleLineId === l.saleLineId)!.unitPriceCents, 0)
    : 0;

  const lookup = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await read<Lookup>('lookup_sale_for_reversal', { shiftId, receipt: receipt.trim().toUpperCase() });
      setSale(s);
      setKind(s.canVoid ? 'VOID' : 'REFUND');
      setMethod(s.payments[0]?.method ?? 'CASH');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async (approvalId?: string) => {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post('reversals', {
        shiftId, saleId: sale.saleId, kind, refundMethod: method, reasonCode: reason,
        ...(kind === 'REFUND' ? { lines } : {}),
        ...(method !== 'CASH' ? { refundRef: ref.trim().toUpperCase() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(approvalId ? { approvalId } : {}),
      });
      const warn = await printLines(slipLines({
        title: `${kind} of ${r.receiptLabel}`, storeName: r.storeName, cashierName: r.cashierName, createdAt: r.createdAt,
        rows: [
          ...(r.lines as { name: string; qty: number; amountCents: number }[]).map((l) => [`${l.qty} x ${l.name}`.slice(0, 30), formatKes(l.amountCents)] as [string, string]),
          ['Refunded by', method === 'MPESA' ? `M-Pesa ${r.refundRef}` : method === 'CARD' ? `Card ${r.refundRef}` : 'Cash'],
          ['TOTAL', formatKes(r.amountCents)],
          ['Reason', reasonLabel(reason)],
        ],
      }), r.openDrawer);
      onDone(`${kind === 'VOID' ? 'Void' : 'Refund'} of ${r.receiptLabel}: ${formatKes(r.amountCents)} back by ${method}.${warn ? ` ${warn}` : ''}`);
    } catch (e) {
      setRequest(null);
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (request) return <ApprovalModal request={request} onCancel={() => setRequest(null)} onApproved={(a) => void execute(a.approvalId)} />;

  return (
    <Modal title="Void or refund" onClose={onClose} wide locked={busy}>
      {!sale ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void lookup(); }}>
          <Field label="Receipt number" hint="As printed, e.g. T1-000123">
            <Input value={receipt} autoFocus onChange={(e) => setReceipt(e.target.value)} autoComplete="off" />
          </Field>
          {error && <Banner tone="error">{error}</Banner>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Back</Button>
            <Button variant="primary" type="submit" disabled={busy || receipt.trim() === ''}>Find</Button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (kind === 'REFUND' && lines.length === 0) return setError('Enter a quantity to refund on at least one line.');
            if (method === 'MPESA' && !/^[A-Z0-9]{10}$/.test(ref.trim().toUpperCase())) return setError('Enter the 10-character M-Pesa reversal code.');
            if (method === 'CARD' && (ref.trim().length < 4 || ref.trim().length > 32)) return setError('Enter the card terminal reference.');
            if (reason === 'OTHER' && note.trim() === '') return setError('Write a note for OTHER.');
            if (ownerDirect) return void execute();
            const base = { shiftId, saleId: sale.saleId, refundMethod: method, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) };
            setRequest(kind === 'VOID' ? { action: 'VOID', ...base } : { action: 'REFUND', ...base, lines });
          }}
        >
          <div className="text-sm text-ink-2">
            Receipt <strong>{sale.receiptLabel}</strong> · {new Date(sale.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} · {sale.cashierName} · {formatKes(sale.totalCents)}
            {' · paid '}{sale.payments.map((p) => `${p.method} ${formatKes(p.amountCents)}`).join(' + ')}
          </div>
          {!sale.withinRefundWindow && <Banner tone="warn">This sale is outside the refund window.</Banner>}
          <div className="flex gap-2">
            <Button variant={kind === 'VOID' ? 'primary' : 'secondary'} disabled={!sale.canVoid} onClick={() => setKind('VOID')}>
              Void whole sale{!sale.canVoid ? ' (same shift only)' : ''}
            </Button>
            <Button variant={kind === 'REFUND' ? 'primary' : 'secondary'} onClick={() => setKind('REFUND')}>Refund items</Button>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th>Item</th><th className="text-right">Sold</th><th className="text-right">Already returned</th><th className="text-right">Price</th>{kind === 'REFUND' && <th className="text-right">Refund qty</th>}</tr></thead>
            <tbody>
              {sale.lines.map((l) => {
                const left = l.qty - l.reversedQty;
                return (
                  <tr key={l.saleLineId} className="border-t border-line">
                    <td className="py-1">{l.name}</td>
                    <td className="text-right tabular">{l.qty}</td>
                    <td className="text-right tabular">{l.reversedQty}</td>
                    <td className="text-right tabular">{formatKes(l.unitPriceCents)}</td>
                    {kind === 'REFUND' && (
                      <td className="text-right">
                        <input aria-label={`Refund quantity for ${l.name}`} className="w-16 rounded border border-line bg-surface px-2 py-1 text-right tabular"
                          inputMode="numeric" disabled={left <= 0} value={qty[l.saleLineId] ?? ''} placeholder="0"
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, '');
                            setQty((q) => ({ ...q, [l.saleLineId]: v === '' ? '' : String(Math.min(Number(v), left)) }));
                          }} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Give money back by">
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="CASH">Cash from this drawer</option><option value="MPESA">M-Pesa reversal</option><option value="CARD">Card reversal</option>
              </Select>
            </Field>
            {method !== 'CASH' && (
              <Field label={method === 'MPESA' ? 'M-Pesa reversal code' : 'Card reversal reference'}>
                <Input value={ref} maxLength={32} onChange={(e) => setRef(e.target.value)} />
              </Field>
            )}
            <Field label="Reason"><ReasonSelect value={reason} options={REVERSAL_REASONS} onChange={setReason} /></Field>
            <Field label="Note"><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          {reason === 'DAMAGED' && <Banner tone="info">Damaged returns are written off, not put back on the shelf.</Banner>}
          {error && <Banner tone="error">{error}</Banner>}
          <div className="flex items-center justify-between gap-2">
            <div className="text-lg font-semibold tabular">{formatKes(amount)}</div>
            <div className="flex gap-2">
              <Button onClick={() => { setSale(null); setError(null); }} disabled={busy}>Another receipt</Button>
              <Button variant="primary" type="submit" disabled={busy || amount <= 0}>{ownerDirect ? `Confirm ${kind.toLowerCase()}` : 'Ask owner'}</Button>
            </div>
          </div>
          <p className="text-xs text-muted">Signed in as {ctx.displayName}. The original sale is never changed; this adds a {kind.toLowerCase()} record.</p>
        </form>
      )}
    </Modal>
  );
}
