import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatKes, type PaymentInput, type Receipt } from '@shop/shared';
import { useReady, type OpenShiftInfo } from '../auth/AuthProvider.tsx';
import { ApiError, errorText, newId, post } from '../lib/api.ts';
import { sb } from '../lib/supabase.ts';
import { beepError, beepOk } from '../lib/sound.ts';
import { printReceipt } from '../lib/printer.ts';
import { Banner, Button, Kbd, Modal } from '../ui/ui.tsx';
import { logCartEvent } from './cartEvents.ts';
import { PaymentPanel, type PayMethod } from './PaymentPanel.tsx';
import { CashDialog, OverrideDialog, QtyDialog, ReversalDialog } from './dialogs.tsx';

export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price_cents: number;
}

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  qty: number;
  listPriceCents: number;
  override?: { priceCents: number; approvalId?: string; expiresAt?: string };
}

interface Cart {
  key: string; // idempotency key for the sale and cart key for cart events
  lines: CartLine[];
}

type ModalState =
  | null
  | { kind: 'pay'; method: PayMethod }
  | { kind: 'qty' }
  | { kind: 'override' }
  | { kind: 'cash' }
  | { kind: 'reversal' }
  | { kind: 'cancel' }
  | { kind: 'help' };

const MAX_LINES = 200;
const unitPrice = (l: CartLine) => l.override?.priceCents ?? l.listPriceCents;
const newCart = (): Cart => ({ key: newId(), lines: [] });

export function SaleScreen({ shift, disabled, onCloseShift }: {
  shift: OpenShiftInfo;
  disabled: boolean;
  onCloseShift: () => void;
}) {
  const { ctx } = useReady();
  const ownerDirect = ctx.role === 'OWNER' && ctx.mfaVerified === true;
  const [catalog, setCatalog] = useState<Map<string, Product>>(new Map());
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(newCart);
  const [selected, setSelected] = useState(0);
  const [scan, setScan] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'warn' | 'good' | 'info'; text: string } | null>(null);
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  // After a network failure the sale may or may not have been recorded; the
  // cart is frozen so a retry with the same key returns the original sale.
  const [awaitingRetry, setAwaitingRetry] = useState(false);
  const [now, setNow] = useState(Date.now());
  const scanRef = useRef<HTMLInputElement>(null);

  const total = useMemo(() => cart.lines.reduce((s, l) => s + unitPrice(l) * l.qty, 0), [cart]);
  const items = useMemo(() => cart.lines.reduce((s, l) => s + l.qty, 0), [cart]);

  const loadCatalog = useCallback(async (): Promise<Map<string, Product> | null> => {
    const { data, error } = await sb()
      .from('products').select('id,sku,barcode,name,price_cents').eq('active', true).order('name').range(0, 19999);
    if (error) {
      setCatalogError(`Could not load products: ${error.message}`);
      return null;
    }
    const map = new Map<string, Product>();
    for (const p of data as Product[]) {
      map.set(p.sku.toUpperCase(), p);
      if (p.barcode) map.set(p.barcode, p);
    }
    setCatalog(map);
    setCatalogError(null);
    return map;
  }, []);

  useEffect(() => {
    void loadCatalog();
    const t = setInterval(() => void loadCatalog(), 5 * 60_000);
    return () => clearInterval(t);
  }, [loadCatalog]);

  // Countdown for override approvals (tokens expire in 120 s).
  useEffect(() => {
    if (!cart.lines.some((l) => l.override?.expiresAt)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cart]);

  // FR-CO-1: the scan field keeps focus whenever nothing else needs it.
  useEffect(() => {
    if (modal || disabled) return;
    scanRef.current?.focus();
    const t = setInterval(() => {
      if (document.activeElement !== scanRef.current) scanRef.current?.focus();
    }, 400);
    return () => clearInterval(t);
  }, [modal, disabled]);

  const say = (tone: 'error' | 'warn' | 'good' | 'info', text: string) => setMessage({ tone, text });

  const frozen = () => {
    if (awaitingRetry) {
      beepError();
      say('warn', 'The last payment did not reach the server. Retry it (F2/F3/F4) before changing the cart, or Esc to cancel.');
      return true;
    }
    return false;
  };

  const addProduct = (p: Product) => {
    if (frozen()) return;
    const last = cart.lines[cart.lines.length - 1];
    let lines: CartLine[];
    if (last && last.productId === p.id && !last.override && last.qty < 999) {
      lines = cart.lines.slice();
      lines[lines.length - 1] = { ...last, qty: last.qty + 1 };
    } else if (cart.lines.length >= MAX_LINES) {
      beepError();
      say('error', `A sale can have at most ${MAX_LINES} lines.`);
      return;
    } else {
      lines = [...cart.lines, { lineId: newId(), productId: p.id, name: p.name, qty: 1, listPriceCents: p.price_cents }];
    }
    setCart({ ...cart, lines });
    setSelected(lines.length - 1);
    beepOk();
    setMessage(null);
  };

  const onScan = () => {
    const code = scan.trim();
    setScan('');
    if (!code) return;
    const p = catalog.get(code) ?? catalog.get(code.toUpperCase());
    if (!p) {
      beepError();
      say('error', `Unknown code "${code}". Nothing was added.`);
      return;
    }
    addProduct(p);
  };

  const removeLine = (idx: number) => {
    const line = cart.lines[idx];
    if (!line || frozen()) return;
    logCartEvent({ kind: 'LINE_REMOVED', shiftId: shift.id, eventKey: newId(), cartKey: cart.key, productId: line.productId, qty: line.qty });
    setCart((c) => ({ ...c, lines: c.lines.filter((_, i) => i !== idx) }));
    setSelected((s) => Math.max(0, Math.min(s, cart.lines.length - 2)));
    say('info', `Removed ${line.name}. This is recorded.`);
  };

  const setQty = (idx: number, qty: number) => {
    const line = cart.lines[idx];
    if (!line || frozen()) return;
    if (qty === 0) return removeLine(idx);
    if (qty < line.qty) {
      logCartEvent({ kind: 'QTY_REDUCED', shiftId: shift.id, eventKey: newId(), cartKey: cart.key, productId: line.productId, qty: line.qty - qty });
    }
    setCart((c) => ({ ...c, lines: c.lines.map((l, i) => (i === idx ? { ...l, qty } : l)) }));
  };

  const cancelCart = () => {
    if (cart.lines.length > 0) {
      logCartEvent({
        kind: 'CART_CANCELLED', shiftId: shift.id, eventKey: newId(), cartKey: cart.key,
        lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      });
    }
    setCart(newCart());
    setSelected(0);
    setAwaitingRetry(false);
    say('info', 'Cart cancelled. This is recorded.');
  };

  const expiredOverride = cart.lines.find((l) => l.override?.expiresAt && Date.parse(l.override.expiresAt) <= now);

  const openPay = (method: PayMethod) => {
    if (cart.lines.length === 0) {
      beepError();
      say('warn', 'Scan an item first.');
      return;
    }
    if (expiredOverride) {
      beepError();
      say('error', `The price approval for "${expiredOverride.name}" expired. Select it and press F6 again, or remove it.`);
      return;
    }
    setModal({ kind: 'pay', method });
  };

  const completeSale = async (payments: PaymentInput[]): Promise<void> => {
    const body = {
      idempotencyKey: cart.key,
      shiftId: shift.id,
      lines: cart.lines.map((l) => ({
        productId: l.productId,
        qty: l.qty,
        ...(l.override
          ? { overridePriceCents: l.override.priceCents, ...(l.override.approvalId ? { overrideApprovalId: l.override.approvalId } : {}) }
          : {}),
      })),
      payments,
    };
    try {
      const receipt = await post<'sales', Receipt>('sales', body);
      setAwaitingRetry(false);
      setModal(null);
      setCart(newCart());
      setSelected(0);
      setLastReceipt(receipt);
      const warn = await printReceipt(receipt, ctx.refundWindowDays ?? 7);
      const change = receipt.changeDueCents > 0 ? `Change ${formatKes(receipt.changeDueCents)}. ` : '';
      const replay = receipt.replayed ? 'This sale had already been recorded; its receipt was printed again. ' : '';
      say(warn ? 'warn' : 'good', `${replay}${change}Receipt ${receipt.receiptLabel}, ${formatKes(receipt.totalCents)}.${warn ? ` ${warn}` : ''}`);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'UPSTREAM_ERROR')) {
        setAwaitingRetry(true);
        throw new ApiError(e.code, 'The sale was NOT confirmed. Check the connection and press Enter to retry; the same sale key is reused so it cannot be recorded twice.');
      }
      if (e instanceof ApiError && (e.code === 'PAYMENT_MISMATCH' || e.code === 'INSUFFICIENT_TENDER' || e.code === 'PRODUCT_UNAVAILABLE')) {
        void loadCatalog().then((m) => { if (m) repriceFromCatalog(m); });
      }
      throw e;
    }
  };

  // Prices are server-authoritative: refresh what the cart shows.
  const repriceFromCatalog = (map: Map<string, Product>) => {
    const byId = new Map([...map.values()].map((p) => [p.id, p]));
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => {
        const p = byId.get(l.productId);
        return p ? { ...l, listPriceCents: p.price_cents, name: p.name } : l;
      }),
    }));
  };

  const reprint = async () => {
    if (!lastReceipt) return;
    try {
      const r = await post<'sales/reprint', Receipt>('sales/reprint', { saleId: lastReceipt.saleId });
      const warn = await printReceipt(r, ctx.refundWindowDays ?? 7);
      say(warn ? 'warn' : 'info', warn ?? `Reprinted ${r.receiptLabel} (logged).`);
    } catch (e) {
      say('error', errorText(e));
    }
  };

  // FR-CO-2 keyboard shortcuts. Everything works without a mouse.
  useEffect(() => {
    if (disabled || modal) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === 'F2') { handled(); openPay('CASH'); }
      else if (k === 'F3') { handled(); openPay('MPESA'); }
      else if (k === 'F4') { handled(); openPay('CARD'); }
      else if (k === 'F8') { handled(); if (cart.lines[selected] && !frozen()) setModal({ kind: 'qty' }); }
      else if (k === 'F6') { handled(); if (cart.lines[selected] && !frozen()) setModal({ kind: 'override' }); }
      else if (k === 'F7') { handled(); if (cart.lines.length === 0) setModal({ kind: 'cash' }); else say('warn', 'Finish or cancel the sale first.'); }
      else if (k === 'F9') { handled(); if (cart.lines.length === 0) setModal({ kind: 'reversal' }); else say('warn', 'Finish or cancel the sale first.'); }
      else if (k === 'F10') { handled(); if (cart.lines.length === 0) onCloseShift(); else say('warn', 'Finish or cancel the sale before closing the shift.'); }
      else if (k === 'F1') { handled(); setModal({ kind: 'help' }); }
      else if (k === 'Delete') { handled(); removeLine(selected); }
      else if (k === 'Escape') { handled(); if (cart.lines.length > 0) setModal({ kind: 'cancel' }); }
      else if (k === 'ArrowUp') { handled(); setSelected((s) => Math.max(0, s - 1)); }
      else if (k === 'ArrowDown') { handled(); setSelected((s) => Math.min(cart.lines.length - 1, s + 1)); }
      else if (e.altKey && (k === 'r' || k === 'R')) { handled(); void reprint(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sel = cart.lines[selected];

  return (
    <div className="grid h-full grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_22rem]">
      <section className="flex min-h-0 flex-col rounded-lg border border-line bg-surface">
        <form className="border-b border-line p-3" onSubmit={(e) => { e.preventDefault(); onScan(); }}>
          <label className="sr-only" htmlFor="scan">Scan barcode or type SKU</label>
          <input
            id="scan"
            ref={scanRef}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder="Scan a barcode or type a SKU, then Enter"
            className="w-full rounded-md border border-line bg-page px-4 py-3 text-lg"
          />
        </form>
        {catalogError && <div className="p-3"><Banner tone="error">{catalogError}</Banner></div>}
        <div className="min-h-0 flex-1 overflow-auto">
          {cart.lines.length === 0 ? (
            <p className="p-6 text-center text-muted">Cart is empty. Scan to start. <Kbd>F1</Kbd> shows all shortcuts.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-surface text-xs text-muted">
                <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-right">Total</th></tr>
              </thead>
              <tbody>
                {cart.lines.map((l, i) => {
                  const left = l.override?.expiresAt ? Math.max(0, Math.round((Date.parse(l.override.expiresAt) - now) / 1000)) : null;
                  return (
                    <tr key={l.lineId} onClick={() => setSelected(i)} aria-selected={i === selected}
                      className={`border-t border-line ${i === selected ? 'bg-surface-2' : ''}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.name}</div>
                        {l.override && (
                          <div className={`text-xs ${left === 0 ? 'text-critical' : 'text-ink-2'}`}>
                            Override from {formatKes(l.listPriceCents)}
                            {left !== null && (left === 0 ? ' — approval expired, press F6' : ` — approval valid ${left}s`)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular">{l.qty}</td>
                      <td className="px-3 py-2 text-right tabular">{formatKes(unitPrice(l))}</td>
                      <td className="px-3 py-2 text-right font-medium tabular">{formatKes(unitPrice(l) * l.qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <aside className="flex flex-col gap-3">
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="text-sm text-muted">{items} item{items === 1 ? '' : 's'}</div>
          <div className="text-4xl font-bold tabular" aria-live="polite">{formatKes(total)}</div>
        </div>
        {message && <Banner tone={message.tone}>{message.text}</Banner>}
        <div className="grid grid-cols-3 gap-2">
          <Button variant="primary" onClick={() => openPay('CASH')}><Kbd>F2</Kbd> Cash</Button>
          <Button variant="primary" onClick={() => openPay('MPESA')}><Kbd>F3</Kbd> M-Pesa</Button>
          <Button variant="primary" onClick={() => openPay('CARD')}><Kbd>F4</Kbd> Card</Button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Button disabled={!sel} onClick={() => setModal({ kind: 'qty' })}><Kbd>F8</Kbd> Quantity</Button>
          <Button disabled={!sel} onClick={() => removeLine(selected)}><Kbd>Del</Kbd> Remove line</Button>
          <Button disabled={!sel} onClick={() => setModal({ kind: 'override' })}><Kbd>F6</Kbd> Price override</Button>
          <Button disabled={cart.lines.length === 0} onClick={() => setModal({ kind: 'cancel' })}><Kbd>Esc</Kbd> Cancel cart</Button>
          <Button disabled={cart.lines.length > 0} onClick={() => setModal({ kind: 'cash' })}><Kbd>F7</Kbd> Drawer / cash</Button>
          <Button disabled={cart.lines.length > 0} onClick={() => setModal({ kind: 'reversal' })}><Kbd>F9</Kbd> Void / refund</Button>
          <Button disabled={!lastReceipt} onClick={() => void reprint()}><Kbd>Alt+R</Kbd> Reprint</Button>
          <Button disabled={cart.lines.length > 0} onClick={onCloseShift}><Kbd>F10</Kbd> Close shift</Button>
        </div>
      </aside>

      {modal?.kind === 'pay' && (
        <PaymentPanel total={total} initialMethod={modal.method} onCancel={() => setModal(null)} onSubmit={completeSale} />
      )}
      {modal?.kind === 'qty' && sel && (
        <QtyDialog line={sel} onClose={() => setModal(null)} onSave={(q) => { setQty(selected, q); setModal(null); }} />
      )}
      {modal?.kind === 'override' && sel && (
        <OverrideDialog
          line={sel}
          shiftId={shift.id}
          ownerDirect={ownerDirect}
          onClose={() => setModal(null)}
          onApplied={(override) => {
            setCart((c) => ({ ...c, lines: c.lines.map((l, i) => (i === selected ? { ...l, override } : l)) }));
            setModal(null);
            say('info', `Price for ${sel.name} set to ${formatKes(override.priceCents)}.`);
          }}
        />
      )}
      {modal?.kind === 'cash' && (
        <CashDialog shiftId={shift.id} ownerDirect={ownerDirect} onClose={() => setModal(null)}
          onDone={(text) => { setModal(null); say('good', text); }} />
      )}
      {modal?.kind === 'reversal' && (
        <ReversalDialog shiftId={shift.id} ownerDirect={ownerDirect} onClose={() => setModal(null)}
          onDone={(text) => { setModal(null); say('good', text); void loadCatalog(); }} />
      )}
      {modal?.kind === 'cancel' && (
        <Modal title="Cancel this cart?" onClose={() => setModal(null)}>
          <p className="mb-4 text-sm text-ink-2">
            Every scanned line is recorded as cancelled.
            {awaitingRetry && ' If the last payment did go through, that sale is already recorded and the owner can see it.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setModal(null)}>Keep cart (Esc)</Button>
            <Button variant="danger" autoFocus onClick={() => { cancelCart(); setModal(null); }}>Cancel cart (Enter)</Button>
          </div>
        </Modal>
      )}
      {modal?.kind === 'help' && (
        <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}>
          <ul className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {[
              ['Enter', 'Add the scanned item'], ['F2 / F3 / F4', 'Pay cash / M-Pesa / card'], ['F8', 'Change quantity'],
              ['Del', 'Remove selected line (logged)'], ['Esc', 'Cancel cart (logged)'], ['↑ ↓', 'Select a line'],
              ['F6', 'Price override (owner approval)'], ['F7', 'Cash drop, paid-in, paid-out, no-sale'],
              ['F9', 'Void or refund a receipt'], ['F10', 'Close shift (blind count)'], ['Alt+R', 'Reprint last receipt'],
              ['Ctrl+L', 'Lock the till'],
            ].map(([k, v]) => (
              <li key={k} className="contents"><Kbd>{k}</Kbd><span>{v}</span></li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
