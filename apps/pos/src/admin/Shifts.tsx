import { useCallback, useEffect, useState } from 'react';
import { CASH_REASONS, DENOMINATIONS, formatKes, parseKesToCents, type CashReason } from '@shop/shared';
import { errorText, post, read } from '../lib/api.ts';
import { reasonLabel } from '../lib/printer.ts';
import { DenominationForm } from '../ui/DenominationForm.tsx';
import { Banner, Button, Card, Field, Input, Modal, Select, Spinner, time } from '../ui/ui.tsx';
import { Table, Variance, statusLabel } from './Dashboard.tsx';
import { RANGES, rangeBounds, type DashboardData, type RangeKey, type ShiftRow } from './types.ts';

type Action = null | 'force' | 'count' | 'recount' | 'ack' | 'adjust';

export function Shifts() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('shift'));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await read<DashboardData>('owner_dashboard_today', rangeBounds(range));
      setRows(d.shifts);
    } catch (e) { setError(errorText(e)); }
  }, [range]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1">
        {RANGES.map(([k, l]) => <Button key={k} variant={k === range ? 'primary' : 'secondary'} onClick={() => setRange(k)}>{l}</Button>)}
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!rows ? <Spinner /> : (
        <Card title="Shifts (open, needing review, or in range)">
          <Table head={['Till', 'Cashier', 'Status', 'Opened', 'Closed', 'Variance', '']} right={[5]}
            rows={rows.map((s) => [
              s.registerCode, s.cashier, statusLabel(s.status), time(s.openedAt), time(s.closedAt),
              s.varianceCents === null ? '—' : <Variance cents={s.netVarianceCents ?? s.varianceCents} />,
              <Button variant="ghost" onClick={() => setSelected(s.shiftId)}>Details</Button>,
            ])} />
        </Card>
      )}
      {selected && <ShiftDetail shiftId={selected} onClose={() => { setSelected(null); window.history.replaceState(null, '', '/admin/shifts'); }} onChanged={load} />}
    </div>
  );
}

interface Detail {
  shift: Record<string, any> & { status: string; registerCode: string; cashier: string; expectedNowCents: number };
  counts: (Record<string, any> & { kind: string; counted_cents: number; expected_cents: number | null; variance_cents: number | null; countedByName: string; created_at: string })[];
  cashMovements: (Record<string, any> & { kind: string; amount_cents: number; reason_code: string; note: string | null; actorName: string; approvedByName: string | null; created_at: string })[];
  paymentsByMethod: Record<string, number>;
  salesCount: number;
  salesCents: number;
  reversals: { id: string; kind: string; amountCents: number; refundMethod: string; reasonCode: string; note: string | null; approvedBy: string; receiptLabel: string; createdAt: string }[];
  cartEvents: { kind: string; qty: number; product: string | null; createdAt: string }[];
  alerts: { type: string; severity: string; subject: string; createdAt: string; acknowledgedAt: string | null }[];
}

function ShiftDetail({ shiftId, onClose, onChanged }: { shiftId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [d, setD] = useState<Detail | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<CashReason>('CORRECTION');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await read<Detail>('owner_shift_detail', { shiftId })); } catch (e) { setError(errorText(e)); }
  }, [shiftId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAction(null);
      setText('');
      setAmount('');
      await load();
      await onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  if (!d) return <Modal title="Shift" onClose={onClose}>{error ? <Banner tone="error">{error}</Banner> : <Spinner />}</Modal>;
  const s = d.shift;
  const canAck = s.status === 'CLOSED_UNRECONCILED' || (s.status === 'CLOSED' && s.variance_flagged && !s.acknowledged_at);

  return (
    <Modal title={`Shift on ${s.registerCode} — ${s.cashier}`} onClose={onClose} wide locked={busy}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Info label="Status" value={statusLabel(s.status)} />
          <Info label="Opened" value={time(s.opened_at)} />
          <Info label="Closed" value={time(s.closed_at)} />
          <Info label="Expected cash" value={formatKes(s.expectedNowCents)} />
          <Info label="Counted" value={s.counted_cash_cents === null ? '—' : formatKes(s.counted_cash_cents)} />
          <Info label="Variance" value={s.variance_cents === null ? '—' : formatKes(s.variance_cents)} />
          <Info label="Sales" value={`${d.salesCount} · ${formatKes(d.salesCents)}`} />
          <Info label="By method" value={Object.entries(d.paymentsByMethod).map(([m, c]) => `${m} ${formatKes(c)}`).join(', ') || '—'} />
        </div>
        {s.forced_close_reason && <Banner tone="warn">Force-closed: {s.forced_close_reason}</Banner>}
        {s.acknowledgement_note && <Banner tone="info">Acknowledged: {s.acknowledgement_note}</Banner>}
        {error && <Banner tone="error">{error}</Banner>}

        <div className="flex flex-wrap gap-2">
          {s.status === 'OPEN' && <Button onClick={() => setAction('force')}>Force close</Button>}
          {s.status === 'PENDING_COUNT' && <Button variant="primary" onClick={() => setAction('count')}>Count the drawer</Button>}
          {(s.status === 'CLOSED' || s.status === 'CLOSED_UNRECONCILED') && <Button onClick={() => setAction('recount')}>Recount</Button>}
          {canAck && <Button variant="primary" onClick={() => setAction('ack')}>Acknowledge variance</Button>}
          <Button onClick={() => setAction('adjust')}>Correcting cash entry</Button>
        </div>

        {action === 'force' && (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => post('owner/shifts/force-close', { shiftId, reason: text.trim() })); }}>
            <Field label="Why are you force-closing this shift?"><Input value={text} onChange={(e) => setText(e.target.value)} minLength={3} required autoFocus /></Field>
            <p className="text-xs text-muted">Sales stop immediately. The drawer must be counted before the till can be used again.</p>
            <div className="flex gap-2"><Button variant="danger" type="submit" disabled={busy}>Force close</Button><Button onClick={() => setAction(null)}>Cancel</Button></div>
          </form>
        )}
        {(action === 'count' || action === 'recount') && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">{action === 'recount' ? 'A recount is stored as a new count; the first count stays visible.' : 'Count everything in the drawer.'}</p>
            <DenominationForm submitLabel={action === 'recount' ? 'Save recount' : 'Commit count'} busy={busy}
              onSubmit={(denominations) => void run(() => post(action === 'recount' ? 'owner/shifts/recount' : 'shifts/close-count', { shiftId, denominations }))} />
          </div>
        )}
        {action === 'ack' && (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => post('owner/shifts/acknowledge', { shiftId, note: text.trim() })); }}>
            <Field label="Note explaining the variance"><Input value={text} onChange={(e) => setText(e.target.value)} minLength={3} required autoFocus /></Field>
            <div className="flex gap-2"><Button variant="primary" type="submit" disabled={busy}>Acknowledge</Button><Button onClick={() => setAction(null)}>Cancel</Button></div>
          </form>
        )}
        {action === 'adjust' && (
          <form className="flex flex-col gap-2" onSubmit={(e) => {
            e.preventDefault();
            const neg = amount.trim().startsWith('-');
            const c = parseKesToCents(amount.replace('-', ''));
            if (!c) return setError('Type an amount, e.g. 500 or -500.');
            void run(() => post('owner/shifts/cash-adjustment', { shiftId, amountCents: neg ? -c : c, reasonCode: reason, note: text.trim() }));
          }}>
            <p className="text-xs text-muted">Counts are never edited. A positive amount means the drawer should have held more cash (for example an unrecorded paid-in); negative means less (an unrecorded payout).</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label="Amount (KES, ± )"><Input value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus /></Field>
              <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value as CashReason)}>{CASH_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}</Select></Field>
              <Field label="Note"><Input value={text} onChange={(e) => setText(e.target.value)} minLength={3} required /></Field>
            </div>
            <div className="flex gap-2"><Button variant="primary" type="submit" disabled={busy}>Add entry</Button><Button onClick={() => setAction(null)}>Cancel</Button></div>
          </form>
        )}

        <Section title="Cash counts">
          <Table head={['Kind', 'By', 'When', ...DENOMINATIONS.map((x) => x.label), 'Counted', 'Expected', 'Variance']}
            right={[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]}
            rows={d.counts.map((c) => [c.kind, c.countedByName, time(c.created_at), ...DENOMINATIONS.map((x) => c[x.key] ?? 0),
              formatKes(c.counted_cents), c.expected_cents === null ? '—' : formatKes(c.expected_cents), c.variance_cents === null ? '—' : formatKes(c.variance_cents)])} />
        </Section>
        <Section title="Cash movements">
          <Table head={['When', 'Kind', 'Amount', 'Reason', 'By', 'Approved by', 'Note']} right={[2]}
            rows={d.cashMovements.map((m) => [time(m.created_at), m.kind, formatKes(m.amount_cents), reasonLabel(m.reason_code), m.actorName, m.approvedByName ?? '—', m.note ?? ''])} />
        </Section>
        {d.reversals.length > 0 && (
          <Section title="Voids and refunds paid from this drawer">
            <Table head={['When', 'Kind', 'Receipt', 'Amount', 'Method', 'Reason', 'Approved by']} right={[3]}
              rows={d.reversals.map((r) => [time(r.createdAt), r.kind, r.receiptLabel, formatKes(r.amountCents), r.refundMethod, reasonLabel(r.reasonCode) + (r.note ? `: ${r.note}` : ''), r.approvedBy])} />
          </Section>
        )}
        {d.cartEvents.length > 0 && (
          <Section title="Removed lines and cancelled carts">
            <Table head={['When', 'What', 'Product', 'Qty']} right={[3]} rows={d.cartEvents.map((e) => [time(e.createdAt), e.kind, e.product ?? '(whole cart)', e.qty])} />
          </Section>
        )}
        {d.alerts.length > 0 && (
          <Section title="Alerts">
            <Table head={['When', 'Severity', 'Alert', 'Acknowledged']} rows={d.alerts.map((a) => [time(a.createdAt), a.severity, a.subject, a.acknowledgedAt ? time(a.acknowledgedAt) : 'no'])} />
          </Section>
        )}
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-surface-2 p-2"><div className="text-xs text-muted">{label}</div><div className="font-medium tabular">{value}</div></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>{children}</section>;
}
