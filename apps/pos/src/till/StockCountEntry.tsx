import { useEffect, useRef, useState } from 'react';
import { errorText, post, read } from '../lib/api.ts';
import { beepError, beepOk } from '../lib/sound.ts';
import { Banner, Button, Card, Input, Spinner } from '../ui/ui.tsx';

interface Item { productId: string; name: string; sku: string; barcode: string | null; countedQty: number | null }
interface MyCount { count: { id: string; note: string | null } | null; items?: Item[] }

/** FR-IN-4: counters see names and barcodes only, never system quantities. */
export function StockCountEntry({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<MyCount | null>(null);
  const [scan, setScan] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'error' | 'good'; text: string } | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = async () => {
    try {
      setData(await read<MyCount>('my_stock_count'));
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e) });
    }
  };
  useEffect(() => { void load(); }, []);

  if (!data) return message ? <div className="p-4"><Banner tone="error">{message.text}</Banner></div> : <Spinner />;
  if (!data.count) {
    return <div className="mx-auto max-w-lg p-4"><Card title="Stock count"><p className="mb-3 text-sm">No count is assigned to you.</p><Button onClick={onDone}>Back</Button></Card></div>;
  }
  const items = data.items ?? [];

  const save = async (item: Item) => {
    const raw = values[item.productId] ?? '';
    if (!/^\d{1,7}$/.test(raw)) return setMessage({ tone: 'error', text: `Type a whole number for ${item.name}.` });
    try {
      await post('stock-counts/line', { countId: data.count!.id, productId: item.productId, countedQty: Number(raw) });
      beepOk();
      setMessage({ tone: 'good', text: `${item.name}: ${raw} saved.` });
      setValues((v) => ({ ...v, [item.productId]: '' }));
      await load();
    } catch (e) {
      beepError();
      setMessage({ tone: 'error', text: errorText(e) });
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-4">
      <Card title={`Stock count${data.count.note ? `: ${data.count.note}` : ''}`} actions={<Button onClick={onDone}>Back to till</Button>}>
        <form className="mb-3" onSubmit={(e) => {
          e.preventDefault();
          const code = scan.trim();
          setScan('');
          const item = items.find((i) => i.barcode === code || i.sku.toUpperCase() === code.toUpperCase());
          if (!item) {
            beepError();
            return setMessage({ tone: 'error', text: `"${code}" is not part of this count.` });
          }
          inputs.current[item.productId]?.focus();
        }}>
          <Input value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan a product to jump to it" autoFocus className="w-full" />
        </form>
        {message && <div className="mb-3"><Banner tone={message.tone}>{message.text}</Banner></div>}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="py-1">Product</th><th>SKU</th><th className="text-right">Your last count</th><th className="text-right">Count now</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.productId} className="border-t border-line">
                <td className="py-1">{i.name}</td>
                <td className="text-muted">{i.sku}</td>
                <td className="text-right tabular">{i.countedQty ?? '—'}</td>
                <td className="text-right">
                  <input ref={(el) => { inputs.current[i.productId] = el; }} aria-label={`Count for ${i.name}`}
                    className="w-24 rounded border border-line bg-surface px-2 py-1 text-right tabular" inputMode="numeric"
                    value={values[i.productId] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.productId]: e.target.value.replace(/\D/g, '') }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(i); } }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
