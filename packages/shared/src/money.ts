// Money is always integer cents (KES). Never use floating point for totals.

export const DENOMINATIONS = [
  { key: 'n1000', label: '1,000', valueCents: 100_000, kind: 'note' },
  { key: 'n500', label: '500', valueCents: 50_000, kind: 'note' },
  { key: 'n200', label: '200', valueCents: 20_000, kind: 'note' },
  { key: 'n100', label: '100', valueCents: 10_000, kind: 'note' },
  { key: 'n50', label: '50', valueCents: 5_000, kind: 'note' },
  { key: 'c20', label: '20', valueCents: 2_000, kind: 'coin' },
  { key: 'c10', label: '10', valueCents: 1_000, kind: 'coin' },
  { key: 'c5', label: '5', valueCents: 500, kind: 'coin' },
  { key: 'c1', label: '1', valueCents: 100, kind: 'coin' },
] as const;

export type DenominationKey = (typeof DENOMINATIONS)[number]['key'];
export type DenominationCounts = Record<DenominationKey, number>;

export function emptyCounts(): DenominationCounts {
  return { n1000: 0, n500: 0, n200: 0, n100: 0, n50: 0, c20: 0, c10: 0, c5: 0, c1: 0 };
}

export function denominationTotalCents(counts: DenominationCounts): number {
  let total = 0;
  for (const d of DENOMINATIONS) total += (counts[d.key] ?? 0) * d.valueCents;
  return total;
}

const kesFormatter = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 125000 -> "KES 1,250.00"; -500 -> "-KES 5.00" */
export function formatKes(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  return `${sign}KES ${kesFormatter.format(Math.abs(cents) / 100)}`;
}

/** Plain amount without the currency, for receipts and inputs: 125000 -> "1,250.00" */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return sign + kesFormatter.format(Math.abs(cents) / 100);
}

/**
 * Parse a typed shilling amount ("1250", "1,250", "1250.5", "1250.50") into
 * cents without floating-point maths. Returns null for anything else.
 */
export function parseKesToCents(input: string): number | null {
  const s = input.replace(/[\s,]/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return whole * 100 + frac;
}
