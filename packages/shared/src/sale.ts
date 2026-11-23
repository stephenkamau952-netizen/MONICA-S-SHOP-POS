// packages/shared/src/sale.ts — the checkout contract (PRD section 5.1).
import { z } from 'zod';

export const SaleLine = z
  .object({
    productId: z.uuid(),
    qty: z.number().int().positive().max(999),
    overrideApprovalId: z.uuid().optional(), // required for a cashier if the price differs
    overridePriceCents: z.number().int().nonnegative().max(100_000_000).optional(),
  })
  .refine((l) => l.overrideApprovalId === undefined || l.overridePriceCents !== undefined, {
    message: 'overridePriceCents is required with overrideApprovalId',
    path: ['overridePriceCents'],
  });

export const Payment = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), tenderedCents: z.number().int().positive().max(100_000_000) }),
  z.object({
    method: z.literal('MPESA'),
    amountCents: z.number().int().positive().max(100_000_000),
    mpesaCode: z.string().regex(/^[A-Z0-9]{10}$/),
  }),
  z.object({
    method: z.literal('CARD'),
    amountCents: z.number().int().positive().max(100_000_000),
    cardRef: z.string().trim().min(4).max(32),
  }),
]);

export const CompleteSaleInput = z.object({
  idempotencyKey: z.uuid(),
  shiftId: z.uuid(),
  lines: z.array(SaleLine).min(1).max(200),
  payments: z
    .array(Payment)
    .min(1)
    .max(4)
    .refine((ps) => ps.filter((p) => p.method === 'CASH').length <= 1, { message: 'only one cash payment per sale' }),
});
export type CompleteSaleInput = z.infer<typeof CompleteSaleInput>;
export type SaleLineInput = z.infer<typeof SaleLine>;
export type PaymentInput = z.infer<typeof Payment>;

export interface ReceiptLine {
  lineNo: number;
  saleLineId: string;
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  listPriceCents: number;
  lineTotalCents: number;
  overridden: boolean;
}

export interface ReceiptPayment {
  method: 'CASH' | 'MPESA' | 'CARD';
  amountCents: number;
  tenderedCents: number | null;
  changeCents: number | null;
  mpesaCode: string | null;
  cardRef: string | null;
}

/** What complete_sale / reprint_receipt return. */
export interface Receipt {
  saleId: string;
  receiptNo: number;
  receiptLabel: string;
  registerCode: string;
  storeName: string;
  cashierName: string;
  createdAt: string;
  itemCount: number;
  listTotalCents: number;
  totalCents: number;
  lines: ReceiptLine[];
  payments: ReceiptPayment[];
  changeDueCents: number;
  openDrawer: boolean;
  replayed?: boolean;
  reprint?: boolean;
}
