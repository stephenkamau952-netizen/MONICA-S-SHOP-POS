// Every write the POS and dashboard make goes through POST /api/<path>.
// The Worker parses the body with the schema, then calls the Postgres RPC
// with the user's own JWT. The database re-validates everything.
import { z } from 'zod';
import { CompleteSaleInput } from './sale.ts';
import { CASH_REASONS, REVERSAL_REASONS, STOCK_REASONS } from './reasons.ts';

const id = z.uuid();
const cents = z.number().int().min(0).max(100_000_000);
const positiveCents = z.number().int().min(1).max(100_000_000);
const note = z.string().trim().max(500).optional();
const count = z.number().int().min(0).max(100_000);

export const Denominations = z.object({
  n1000: count, n500: count, n200: count, n100: count, n50: count,
  c20: count, c10: count, c5: count, c1: count,
});

const reversalReason = z.enum(REVERSAL_REASONS);
const cashReason = z.enum(CASH_REASONS);
const refundMethod = z.enum(['CASH', 'MPESA', 'CARD']);
const reversalLines = z.array(z.object({ saleLineId: id, qty: z.number().int().min(1).max(999) })).min(1).max(200);
const pin = z.string().regex(/^\d{6}$/, 'a PIN is 6 digits');

function noteForOther<T extends { reasonCode: string; note?: string | undefined }>(v: T) {
  return v.reasonCode !== 'OTHER' || (v.note !== undefined && v.note.length > 0);
}
const otherNeedsNote = { message: 'a note is required when the reason is OTHER', path: ['note'] };

// ---- Till -------------------------------------------------------------------
export const OpenShiftInput = z.object({ registerId: id, denominations: Denominations });
export const CloseCountInput = z.object({ shiftId: id, denominations: Denominations });

export const CashMovementInput = z
  .object({
    shiftId: id,
    kind: z.enum(['DROP', 'PAID_IN', 'PAID_OUT', 'NO_SALE']),
    amountCents: positiveCents.optional(),
    reasonCode: cashReason,
    note,
    approvalId: id.optional(),
  })
  .refine((v) => (v.kind === 'NO_SALE' ? v.amountCents === undefined : v.amountCents !== undefined), {
    message: 'amountCents is required except for a no-sale',
    path: ['amountCents'],
  })
  .refine(noteForOther, otherNeedsNote);

export const CartEventInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['LINE_REMOVED', 'QTY_REDUCED']),
    shiftId: id, eventKey: id, cartKey: id, productId: id, qty: z.number().int().min(1).max(999),
  }),
  z.object({
    kind: z.literal('CART_CANCELLED'),
    shiftId: id, eventKey: id, cartKey: id,
    lines: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(999) })).max(200),
  }),
]);

export const ReprintInput = z.object({ saleId: id });

export const ApprovalRequestInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('PRICE_OVERRIDE'), shiftId: id, productId: id, priceCents: cents, reasonCode: reversalReason, note })
    .refine(noteForOther, otherNeedsNote),
  z.object({ action: z.literal('VOID'), shiftId: id, saleId: id, refundMethod, reasonCode: reversalReason, note })
    .refine(noteForOther, otherNeedsNote),
  z.object({ action: z.literal('REFUND'), shiftId: id, saleId: id, lines: reversalLines, refundMethod, reasonCode: reversalReason, note })
    .refine(noteForOther, otherNeedsNote),
  z.object({ action: z.literal('NO_SALE'), shiftId: id, reasonCode: cashReason, note })
    .refine(noteForOther, otherNeedsNote),
  z.object({ action: z.literal('PAID_OUT'), shiftId: id, amountCents: positiveCents, reasonCode: cashReason, note })
    .refine(noteForOther, otherNeedsNote),
]);

export const ApprovePinInput = z.object({ requestId: id, pin });
export const UnlockInput = z.object({ pin });

export const ReverseSaleInput = z
  .object({
    shiftId: id,
    saleId: id,
    kind: z.enum(['VOID', 'REFUND']),
    lines: reversalLines.optional(),
    refundMethod,
    refundRef: z.string().trim().min(4).max(32).optional(),
    reasonCode: reversalReason,
    note,
    approvalId: id.optional(),
  })
  .refine((v) => v.kind === 'VOID' || v.lines !== undefined, { message: 'a refund needs lines', path: ['lines'] })
  .refine((v) => (v.refundMethod === 'CASH') === (v.refundRef === undefined), {
    message: 'refundRef is required for M-Pesa and card refunds only',
    path: ['refundRef'],
  })
  .refine(noteForOther, otherNeedsNote);

export const CountLineInput = z.object({ countId: id, productId: id, countedQty: z.number().int().min(0).max(1_000_000) });

// ---- Owner ------------------------------------------------------------------
export const DecideRequestInput = z.object({ requestId: id, note });
export const ShiftNoteInput = z.object({ shiftId: id, note: z.string().trim().min(3).max(500) });
export const ForceCloseInput = z.object({ shiftId: id, reason: z.string().trim().min(3).max(500) });
export const RecountInput = z.object({ shiftId: id, denominations: Denominations });
export const CashAdjustmentInput = z.object({
  shiftId: id,
  amountCents: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, 'cannot be zero'),
  reasonCode: cashReason,
  note: z.string().trim().min(3).max(500),
});
export const AckAlertInput = z.object({ alertId: id, note });
export const ProductInput = z.object({
  id: id.optional(),
  sku: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/),
  barcode: z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/).optional(),
  name: z.string().trim().min(1).max(120),
  priceCents: cents,
  reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});
export const ReceiveStockInput = z.object({
  productId: id,
  qty: z.number().int().min(1).max(1_000_000),
  unitCostCents: cents,
  supplier: z.string().trim().min(1).max(120),
  note,
});
export const AdjustStockInput = z
  .object({
    productId: id,
    qtyDelta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'cannot be zero'),
    reasonCode: z.enum(STOCK_REASONS),
    note,
  })
  .refine(noteForOther, otherNeedsNote);
export const OpenStockCountInput = z
  .object({
    productIds: z.array(id).min(1).max(5000).optional(),
    allProducts: z.boolean().optional(),
    assignedTo: id.optional(),
    note,
  })
  .refine((v) => v.allProducts === true || v.productIds !== undefined, { message: 'choose products or allProducts' });
export const CountIdInput = z.object({ countId: id });
export const SettingsInput = z.object({
  varianceThresholdCents: cents.optional(),
  staleShiftHours: z.number().int().min(1).max(72).optional(),
  allowNegativeStock: z.boolean().optional(),
  refundWindowDays: z.number().int().min(0).max(365).optional(),
  voidCountThreshold: z.number().int().min(0).max(1000).optional(),
  voidRateBps: z.number().int().min(0).max(10_000).optional(),
  overrideBatchThreshold: z.number().int().min(0).max(1000).optional(),
  cartLineRemovalThreshold: z.number().int().min(0).max(1000).optional(),
  cartCancelThreshold: z.number().int().min(0).max(1000).optional(),
  tillIdleLockSeconds: z.number().int().min(30).max(3600).optional(),
  approvalTtlSeconds: z.number().int().min(30).max(600).optional(),
});
export const RegisterInput = z.object({
  id: id.optional(),
  code: z.string().trim().regex(/^[A-Za-z0-9]{1,6}$/).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  floatCents: cents.optional(),
  active: z.boolean().optional(),
}).refine((v) => v.id !== undefined || (v.code !== undefined && v.name !== undefined), {
  message: 'a new register needs a code and a name',
});
export const AssignStaffInput = z.object({
  userId: id,
  role: z.enum(['OWNER', 'CASHIER']),
  displayName: z.string().trim().min(1).max(60),
});
export const UpdateStaffInput = z.object({
  userId: id,
  role: z.enum(['OWNER', 'CASHIER']).optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
});
export const SetPinInput = z.object({ userId: id, pin });

export type RouteLimiter = 'API' | 'PIN';

export interface RouteDef {
  /** Postgres function called via PostgREST with { p: <parsed body> } */
  rpc: string;
  schema: z.ZodType;
  limiter: RouteLimiter;
}

/** POST /api/<key> */
export const ROUTES = {
  'shifts/open': { rpc: 'open_shift', schema: OpenShiftInput, limiter: 'API' },
  'shifts/close-count': { rpc: 'commit_close_count', schema: CloseCountInput, limiter: 'API' },
  'cash-movements': { rpc: 'record_cash_movement', schema: CashMovementInput, limiter: 'API' },
  'cart-events': { rpc: 'log_cart_event', schema: CartEventInput, limiter: 'API' },
  'sales': { rpc: 'complete_sale', schema: CompleteSaleInput, limiter: 'API' },
  'sales/reprint': { rpc: 'reprint_receipt', schema: ReprintInput, limiter: 'API' },
  'approvals/request': { rpc: 'request_approval', schema: ApprovalRequestInput, limiter: 'API' },
  'approvals/pin': { rpc: 'approve_with_pin', schema: ApprovePinInput, limiter: 'PIN' },
  'approvals/approve': { rpc: 'approve_request', schema: DecideRequestInput, limiter: 'API' },
  'approvals/reject': { rpc: 'reject_request', schema: DecideRequestInput, limiter: 'API' },
  'reversals': { rpc: 'reverse_sale', schema: ReverseSaleInput, limiter: 'API' },
  'till/unlock': { rpc: 'verify_my_pin', schema: UnlockInput, limiter: 'PIN' },
  'stock-counts/line': { rpc: 'record_count_line', schema: CountLineInput, limiter: 'API' },

  'owner/shifts/acknowledge': { rpc: 'owner_acknowledge_shift', schema: ShiftNoteInput, limiter: 'API' },
  'owner/shifts/force-close': { rpc: 'owner_force_close_shift', schema: ForceCloseInput, limiter: 'API' },
  'owner/shifts/recount': { rpc: 'owner_recount_shift', schema: RecountInput, limiter: 'API' },
  'owner/shifts/cash-adjustment': { rpc: 'owner_cash_adjustment', schema: CashAdjustmentInput, limiter: 'API' },
  'owner/alerts/acknowledge': { rpc: 'owner_acknowledge_alert', schema: AckAlertInput, limiter: 'API' },
  'owner/products/upsert': { rpc: 'owner_upsert_product', schema: ProductInput, limiter: 'API' },
  'owner/stock/receive': { rpc: 'receive_stock', schema: ReceiveStockInput, limiter: 'API' },
  'owner/stock/adjust': { rpc: 'adjust_stock', schema: AdjustStockInput, limiter: 'API' },
  'owner/stock-counts/open': { rpc: 'open_stock_count', schema: OpenStockCountInput, limiter: 'API' },
  'owner/stock-counts/post': { rpc: 'post_stock_count', schema: CountIdInput, limiter: 'API' },
  'owner/stock-counts/cancel': { rpc: 'cancel_stock_count', schema: CountIdInput, limiter: 'API' },
  'owner/settings': { rpc: 'owner_update_settings', schema: SettingsInput, limiter: 'API' },
  'owner/registers/upsert': { rpc: 'owner_upsert_register', schema: RegisterInput, limiter: 'API' },
  'owner/staff/assign': { rpc: 'owner_assign_staff', schema: AssignStaffInput, limiter: 'API' },
  'owner/staff/update': { rpc: 'owner_update_staff', schema: UpdateStaffInput, limiter: 'API' },
  'owner/staff/pin': { rpc: 'owner_set_pin', schema: SetPinInput, limiter: 'PIN' },
} as const satisfies Record<string, RouteDef>;

export type RoutePath = keyof typeof ROUTES;
export type RouteInput<P extends RoutePath> = z.input<(typeof ROUTES)[P]['schema']>;
