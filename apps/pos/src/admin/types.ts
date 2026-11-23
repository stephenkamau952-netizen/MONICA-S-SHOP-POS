export interface ShiftRow {
  shiftId: string;
  registerCode: string;
  cashier: string;
  status: 'OPEN' | 'PENDING_COUNT' | 'CLOSED_UNRECONCILED' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  forced: boolean;
  expectedCents: number;
  countedCents: number | null;
  varianceCents: number | null;
  netVarianceCents: number | null;
  flagged: boolean;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  recounts: number;
  unackedAlerts: number;
}

export interface AlertRow {
  id: string;
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  subject: string;
  shiftId: string | null;
  userName: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  ackNote: string | null;
  acknowledgedBy: string | null;
}

export interface ExceptionCounts {
  voids: number; voidCents?: number; refunds: number; refundCents?: number; overrides: number; overrideCents?: number;
  lineRemovals: number; cartCancels: number; noSales: number;
}

export interface DashboardData {
  range: { from: string; to: string; timezone: string; days: number };
  generatedAt: string;
  grossSalesCents: number;
  salesCount: number;
  avgBasketCents: number | null;
  voidsCents: number;
  refundsCents: number;
  netSalesCents: number;
  cogsCents: number;
  grossProfitCents: number;
  grossMarginBps: number | null;
  paymentMix: { method: 'CASH' | 'MPESA' | 'CARD'; amountCents: number }[];
  drawers: { shiftId: string; registerCode: string; cashier: string; status: string; openedAt: string; expectedCents: number }[];
  shifts: ShiftRow[];
  exceptions: { userId: string; name: string; current: ExceptionCounts; baselinePerDay: ExceptionCounts }[];
  lowStock: { productId: string; name: string; sku: string; onHand: number; reorderLevel: number; avgDailyUnits: number; daysOfCover: number | null }[];
  recentSales: { saleId: string; receiptLabel: string; totalCents: number; cashier: string; at: string; methods: string[] }[];
  alerts: { unacknowledged: { HIGH: number; MEDIUM: number; LOW: number }; items: AlertRow[] };
  pendingApprovals: { requestId: string; action: string; summary: string; cashier: string; registerCode: string; createdAt: string; expiresAt: string }[];
}

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'mtd';
export const RANGES: [RangeKey, string][] = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['mtd', 'Month to date'],
];

/** Range bounds in East Africa Time (UTC+3, no daylight saving). */
export function rangeBounds(key: RangeKey): { from: string; to: string } {
  const H = 3600_000;
  const eat = new Date(Date.now() + 3 * H);
  const midnight = Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()) - 3 * H;
  const day = 24 * H;
  const iso = (t: number) => new Date(t).toISOString();
  switch (key) {
    case 'today': return { from: iso(midnight), to: iso(midnight + day) };
    case 'yesterday': return { from: iso(midnight - day), to: iso(midnight) };
    case '7d': return { from: iso(midnight - 6 * day), to: iso(midnight + day) };
    case '30d': return { from: iso(midnight - 29 * day), to: iso(midnight + day) };
    case 'mtd': return { from: iso(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), 1) - 3 * H), to: iso(midnight + day) };
  }
}
