import { useState } from 'react';
import { formatKes, type DenominationCounts } from '@shop/shared';
import type { OpenShiftInfo } from '../auth/AuthProvider.tsx';
import { errorText, post } from '../lib/api.ts';
import { DenominationForm } from '../ui/DenominationForm.tsx';
import { Banner, Button, Card } from '../ui/ui.tsx';

interface CloseResult { status: string; countedCents: number; varianceCents: number; flagged: boolean; overThreshold: boolean }

/**
 * FR-SH-3/4 blind close: the cashier counts without ever seeing expected cash.
 * The count is committed once; only then is the cashier's own variance shown.
 */
export function CloseShift({ shift, forced, onCancel, onClosed }: {
  shift: OpenShiftInfo;
  forced: boolean;
  onCancel?: () => void;
  onClosed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [confirming, setConfirming] = useState<DenominationCounts | null>(null);

  if (result) {
    const v = result.varianceCents;
    return (
      <div className="mx-auto max-w-lg p-4">
        <Card title={`Shift closed on ${shift.registerCode}`}>
          <div className="flex flex-col gap-3">
            <div className="text-sm">You counted <strong className="tabular">{formatKes(result.countedCents)}</strong>.</div>
            {v === 0 ? (
              <Banner tone="good">The drawer balances exactly.</Banner>
            ) : (
              <Banner tone={result.overThreshold ? 'error' : 'warn'}>
                The drawer is {v > 0 ? 'over' : 'short'} by <strong className="tabular">{formatKes(Math.abs(v))}</strong>.
                {result.overThreshold ? ' The owner has been alerted and must review this shift.' : ' This is recorded on the shift.'}
              </Banner>
            )}
            <Button variant="primary" autoFocus onClick={() => void onClosed()}>Done</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-4">
      <Card title={`Close shift on ${shift.registerCode}${forced ? ' (closed by owner — count required)' : ''}`}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-2">
            Count everything in the drawer. You get <strong>one</strong> attempt: the count cannot be changed after you commit it.
          </p>
          {error && <Banner tone="error">{error}</Banner>}
          {confirming ? (
            <div className="flex flex-col gap-3">
              <Banner tone="warn">Commit this count? It cannot be edited afterwards.</Banner>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirming(null)} disabled={busy}>Recount</Button>
                <Button variant="primary" autoFocus disabled={busy} onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    setResult(await post('shifts/close-count', { shiftId: shift.id, denominations: confirming }));
                  } catch (e) {
                    setError(errorText(e));
                    setConfirming(null);
                  } finally {
                    setBusy(false);
                  }
                }}>Commit count</Button>
              </div>
            </div>
          ) : (
            <DenominationForm submitLabel="Review count" onSubmit={(c) => setConfirming(c)} />
          )}
          {onCancel && !confirming && <Button variant="ghost" onClick={onCancel}>Back to selling</Button>}
        </div>
      </Card>
    </div>
  );
}
