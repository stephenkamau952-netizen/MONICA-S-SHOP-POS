import { useEffect, useRef, useState } from 'react';
import type { RouteInput } from '@shop/shared';
import { ApiError, errorText, post, read } from '../lib/api.ts';
import { Banner, Button, Field, Input, Modal } from '../ui/ui.tsx';

export interface Approved {
  approvalId: string;
  expiresAt: string;
}

/**
 * Asks for owner approval: the owner types their PIN on this till, or
 * approves the request from the dashboard (this modal polls for that).
 * The cashier never sees or handles anything but the outcome.
 */
export function ApprovalModal({ request, onApproved, onCancel }: {
  request: RouteInput<'approvals/request'>;
  onApproved: (a: Approved) => void;
  onCancel: () => void;
}) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>('Sending request…');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const sent = useRef(false);

  const finish = (a: Approved) => {
    if (done.current) return;
    done.current = true;
    onApproved(a);
  };

  useEffect(() => {
    if (sent.current) return; // StrictMode runs effects twice in development
    sent.current = true;
    post('approvals/request', request)
      .then((r: { requestId: string; summary: string }) => {
        setRequestId(r.requestId);
        setSummary(r.summary);
      })
      .catch((e) => {
        setSummary('');
        setError(errorText(e));
      });
  }, [request]);

  // Dashboard approvals arrive by polling the request status.
  useEffect(() => {
    if (!requestId) return;
    const t = setInterval(async () => {
      try {
        const s = await read<{ status: string; approvalId?: string; expiresAt?: string; note?: string }>('my_approval', { requestId });
        if (s.status === 'APPROVED' && s.approvalId && s.expiresAt) finish({ approvalId: s.approvalId, expiresAt: s.expiresAt });
        else if (s.status === 'REJECTED') setError(`The owner rejected this${s.note ? `: ${s.note}` : ''}.`);
        else if (s.status === 'EXPIRED') setError('This request expired. Close and ask again.');
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [requestId]);

  return (
    <Modal title="Owner approval needed" onClose={onCancel}>
      <p className="mb-3 rounded-md bg-surface-2 p-3 text-sm">{summary}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!requestId || busy || pin.length !== 6) return;
          setBusy(true);
          setError(null);
          try {
            const r = await post('approvals/pin', { requestId, pin });
            finish({ approvalId: r.approvalId, expiresAt: r.expiresAt });
          } catch (err) {
            setPin('');
            if (err instanceof ApiError && err.code === 'BAD_PIN') {
              setError(`Wrong PIN. ${String(err.data.attemptsLeft ?? '')} attempt(s) left before this till is locked.`);
            } else setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Owner PIN (owner types it)" hint="Or the owner can approve this from the dashboard.">
          <Input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="Owner PIN" />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!requestId || busy || pin.length !== 6}>Approve</Button>
        </div>
      </form>
    </Modal>
  );
}
