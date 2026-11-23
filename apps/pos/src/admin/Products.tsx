import { useCallback, useEffect, useMemo, useState } from 'react';
import { STOCK_REASONS, formatKes, parseKesToCents, type StockReason } from '@shop/shared';
import { errorText, post, read } from '../lib/api.ts';
import { reasonLabel } from '../lib/printer.ts';
import { Banner, Button, Card, Field, Input, Modal, Select, Spinner } from '../ui/ui.tsx';
import { Table } from './Dashboard.tsx';

interface Product {
  id: string; sku: string; barcode: string | null; name: string; priceCents: number; reorderLevel: number;
  active: boolean; onHand: number; avgCostCents: number;
}
type Dialog = null | { kind: 'edit'; product: Product | null } | { kind: 'receive' | 'adjust'; product: Product };

const kes = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

export function Products() {
  const [list, setList] = useState<Product[] | null>(null);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList(await read<Product[]>('owner_products')); } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || (p.barcode ?? '').includes(s));
  }, [list, q]);

  const done = async () => { setDialog(null); await load(); };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search name, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-64 flex-1" />
        <Button variant="primary" onClick={() => setDialog({ kind: 'edit', product: null })}>New product</Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!list ? <Spinner /> : (
        <Card title={`${shown.length} product(s)`}>
          <Table head={['Product', 'SKU', 'Barcode', 'Price', 'Avg cost', 'Margin', 'On hand', 'Reorder at', '']} right={[3, 4, 5, 6, 7]}
            rows={shown.map((p) => [
              <span>{p.name}{!p.active && <span className="ml-1 text-xs text-muted">(not sold)</span>}</span>,
              p.sku, p.barcode ?? '—', formatKes(p.priceCents), formatKes(Math.round(p.avgCostCents)),
              p.priceCents > 0 ? `${(((p.priceCents - p.avgCostCents) / p.priceCents) * 100).toFixed(1)}%` : '—',
              <span className={p.onHand <= p.reorderLevel ? 'font-semibold' : ''}>{p.onHand <= p.reorderLevel && '⚠️ '}{p.onHand}</span>,
              p.reorderLevel,
              <span className="flex justify-end gap-1">
                <Button variant="ghost" onClick={() => setDialog({ kind: 'receive', product: p })}>Receive</Button>
                <Button variant="ghost" onClick={() => setDialog({ kind: 'adjust', product: p })}>Adjust</Button>
                <Button variant="ghost" onClick={() => setDialog({ kind: 'edit', product: p })}>Edit</Button>
              </span>,
            ])} />
        </Card>
      )}
      {dialog?.kind === 'edit' && <EditProduct product={dialog.product} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'receive' && <Receive product={dialog.product} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'adjust' && <Adjust product={dialog.product} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function useSubmit(onDone: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await onDone(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return { error, setError, busy, submit };
}

function EditProduct({ product, onClose, onDone }: { product: Product | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [sku, setSku] = useState(product?.sku ?? '');
  const [barcode, setBarcode] = useState(product?.barcode ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [price, setPrice] = useState(product ? kes(product.priceCents) : '');
  const [reorder, setReorder] = useState(String(product?.reorderLevel ?? 0));
  const [active, setActive] = useState(product?.active ?? true);
  const { error, setError, busy, submit } = useSubmit(onDone);

  return (
    <Modal title={product ? `Edit ${product.name}` : 'New product'} onClose={onClose} locked={busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        const priceCents = parseKesToCents(price);
        if (priceCents === null) return setError('Type the selling price in shillings.');
        if (!/^\d{1,7}$/.test(reorder)) return setError('Reorder level must be a whole number.');
        void submit(() => post('owner/products/upsert', {
          ...(product ? { id: product.id } : {}), sku: sku.trim(), name: name.trim(), priceCents, reorderLevel: Number(reorder), active,
          ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
        }));
      }}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU"><Input value={sku} onChange={(e) => setSku(e.target.value)} required pattern="[A-Za-z0-9._\-]{1,40}" /></Field>
          <Field label="Barcode" hint="Scan it into this box"><Input value={barcode} onChange={(e) => setBarcode(e.target.value)} pattern="[0-9A-Za-z\-]{4,64}" /></Field>
          <Field label="Selling price (KES)"><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></Field>
          <Field label="Reorder level"><Input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> On sale</label>
        <p className="text-xs text-muted">Every price change is kept in price history. Stock is only changed by receiving, adjusting or counting.</p>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function Receive({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => Promise<void> }) {
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const { error, setError, busy, submit } = useSubmit(onDone);
  return (
    <Modal title={`Receive ${product.name}`} onClose={onClose} locked={busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        const unitCostCents = parseKesToCents(cost);
        if (!/^\d{1,7}$/.test(qty) || Number(qty) < 1) return setError('Quantity must be a whole number above 0.');
        if (unitCostCents === null) return setError('Type the unit cost in shillings.');
        void submit(() => post('owner/stock/receive', { productId: product.id, qty: Number(qty), unitCostCents, supplier: supplier.trim(), ...(note.trim() ? { note: note.trim() } : {}) }));
      }}>
        <p className="text-sm text-ink-2">On hand now: {product.onHand}. Average cost {formatKes(Math.round(product.avgCostCents))}; receiving updates the weighted average.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity received"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus required /></Field>
          <Field label="Unit cost (KES)"><Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} required /></Field>
        </div>
        <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} required maxLength={120} /></Field>
        <Field label="Note (invoice number etc.)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Receive</Button></div>
      </form>
    </Modal>
  );
}

function Adjust({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => Promise<void> }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<StockReason>('CORRECTION');
  const [note, setNote] = useState('');
  const { error, setError, busy, submit } = useSubmit(onDone);
  return (
    <Modal title={`Adjust ${product.name}`} onClose={onClose} locked={busy}>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        if (!/^-?\d{1,7}$/.test(delta.trim()) || Number(delta) === 0) return setError('Type a change like -2 or 5.');
        if (reason === 'OTHER' && !note.trim()) return setError('Write a note for OTHER.');
        void submit(() => post('owner/stock/adjust', { productId: product.id, qtyDelta: Number(delta), reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) }));
      }}>
        <p className="text-sm text-ink-2">On hand now: {product.onHand}. Every adjustment is recorded with its reason.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Change (+ / −)"><Input value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus required /></Field>
          <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value as StockReason)}>{STOCK_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}</Select></Field>
        </div>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Record adjustment</Button></div>
      </form>
    </Modal>
  );
}
