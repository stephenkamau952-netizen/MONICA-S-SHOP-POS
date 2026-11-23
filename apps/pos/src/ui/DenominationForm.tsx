import { useState } from 'react';
import { DENOMINATIONS, denominationTotalCents, emptyCounts, formatKes, type DenominationCounts } from '@shop/shared';
import { Button } from './ui.tsx';

/**
 * Count by denomination. The total shown is only what was counted — the app
 * never shows what the drawer "should" contain (blind count, FR-SH-3).
 * Enter moves to the next field; Enter on the last field submits.
 */
export function DenominationForm({ submitLabel, onSubmit, busy }: {
  submitLabel: string;
  onSubmit: (counts: DenominationCounts) => void;
  busy?: boolean;
}) {
  const [counts, setCounts] = useState<DenominationCounts>(emptyCounts());
  const total = denominationTotalCents(counts);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(counts);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {DENOMINATIONS.map((d, i) => (
          <label key={d.key} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
            <span className="text-sm">
              <span className="text-muted">{d.kind === 'note' ? 'Note' : 'Coin'}</span>{' '}
              <span className="font-semibold">KES {d.label}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted">×</span>
              <input
                aria-label={`Number of KES ${d.label} ${d.kind}s`}
                className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-right tabular"
                inputMode="numeric"
                autoFocus={i === 0}
                value={counts[d.key] === 0 ? '' : String(counts[d.key])}
                placeholder="0"
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 5);
                  setCounts((c) => ({ ...c, [d.key]: digits === '' ? 0 : Number(digits) }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && i < DENOMINATIONS.length - 1) {
                    e.preventDefault();
                    const inputs = (e.currentTarget.form?.querySelectorAll('input') ?? []) as NodeListOf<HTMLInputElement>;
                    inputs[i + 1]?.focus();
                  }
                }}
              />
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
        <div>
          <div className="text-xs text-muted">You counted</div>
          <div className="text-2xl font-semibold tabular">{formatKes(total)}</div>
        </div>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}
