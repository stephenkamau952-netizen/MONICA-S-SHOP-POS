import { useCallback, useEffect, useRef, useState } from 'react';
import { useReady } from '../auth/AuthProvider.tsx';
import { navigate } from '../lib/router.ts';
import { Banner, Button } from '../ui/ui.tsx';
import { OpenShift } from './OpenShift.tsx';
import { SaleScreen } from './SaleScreen.tsx';
import { CloseShift } from './CloseShift.tsx';
import { LockScreen } from './LockScreen.tsx';
import { StockCountEntry } from './StockCountEntry.tsx';
import { PrinterSettings } from './PrinterSettings.tsx';

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function TillApp() {
  const { ctx, refresh, signOut } = useReady();
  const [locked, setLocked] = useState(false);
  const [closing, setClosing] = useState(false);
  const [counting, setCounting] = useState(false);
  const [printer, setPrinter] = useState(false);
  const online = useOnline();
  const last = useRef(Date.now());
  const idleMs = (ctx.idleLockSeconds ?? 120) * 1000;
  const shift = ctx.openShift ?? null;

  // Till lock: 2 minutes idle (owner-configurable) or Ctrl+L.
  useEffect(() => {
    const touch = () => { last.current = Date.now(); };
    const onKey = (e: KeyboardEvent) => {
      touch();
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        setLocked(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', touch, true);
    const timer = setInterval(() => {
      if (Date.now() - last.current > idleMs) setLocked(true);
    }, 5000);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', touch, true);
      clearInterval(timer);
    };
  }, [idleMs]);

  const unlock = useCallback(() => {
    last.current = Date.now();
    setLocked(false);
  }, []);

  const afterClose = useCallback(async () => {
    setClosing(false);
    await refresh();
  }, [refresh]);

  let body;
  if (counting) body = <StockCountEntry onDone={() => { setCounting(false); void refresh(); }} />;
  else if (!shift) body = <OpenShift onOpened={refresh} />;
  else if (shift.status === 'PENDING_COUNT' || closing) {
    body = <CloseShift shift={shift} forced={shift.status === 'PENDING_COUNT'} onCancel={shift.status === 'OPEN' ? () => setClosing(false) : undefined} onClosed={afterClose} />;
  } else {
    body = <SaleScreen shift={shift} disabled={locked || printer} onCloseShift={() => setClosing(true)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-semibold">{ctx.storeName}</span>
          {shift && <span className="rounded bg-surface-2 px-2 py-0.5">Till {shift.registerCode}</span>}
          <span className="text-ink-2">{ctx.displayName}</span>
          <span className="inline-flex items-center gap-1 text-xs" aria-live="polite">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: online ? 'var(--good)' : 'var(--critical)' }} />
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ctx.assignedStockCount && !counting && <Button onClick={() => setCounting(true)}>Stock count</Button>}
          <Button variant="ghost" onClick={() => setPrinter(true)}>Printer</Button>
          {ctx.role === 'OWNER' && <Button variant="ghost" onClick={() => navigate('/admin')}>Dashboard</Button>}
          <Button variant="ghost" onClick={() => setLocked(true)}>Lock (Ctrl+L)</Button>
          {!shift && <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>}
        </div>
      </header>
      {!online && (
        <div className="px-4 pt-2">
          <Banner tone="error">No connection. New sales are blocked until it is back; the current cart is kept and will be sent with the same sale key.</Banner>
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
      {locked && <LockScreen onUnlocked={unlock} />}
      {printer && <PrinterSettings onClose={() => setPrinter(false)} />}
    </div>
  );
}
