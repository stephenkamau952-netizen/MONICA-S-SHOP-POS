import { useCallback, useEffect, useRef, useState } from 'react';
import { ALERT_LABELS, formatKes } from '@shop/shared';
import { useReady } from '../auth/AuthProvider.tsx';
import { errorText, post, read } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { ownerTopic, sb } from '../lib/supabase.ts';
import { Banner, Button, Card, Input, Modal, SeverityBadge, Spinner, time } from '../ui/ui.tsx';
import { RANGES, rangeBounds, type AlertRow, type DashboardData, type RangeKey } from './types.ts';

const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(1)}%`);

interface FeedItem { key: string; event: string; text: string; at: number }

function describe(event: string, p: Record<string, unknown>): string {
  switch (event) {
    case 'sale': return `Sale ${p.receiptLabel} ${formatKes(p.totalCents as number)} by ${p.cashier}`;
    case 'reversal': return `${p.kind} of ${p.receiptLabel} ${formatKes(p.amountCents as number)} (${p.refundMethod}) by ${p.cashier}`;
    case 'alert': return `Alert: ${p.subject}`;
    case 'approval_request': return `Approval asked by ${p.cashier}: ${p.summary}`;
    case 'approval': return `Approved: ${p.summary}`;
    case 'cash_movement': return `${String(p.kind).replace('_', ' ')} ${formatKes(p.amountCents as number)} by ${p.cashier}`;
    case 'shift': return `Shift ${p.kind}${p.registerCode ? ` on ${p.registerCode}` : ''}${p.cashier ? ` (${p.cashier})` : ''}`;
    case 'cart_event': return `${String(p.kind).replace('_', ' ').toLowerCase()} by ${p.cashier}`;
    default: return event;
  }
}

export function Dashboard() {
  const { ctx, session } = useReady();
  const [range, setRange] = useState<RangeKey>('today');
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<string>('connecting');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [ack, setAck] = useState<AlertRow | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    try {
      setData(await read<DashboardData>('owner_dashboard_today', rangeBounds(rangeRef.current)));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => { void load(); }, [range, load]);

  // PRD §7: private Broadcast channel; each event triggers a debounced refetch
  // of ledger-computed numbers, so the screen never drifts from the database.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = sb().channel(ownerTopic(ctx.storeId!), { config: { private: true } });
    channel.on('broadcast', { event: '*' }, (msg) => {
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      setFeed((f) => [{ key: crypto.randomUUID(), event: msg.event, text: describe(msg.event, payload), at: Date.now() }, ...f].slice(0, 20));
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    void (async () => {
      await sb().realtime.setAuth(session.access_token);
      channel.subscribe((status) => {
        setLive(status);
        if (status === 'SUBSCRIBED') void load(); // also on every reconnect
      });
    })();
    const poll = setInterval(() => void load(), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      void sb().removeChannel(channel);
    };
  }, [ctx.storeId, session.access_token, load]);

  if (!data) return error ? <Banner tone="error">{error}</Banner> : <Spinner />;
  const live_ok = live === 'SUBSCRIBED';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Date range">
          {RANGES.map(([k, label]) => (
            <Button key={k} variant={k === range ? 'primary' : 'secondary'} aria-pressed={k === range} onClick={() => setRange(k)}>{label}</Button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-2" aria-live="polite">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: live_ok ? 'var(--good)' : 'var(--serious)' }} />
          {live_ok ? 'Live' : live === 'connecting' ? 'Connecting live updates…' : 'Live updates reconnecting (refreshing every minute)'} · updated {time(data.generatedAt)}
        </div>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!ctx.hasPin && (
        <Banner tone="warn">
          You have no owner PIN yet, so nobody can approve voids, refunds or price overrides at the till.
          Go to <button type="button" className="underline" onClick={() => navigate('/admin/staff')}>Staff</button> → Set PIN on your own name.
        </Banner>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Gross sales" value={formatKes(data.grossSalesCents)} sub={`${data.salesCount} sale${data.salesCount === 1 ? '' : 's'}`} />
        <Stat label="Net sales" value={formatKes(data.netSalesCents)} sub={`Voids ${formatKes(data.voidsCents)} · refunds ${formatKes(data.refundsCents)}`} />
        <Stat label="Gross profit" value={formatKes(data.grossProfitCents)} sub={`Gross margin ${pct(data.grossMarginBps)} · cost ${formatKes(data.cogsCents)}`} />
        <Stat label="Average basket" value={formatKes(data.avgBasketCents)} sub="Gross sales ÷ sales" />
      </div>

      {data.pendingApprovals.length > 0 && (
        <Card title={`Waiting for your approval (${data.pendingApprovals.length})`}>
          <ul className="flex flex-col gap-2">
            {data.pendingApprovals.map((a) => (
              <li key={a.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2 text-sm">
                <span><strong>{a.registerCode}</strong> · {a.cashier}: {a.summary} <span className="text-muted">({time(a.createdAt)})</span></span>
                <span className="flex gap-2">
                  <Button variant="primary" onClick={async () => { try { await post('approvals/approve', { requestId: a.requestId }); await load(); } catch (e) { setError(errorText(e)); } }}>Approve</Button>
                  <Button onClick={async () => { try { await post('approvals/reject', { requestId: a.requestId }); await load(); } catch (e) { setError(errorText(e)); } }}>Reject</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Payment mix (net of refunds)"><PaymentMix data={data} /></Card>
        <Card title="Drawer cash now (expected)">
          {data.drawers.length === 0 ? <p className="text-sm text-muted">No open shifts.</p> : (
            <Table head={['Till', 'Cashier', 'Since', 'Expected cash']} right={[3]}
              rows={data.drawers.map((d) => [d.registerCode, d.cashier, time(d.openedAt), formatKes(d.expectedCents)])} />
          )}
        </Card>
      </div>

      <Card title={`Alerts inbox (${data.alerts.unacknowledged.HIGH} high, ${data.alerts.unacknowledged.MEDIUM} medium, ${data.alerts.unacknowledged.LOW} low)`}>
        {data.alerts.items.length === 0 ? <p className="text-sm text-muted">Nothing needs attention.</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {data.alerts.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span><span className="font-medium">{ALERT_LABELS[a.type] ?? a.type}:</span> {a.subject} <span className="text-muted">{time(a.createdAt)}</span></span>
                </span>
                <span className="flex gap-2">
                  {a.shiftId && <Button variant="ghost" onClick={() => navigate(`/admin/shifts?shift=${a.shiftId}`)}>Shift</Button>}
                  <Button onClick={() => setAck(a)}>Acknowledge</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Shifts" actions={<Button variant="ghost" onClick={() => navigate('/admin/shifts')}>Manage shifts</Button>}>
        {data.shifts.length === 0 ? <p className="text-sm text-muted">No shifts in this range.</p> : (
          <Table head={['Till', 'Cashier', 'Status', 'Opened', 'Expected', 'Counted', 'Variance', 'Flags']} right={[4, 5, 6]}
            rows={data.shifts.map((s) => [
              s.registerCode, s.cashier, statusLabel(s.status), time(s.openedAt), formatKes(s.expectedCents),
              s.countedCents === null ? '—' : formatKes(s.countedCents),
              s.varianceCents === null ? '—' : <Variance cents={s.netVarianceCents ?? s.varianceCents} />,
              [s.forced ? 'forced close' : '', s.recounts ? `${s.recounts} recount` : '', s.unackedAlerts ? `${s.unackedAlerts} alert(s)` : ''].filter(Boolean).join(', ') || '—',
            ])} />
        )}
      </Card>

      <Card title="Exceptions by cashier (vs 30-day average)">
        {data.exceptions.length === 0 ? <p className="text-sm text-muted">No voids, refunds, overrides, removals or no-sales.</p> : (
          <Table head={['Cashier', 'Voids', 'Refunds', 'Price overrides', 'Lines removed', 'Carts cancelled', 'No-sales']} right={[1, 2, 3, 4, 5, 6]}
            rows={data.exceptions.map((x) => [
              x.name,
              <Exc n={x.current.voids} base={x.baselinePerDay.voids} days={data.range.days} money={x.current.voidCents} />,
              <Exc n={x.current.refunds} base={x.baselinePerDay.refunds} days={data.range.days} money={x.current.refundCents} />,
              <Exc n={x.current.overrides} base={x.baselinePerDay.overrides} days={data.range.days} money={x.current.overrideCents} />,
              <Exc n={x.current.lineRemovals} base={x.baselinePerDay.lineRemovals} days={data.range.days} />,
              <Exc n={x.current.cartCancels} base={x.baselinePerDay.cartCancels} days={data.range.days} />,
              <Exc n={x.current.noSales} base={x.baselinePerDay.noSales} days={data.range.days} />,
            ])} />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Low stock">
          {data.lowStock.length === 0 ? <p className="text-sm text-muted">Everything is above its reorder level.</p> : (
            <Table head={['Product', 'On hand', 'Reorder at', 'Days of cover']} right={[1, 2, 3]}
              rows={data.lowStock.map((p) => [p.name, p.onHand, p.reorderLevel, p.daysOfCover ?? '—'])} />
          )}
        </Card>
        <Card title="Live feed">
          <ul className="flex flex-col gap-1 text-sm">
            {feed.map((f) => <li key={f.key}><span className="text-muted">{new Date(f.at).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' })}</span> {f.text}</li>)}
            {data.recentSales.map((s) => (
              <li key={s.saleId} className="text-ink-2">
                <span className="text-muted">{time(s.at)}</span> Sale {s.receiptLabel} {formatKes(s.totalCents)} by {s.cashier} ({(s.methods ?? []).join(' + ')})
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {ack && <AckAlert alert={ack} onClose={() => setAck(null)} onDone={async () => { setAck(null); await load(); }} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </div>
  );
}

export function statusLabel(s: string) {
  return { OPEN: 'Open', PENDING_COUNT: 'Waiting for count', CLOSED_UNRECONCILED: '⛔ Needs review', CLOSED: 'Closed' }[s] ?? s;
}

export function Variance({ cents }: { cents: number }) {
  if (cents === 0) return <span className="tabular">KES 0.00</span>;
  return <span className="font-medium tabular">{cents > 0 ? '+' : ''}{formatKes(cents)} {cents < 0 ? 'short' : 'over'}</span>;
}

function Exc({ n, base, days, money }: { n: number; base: number; days: number; money?: number }) {
  const expected = base * days;
  const unusual = n >= 2 && n > 2 * expected;
  return (
    <span className={unusual ? 'font-semibold' : ''} title={`30-day average: ${base.toFixed(2)} per day`}>
      {unusual && <span aria-label="unusual">⚠️ </span>}
      {n}{money ? ` · ${formatKes(money)}` : ''}
      <span className="block text-xs font-normal text-muted">avg {base.toFixed(1)}/day</span>
    </span>
  );
}

export function Table({ head, rows, right = [] }: { head: string[]; rows: React.ReactNode[][]; right?: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted">{head.map((h, i) => <th key={h} className={`px-2 py-1 font-medium ${right.includes(i) ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => <td key={j} className={`px-2 py-1.5 align-top ${right.includes(j) ? 'text-right tabular' : ''}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SERIES = [
  { method: 'CASH', label: 'Cash', color: 'var(--series-1)' },
  { method: 'MPESA', label: 'M-Pesa', color: 'var(--series-2)' },
  { method: 'CARD', label: 'Card', color: 'var(--series-3)' },
] as const;

/** Part-to-whole bar: 3 fixed-order categorical slots, 2px surface gaps, legend + values table. */
function PaymentMix({ data }: { data: DashboardData }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = SERIES.map((s) => ({ ...s, cents: data.paymentMix.find((m) => m.method === s.method)?.amountCents ?? 0 }));
  const sum = rows.reduce((t, r) => t + Math.max(0, r.cents), 0);
  const share = (c: number) => (data.netSalesCents > 0 ? `${((c / data.netSalesCents) * 100).toFixed(1)}%` : '—');

  return (
    <div className="flex flex-col gap-3">
      {sum === 0 ? <p className="text-sm text-muted">No payments in this range.</p> : (
        <div className="relative">
          <div className="flex h-6 gap-[2px] overflow-hidden rounded bg-surface" role="img"
            aria-label={rows.map((r) => `${r.label} ${formatKes(r.cents)}`).join(', ')}>
            {rows.map((r, i) => r.cents > 0 && (
              <div key={r.method} tabIndex={0} aria-label={`${r.label}: ${formatKes(r.cents)}, ${share(r.cents)} of net sales`}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                style={{ width: `${(r.cents / sum) * 100}%`, background: r.color, opacity: hover === null || hover === i ? 1 : 0.55 }}
                className="h-full first:rounded-l last:rounded-r" />
            ))}
          </div>
          {hover !== null && (
            <div className="pointer-events-none absolute -top-9 left-0 rounded border border-line bg-surface px-2 py-1 text-xs shadow">
              {rows[hover]!.label}: {formatKes(rows[hover]!.cents)} ({share(rows[hover]!.cents)})
            </div>
          )}
        </div>
      )}
      <table className="text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.method}>
              <td className="py-0.5 pr-2"><span aria-hidden className="inline-block h-3 w-3 rounded-sm align-middle" style={{ background: r.color }} /> {r.label}</td>
              <td className="py-0.5 pr-4 text-right tabular">{formatKes(r.cents)}</td>
              <td className="py-0.5 text-right text-muted tabular">{share(r.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AckAlert({ alert, onClose, onDone }: { alert: AlertRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Acknowledge alert" onClose={onClose}>
      <p className="mb-3 text-sm">{alert.subject}</p>
      <form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post('owner/alerts/acknowledge', { alertId: alert.id, ...(note.trim() ? { note: note.trim() } : {}) });
          await onDone();
        } catch (err) { setError(errorText(err)); }
      }}>
        <Input placeholder="What did you find or do? (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} autoFocus />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Acknowledge</Button></div>
      </form>
    </Modal>
  );
}
