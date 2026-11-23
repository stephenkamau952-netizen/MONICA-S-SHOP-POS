import { useEffect, useRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'secondary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-accent-ink hover:bg-accent-hover border-transparent',
    secondary: 'bg-surface text-ink border-line hover:bg-surface-2',
    danger: 'bg-critical text-white border-transparent hover:opacity-90',
    ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-2',
  };
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium
        disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input(props: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`rounded-md border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted ${props.className ?? ''}`}
    />
  );
}

export function Select(props: ComponentProps<'select'>) {
  return (
    <select {...props} className={`rounded-md border border-line bg-surface px-3 py-2 text-ink ${props.className ?? ''}`} />
  );
}

export function Banner({ tone, children }: { tone: 'error' | 'warn' | 'info' | 'good'; children: ReactNode }) {
  const map = {
    error: { icon: '⛔', label: 'Error', cls: 'border-critical' },
    warn: { icon: '⚠️', label: 'Warning', cls: 'border-warn' },
    info: { icon: 'ℹ️', label: 'Info', cls: 'border-accent' },
    good: { icon: '✅', label: 'Done', cls: 'border-good' },
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-md border-l-4 bg-surface px-3 py-2 text-sm ${map.cls}`}>
      <span aria-hidden>{map.icon}</span>
      <span>
        <span className="sr-only">{map.label}: </span>
        {children}
      </span>
    </div>
  );
}

/** Modal dialog. Esc closes it unless `locked`. Focus starts inside. */
export function Modal({ title, onClose, children, wide, locked }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; locked?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    // Respect a child's autoFocus; otherwise focus the first field.
    if (el && !el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>('input, select, textarea, button:not([aria-label="Close"])')?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, locked]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={ref} className={`max-h-[90vh] w-full overflow-auto rounded-lg border border-line bg-surface p-5 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          {!locked && <Button variant="ghost" onClick={onClose} aria-label="Close">Esc ✕</Button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{children}</kbd>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="p-6 text-center text-muted" role="status">{label}…</div>;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-ink-2">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const SEVERITY = {
  HIGH: { icon: '⛔', label: 'High', color: 'var(--critical)' },
  MEDIUM: { icon: '⚠️', label: 'Medium', color: 'var(--serious)' },
  LOW: { icon: 'ℹ️', label: 'Low', color: 'var(--warn)' },
} as const;

export function SeverityBadge({ severity }: { severity: keyof typeof SEVERITY }) {
  const s = SEVERITY[severity];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs font-medium">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function time(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'short' });
}
