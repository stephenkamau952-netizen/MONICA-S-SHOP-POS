import { useEffect, useRef, useState } from 'react';
import { formatKes, parseKesToCents, type PaymentInput } from '@shop/shared';
import { errorText } from '../lib/api.ts';
import { Banner, Button, Field, Input, Kbd, Modal } from '../ui/ui.tsx';

export type PayMethod = 'CASH' | 'MPESA' | 'CARD';
const LABEL: Record<PayMethod, string> = { CASH: 'Cash', MPESA: 'M-Pesa', CARD: 'Card' };
const plain = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/**
 * Split tender: add M-Pesa / card amounts first; cash (if any) always settles
 * the rest and computes change. Enter confirms; F2/F3/F4 switch method.
 */
export function PaymentPanel({ total, initialMethod, onSubmit, onCancel }: {
  total: number;
  initialMethod: PayMethod;
  onSubmit: (payments: PaymentInput[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [nonCash, setNonCash] = useState<PaymentInput[]>([]);
  const [method, setMethod] = useState<PayMethod>(initialMethod);
  const [amount, setAmount] = useState(plain(total));
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);

  const paid = nonCash.reduce((s, p) => s + ('amountCents' in p ? p.amountCents : 0), 0);
  const remaining = total - paid;
  const amountCents = parseKesToCents(amount);
  const change = method === 'CASH' && amountCents !== null ? amountCents - remaining : null;

  useEffect(() => {
    setAmount(plain(remaining));
    setRef('');
    setError(null);
    setTimeout(() => amountRef.current?.select(), 0);
  }, [method, remaining]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = ({ F2: 'CASH', F3: 'MPESA', F4: 'CARD' } as const)[e.key as 'F2' | 'F3' | 'F4'];
      if (m && !busy) {
        e.preventDefault();
        e.stopPropagation();
        setMethod(m);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy]);

  const submit = async (payments: PaymentInput[]) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(payments);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy) return;
    // Pressing Enter again after a failure is a safe retry: the parent reuses
    // the same sale key, so the server can never record the sale twice.
    if (amountCents === null || amountCents <= 0) return setError('Type an amount in shillings, e.g. 1250 or 1250.50.');
    if (method === 'CASH') {
      if (amountCents < remaining) return setError(`Cash tendered is less than ${formatKes(remaining)}. Add M-Pesa or card first for a split.`);
      return submit([...nonCash, { method: 'CASH', tenderedCents: amountCents }]);
    }
    if (amountCents > remaining) return setError(`That is more than the ${formatKes(remaining)} left to pay.`);
    let p: PaymentInput;
    if (method === 'MPESA') {
      const code = ref.trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(code)) return setError('Enter the 10-character M-Pesa transaction code from the customer’s message.');
      if (nonCash.some((x) => x.method === 'MPESA' && x.mpesaCode === code)) return setError('That M-Pesa code is already on this sale.');
      p = { method: 'MPESA', amountCents, mpesaCode: code };
    } else {
      const r = ref.trim();
      if (r.length < 4 || r.length > 32) return setError('Enter the card terminal reference (4–32 characters).');
      p = { method: 'CARD', amountCents, cardRef: r };
    }
    const next = [...nonCash, p];
    if (amountCents === remaining) return submit(next);
    if (next.length >= 4) return setError('At most 4 payments per sale.');
    setNonCash(next);
  };

  return (
    <Modal title={`Pay ${formatKes(total)}`} onClose={onCancel} locked={busy}>
      <div className="mb-3 flex gap-2" role="tablist">
        {(['CASH', 'MPESA', 'CARD'] as const).map((m, i) => (
          <Button key={m} variant={m === method ? 'primary' : 'secondary'} onClick={() => setMethod(m)} aria-pressed={m === method}>
            <Kbd>F{i + 2}</Kbd> {LABEL[m]}
          </Button>
        ))}
      </div>
      {nonCash.length > 0 && (
        <ul className="mb-3 text-sm">
          {nonCash.map((p, i) => (
            <li key={i} className="flex justify-between border-b border-line py-1">
              <span>{LABEL[p.method]} {'mpesaCode' in p ? p.mpesaCode : 'cardRef' in p ? p.cardRef : ''}</span>
              <span className="tabular">{formatKes('amountCents' in p ? p.amountCents : 0)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mb-3 flex justify-between text-sm"><span className="text-muted">Left to pay</span><span className="font-semibold tabular">{formatKes(remaining)}</span></div>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <Field label={method === 'CASH' ? 'Cash tendered (KES)' : `${LABEL[method]} amount (KES)`}>
          <Input ref={amountRef} inputMode="decimal" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} className="text-lg tabular"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && method !== 'CASH' && ref.trim() === '') {
                e.preventDefault();
                refRef.current?.focus();
              }
            }} />
        </Field>
        {method !== 'CASH' && (
          <Field label={method === 'MPESA' ? 'M-Pesa transaction code' : 'Card terminal reference'}>
            <Input ref={refRef} value={ref} onChange={(e) => setRef(method === 'MPESA' ? e.target.value.toUpperCase() : e.target.value)}
              maxLength={method === 'MPESA' ? 10 : 32} autoComplete="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm(); } }} />
          </Field>
        )}
        {method === 'CASH' && change !== null && change >= 0 && (
          <div className="rounded-md bg-surface-2 p-3 text-center">
            <div className="text-xs text-muted">Change to give</div>
            <div className="text-3xl font-bold tabular">{formatKes(change)}</div>
          </div>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>Back (Esc)</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : error ? 'Try again (Enter)' : method === 'CASH' || amountCents === remaining ? 'Complete sale (Enter)' : 'Add payment (Enter)'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
