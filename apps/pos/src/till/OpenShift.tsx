import { useEffect, useState } from 'react';
import { sb } from '../lib/supabase.ts';
import { errorText, post } from '../lib/api.ts';
import { DenominationForm } from '../ui/DenominationForm.tsx';
import { Banner, Card, Field, Select, Spinner } from '../ui/ui.tsx';

interface Register { id: string; code: string; name: string }

export function OpenShift({ onOpened }: { onOpened: () => Promise<void> }) {
  const [registers, setRegisters] = useState<Register[] | null>(null);
  const [registerId, setRegisterId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb().from('registers').select('id,code,name').eq('active', true).order('code').then(({ data, error }) => {
      if (error) return setError(error.message);
      const list = (data ?? []) as Register[];
      setRegisters(list);
      let remembered = '';
      try { remembered = localStorage.getItem('pos.registerId') ?? ''; } catch { /* ignore */ }
      setRegisterId(list.find((r) => r.id === remembered)?.id ?? list[0]?.id ?? '');
    });
  }, []);

  if (!registers) return error ? <div className="p-4"><Banner tone="error">{error}</Banner></div> : <Spinner />;

  return (
    <div className="mx-auto max-w-2xl p-4">
      <Card title="Open a shift">
        <div className="flex flex-col gap-4">
          <Field label="Till">
            <Select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
              {registers.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
            </Select>
          </Field>
          <p className="text-sm text-ink-2">Count the opening float you were given, note by note and coin by coin. If it differs from the set float, the owner is alerted.</p>
          {error && <Banner tone="error">{error}</Banner>}
          <DenominationForm
            submitLabel="Open shift"
            busy={busy}
            onSubmit={async (denominations) => {
              if (!registerId) return setError('Choose a till.');
              setBusy(true);
              setError(null);
              try {
                await post('shifts/open', { registerId, denominations });
                try { localStorage.setItem('pos.registerId', registerId); } catch { /* ignore */ }
                await onOpened();
              } catch (e) {
                setError(errorText(e));
                setBusy(false);
              }
            }}
          />
        </div>
      </Card>
    </div>
  );
}
