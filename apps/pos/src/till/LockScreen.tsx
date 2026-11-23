import { useState } from 'react';
import { useReady } from '../auth/AuthProvider.tsx';
import { ApiError, errorText, post } from '../lib/api.ts';
import { Banner, Button, Field, Input } from '../ui/ui.tsx';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { ctx, signOut } = useReady();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page p-4" role="dialog" aria-modal="true" aria-label="Till locked">
      <form
        className="flex w-full max-w-xs flex-col gap-3 rounded-lg border border-line bg-surface p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pin.length !== 6 || busy) return;
          setBusy(true);
          setError(null);
          try {
            await post('till/unlock', { pin });
            onUnlocked();
          } catch (err) {
            setPin('');
            if (err instanceof ApiError && err.code === 'BAD_PIN') setError(`Wrong PIN. ${String(err.data.attemptsLeft ?? '')} attempt(s) left.`);
            else setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-lg font-semibold">Till locked</h2>
        <p className="text-sm text-ink-2">{ctx.displayName}, enter your PIN to continue.</p>
        <Field label="PIN">
          <Input type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <Button variant="primary" type="submit" disabled={busy || pin.length !== 6}>Unlock</Button>
        <Button variant="ghost" onClick={() => void signOut()}>Sign out instead</Button>
      </form>
    </div>
  );
}
