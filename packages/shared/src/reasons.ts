// Mirrors public._reversal_reasons(), _cash_reasons() and _stock_reasons() in
// supabase/migrations/20261120000200_helpers_and_guards.sql.

export const REVERSAL_REASONS = [
  'CUSTOMER_RETURN',
  'WRONG_ITEM',
  'DAMAGED',
  'PRICE_ERROR',
  'DUPLICATE_SCAN',
  'OTHER',
] as const;
export type ReversalReason = (typeof REVERSAL_REASONS)[number];

export const CASH_REASONS = [
  'SAFE_DROP',
  'SUPPLIER_PAYMENT',
  'PETTY_EXPENSE',
  'CHANGE_GIVEN',
  'FLOAT_TOP_UP',
  'OWNER_WITHDRAWAL',
  'CORRECTION',
  'OTHER',
] as const;
export type CashReason = (typeof CASH_REASONS)[number];

export const STOCK_REASONS = ['FOUND', 'LOST', 'THEFT', 'EXPIRED', 'DAMAGED', 'CORRECTION', 'OTHER'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const REASON_LABELS: Record<string, string> = {
  CUSTOMER_RETURN: 'Customer return',
  WRONG_ITEM: 'Wrong item',
  DAMAGED: 'Damaged',
  PRICE_ERROR: 'Price error',
  DUPLICATE_SCAN: 'Duplicate scan',
  OTHER: 'Other (note required)',
  SAFE_DROP: 'Drop to safe',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PETTY_EXPENSE: 'Petty expense',
  CHANGE_GIVEN: 'Give change',
  FLOAT_TOP_UP: 'Float top-up',
  OWNER_WITHDRAWAL: 'Owner withdrawal',
  CORRECTION: 'Correction',
  FOUND: 'Found',
  LOST: 'Lost',
  THEFT: 'Theft',
  EXPIRED: 'Expired',
};

export const ALERT_LABELS: Record<string, string> = {
  CASH_VARIANCE: 'Cash variance',
  HIGH_VOID_RATE: 'High void/refund rate',
  PRICE_OVERRIDE: 'Price override',
  CART_DELETIONS: 'Cart deletions',
  NO_SALE_OPEN: 'No-sale drawer open',
  OPENING_VARIANCE: 'Opening float variance',
  STALE_SHIFT: 'Shift left open',
  NEGATIVE_STOCK: 'Negative stock',
  LOW_STOCK: 'Low stock',
  PIN_LOCKOUT: 'PIN lockout',
  INTEGRITY_STOCK: 'Stock integrity',
  INTEGRITY_AUDIT: 'Audit chain integrity',
  INTEGRITY_SHIFT: 'Shift integrity',
};
