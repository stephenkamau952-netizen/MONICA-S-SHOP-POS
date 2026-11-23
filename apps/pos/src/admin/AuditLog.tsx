import { useCallback, useEffect, useState } from 'react';
import { errorText, read } from '../lib/api.ts';
import { Banner, Button, Card, Spinner, time } from '../ui/ui.tsx';

interface Row { id: number; action: string; targetType: string | null; targetId: string | null; actor: string | null; before: unknown; after: unknown; createdAt: string; rowHash: string }

export function AuditLog() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState(true);

  const load = useCallback(async (beforeId?: number) => {
    try {
      const page = await read<Row[]>('owner_audit_log', { limit: 100, ...(beforeId ? { beforeId } : {}) });
      setRows((r) => (beforeId ? [...(r ?? []), ...page] : page));
      setMore(page.length === 100);
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!rows) return error ? <Banner tone="error">{error}</Banner> : <Spinner />;
  return (
    <Card title="Audit log (append-only, hash-chained; verified every night)">
      {error && <Banner tone="error">{error}</Banner>}
      <ul className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <li key={r.id} className="py-1.5">
            <button type="button" className="flex w-full flex-wrap justify-between gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <span><span className="text-muted">#{r.id} {time(r.createdAt)}</span> <strong>{r.action}</strong> {r.targetType ? `${r.targetType}` : ''} <span className="text-ink-2">by {r.actor ?? 'system'}</span></span>
              <span className="font-mono text-xs text-muted">{r.rowHash.slice(0, 12)}…</span>
            </button>
            {open === r.id && (
              <pre className="mt-1 overflow-auto rounded bg-surface-2 p-2 text-xs">{JSON.stringify({ target: r.targetId, before: r.before, after: r.after }, null, 2)}</pre>
            )}
          </li>
        ))}
      </ul>
      {more && <div className="mt-3"><Button onClick={() => void load(rows[rows.length - 1]?.id)}>Load older</Button></div>}
    </Card>
  );
}
