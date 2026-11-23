import { useCallback, useEffect, useState } from 'react';
import { errorText, post, read } from '../lib/api.ts';
import { Banner, Button, Card, Field, Input, Modal, Select, Spinner, time } from '../ui/ui.tsx';
import { Table } from './Dashboard.tsx';

interface CountRow { id: string; status: 'OPEN' | 'POSTED' | 'CANCELLED'; note: string | null; openedAt: string; closedAt: string | null; assignedName: string | null; items: number; counted: number }
interface DetailLine { productId: string; name: string; sku: string; onHandNow: number; countedQty: number | null; systemQtyAtCount: number | null; diff: number | null; countedBy: string | null }
interface Staff { userId: string; displayName: string; active: boolean }
interface Product { id: string; name: string; sku: string; active: boolean }

export function StockCounts() {
  const [rows, setRows] = useState<CountRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows(await read<CountRow[]>('owner_stock_counts')); } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between gap-2">
        <p className="text-sm text-ink-2">Counters see product names and barcodes only, never the system quantity. Differences post as COUNT_VARIANCE movements.</p>
        <Button variant="primary" onClick={() => setOpen(true)} disabled={rows?.some((r) => r.status === 'OPEN')}>New count</Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!rows ? <Spinner /> : (
        <Card title="Stock counts">
          <Table head={['Opened', 'Status', 'Assigned to', 'Products', 'Counted', 'Note', '']} right={[3, 4]}
            rows={rows.map((r) => [time(r.openedAt), r.status, r.assignedName ?? 'Owner only', r.items, r.counted, r.note ?? '',
              <Button variant="ghost" onClick={() => setDetail(r.id)}>Open</Button>])} />
        </Card>
      )}
      {open && <NewCount onClose={() => setOpen(false)} onDone={async () => { setOpen(false); await load(); }} />}
      {detail && <CountDetail countId={detail} onClose={() => setDetail(null)} onChanged={load} />}
    </div>
  );
}

function NewCount({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [assignee, setAssignee] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void read<Staff[]>('owner_staff').then((s) => setStaff(s.filter((x) => x.active))).catch((e) => setError(errorText(e)));
    void read<Product[]>('owner_products').then((p) => setProducts(p.filter((x) => x.active))).catch((e) => setError(errorText(e)));
  }, []);

  const shown = products.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase()));

  return (
    <Modal title="New stock count" onClose={onClose} wide locked={busy}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!all && picked.size === 0) return setError('Pick at least one product.');
        setBusy(true);
        setError(null);
        try {
          await post('owner/stock-counts/open', {
            ...(all ? { allProducts: true } : { productIds: [...picked] }),
            ...(assignee ? { assignedTo: assignee } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          });
          await onDone();
        } catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Who counts">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Owner only</option>
              {staff.map((s) => <option key={s.userId} value={s.userId}>{s.displayName}</option>)}
            </Select>
          </Field>
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Count every product on sale</label>
        {!all && (
          <div className="flex flex-col gap-2">
            <Input placeholder="Filter products" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="max-h-64 overflow-auto rounded border border-line p-2 text-sm">
              {shown.map((p) => (
                <label key={p.id} className="flex items-center gap-2 py-0.5">
                  <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(p.id); else n.delete(p.id);
                    return n;
                  })} /> {p.name} <span className="text-muted">{p.sku}</span>
                </label>
              ))}
            </div>
            <span className="text-xs text-muted">{picked.size} selected</span>
          </div>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Open count</Button></div>
      </form>
    </Modal>
  );
}

function CountDetail({ countId, onClose, onChanged }: { countId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [d, setD] = useState<{ status: string; note: string | null; lines: DetailLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setD(await read('owner_stock_count_detail', { countId })); } catch (e) { setError(errorText(e)); }
  }, [countId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (path: 'owner/stock-counts/post' | 'owner/stock-counts/cancel') => {
    setBusy(true);
    setError(null);
    try {
      const r = await post(path, { countId });
      if (path === 'owner/stock-counts/post') {
        setResult(`Posted. ${r.lines.length} counted product(s); variance at cost ${new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(r.varianceValueCents / 100)}; ${r.uncounted} not counted (unchanged).`);
      }
      await load();
      await onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title="Stock count" onClose={onClose} wide locked={busy}>
      {!d ? (error ? <Banner tone="error">{error}</Banner> : <Spinner />) : (
        <div className="flex flex-col gap-3 text-sm">
          <div>Status: <strong>{d.status}</strong>{d.note ? ` · ${d.note}` : ''}</div>
          <Table head={['Product', 'SKU', 'Counted', 'System at count', 'Difference', 'On hand now', 'Counted by']} right={[2, 3, 4, 5]}
            rows={d.lines.map((l) => [l.name, l.sku, l.countedQty ?? '—', l.systemQtyAtCount ?? '—',
              l.diff === null ? '—' : <span className={l.diff !== 0 ? 'font-semibold' : ''}>{l.diff > 0 ? '+' : ''}{l.diff}</span>, l.onHandNow, l.countedBy ?? '—'])} />
          {result && <Banner tone="good">{result}</Banner>}
          {error && <Banner tone="error">{error}</Banner>}
          {d.status === 'OPEN' && (
            <div className="flex justify-end gap-2">
              <Button onClick={() => void act('owner/stock-counts/cancel')} disabled={busy}>Cancel count</Button>
              <Button variant="primary" onClick={() => void act('owner/stock-counts/post')} disabled={busy}>Post differences</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
