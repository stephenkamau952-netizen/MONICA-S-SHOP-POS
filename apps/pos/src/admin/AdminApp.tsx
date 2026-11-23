import { useReady } from '../auth/AuthProvider.tsx';
import { navigate, usePath } from '../lib/router.ts';
import { Button } from '../ui/ui.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Shifts } from './Shifts.tsx';
import { Products } from './Products.tsx';
import { StockCounts } from './StockCounts.tsx';
import { Staff } from './Staff.tsx';
import { Settings } from './Settings.tsx';
import { AuditLog } from './AuditLog.tsx';

const TABS = [
  ['dashboard', 'Dashboard'], ['shifts', 'Shifts'], ['products', 'Products & stock'], ['counts', 'Stock counts'],
  ['staff', 'Staff'], ['settings', 'Settings'], ['audit', 'Audit log'],
] as const;
type Tab = (typeof TABS)[number][0];

export function AdminApp() {
  const { ctx, signOut } = useReady();
  const path = usePath();
  const tab = (TABS.find(([t]) => path === `/admin/${t}`)?.[0] ?? 'dashboard') as Tab;

  return (
    <div className="min-h-full">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <div className="text-sm"><span className="font-semibold">{ctx.storeName}</span> <span className="text-muted">· owner</span></div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => navigate('/till')}>Open till</Button>
            <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4" aria-label="Owner sections">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" onClick={() => navigate(`/admin/${t}`)} aria-current={t === tab ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${t === tab ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl p-4">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'shifts' && <Shifts />}
        {tab === 'products' && <Products />}
        {tab === 'counts' && <StockCounts />}
        {tab === 'staff' && <Staff />}
        {tab === 'settings' && <Settings />}
        {tab === 'audit' && <AuditLog />}
      </main>
    </div>
  );
}
