// FR-VR-1..5 voids and refunds.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, openShift, sell, approveAtTill, type Db, type Fixture } from './db.ts';

describe('voids and refunds', () => {
  let db: Db;
  let f: Fixture;
  let shift: string;
  let bobShift: string;
  const onHand = async (productId: string) =>
    (await sql(db, `select on_hand from public.stock_levels where product_id = $1`, [productId]))[0].on_hand as number;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    shift = await openShift(db, f.alice, f.t1);
    bobShift = await openShift(db, f.bob, f.t2);
  });

  it('voids a whole sale on the same shift with approval, restocking everything', async () => {
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 3 }], [{ method: 'CASH', tenderedCents: 24000 }]);
    expect(await onHand(f.products.soda)).toBe(45);
    const req = { shiftId: shift, action: 'VOID', saleId: sale.saleId, refundMethod: 'CASH', reasonCode: 'WRONG_ITEM' };
    await expect(rpc(db, f.alice, 'reverse_sale', { ...req, kind: 'VOID' })).rejects.toThrow('APPROVAL_REQUIRED');
    const approvalId = await approveAtTill(db, f.alice, req, f.ownerPin);
    const res = await rpc(db, f.alice, 'reverse_sale', { ...req, kind: 'VOID', approvalId });
    expect(res).toMatchObject({ kind: 'VOID', amountCents: 24000, refundMethod: 'CASH', openDrawer: true, receiptLabel: sale.receiptLabel });
    expect(await onHand(f.products.soda)).toBe(48);
    const [rev] = await sql(db, `select approved_by, requested_by, reason_code from public.sale_reversals where id = $1`, [res.reversalId]);
    expect(rev).toEqual({ approved_by: f.owner.id, requested_by: f.alice.id, reason_code: 'WRONG_ITEM' });
    // The original sale is untouched.
    const [orig] = await sql(db, `select status, total_cents from public.sales where id = $1`, [sale.saleId]);
    expect(orig).toEqual({ status: 'COMPLETED', total_cents: 24000 });
    await expect(rpc(db, f.alice, 'request_approval', req)).rejects.toThrow('VOID_NOT_ALLOWED');
  });

  it('does not void a sale from another shift', async () => {
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.bread, qty: 1 }], [{ method: 'CASH', tenderedCents: 6500 }]);
    await expect(rpc(db, f.bob, 'request_approval', { shiftId: bobShift, action: 'VOID', saleId: sale.saleId, refundMethod: 'CASH', reasonCode: 'WRONG_ITEM' }))
      .rejects.toThrow('VOID_NOT_ALLOWED');
  });

  it('refunds part of a sale, never more than was sold, and only what was approved', async () => {
    const sale = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 2 }, { productId: f.products.milk, qty: 1 }], [{ method: 'CASH', tenderedCents: 22000 }]);
    const soda = sale.lines.find((l: any) => l.name === 'Soda 500ml').saleLineId;
    const refund = (qty: number) => ({ shiftId: shift, action: 'REFUND', saleId: sale.saleId, lines: [{ saleLineId: soda, qty }], refundMethod: 'CASH', reasonCode: 'CUSTOMER_RETURN' });

    // Approved for 1, executed for 2 -> mismatch.
    const a1 = await approveAtTill(db, f.alice, refund(1), f.ownerPin);
    await expect(rpc(db, f.alice, 'reverse_sale', { ...refund(2), kind: 'REFUND', approvalId: a1 })).rejects.toThrow('APPROVAL_MISMATCH');
    // Approved reason differs -> mismatch.
    await expect(rpc(db, f.alice, 'reverse_sale', { ...refund(1), reasonCode: 'WRONG_ITEM', kind: 'REFUND', approvalId: a1 })).rejects.toThrow('APPROVAL_MISMATCH');
    const r1 = await rpc(db, f.alice, 'reverse_sale', { ...refund(1), kind: 'REFUND', approvalId: a1 });
    expect(r1.amountCents).toBe(8000);

    await expect(rpc(db, f.alice, 'request_approval', refund(2))).rejects.toThrow('REFUND_EXCEEDS_SALE');
    const a2 = await approveAtTill(db, f.alice, refund(1), f.ownerPin);
    await rpc(db, f.alice, 'reverse_sale', { ...refund(1), kind: 'REFUND', approvalId: a2 });
    await expect(rpc(db, f.alice, 'request_approval', refund(1))).rejects.toThrow('REFUND_EXCEEDS_SALE');

    // A sale with a refund can no longer be voided.
    await expect(rpc(db, f.alice, 'request_approval', { shiftId: shift, action: 'VOID', saleId: sale.saleId, refundMethod: 'CASH', reasonCode: 'WRONG_ITEM' }))
      .rejects.toThrow('VOID_NOT_ALLOWED');
  });

  it('writes damaged returns off instead of putting them back on the shelf', async () => {
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.milk, qty: 2 }], [{ method: 'CASH', tenderedCents: 12000 }]);
    const stock = await onHand(f.products.milk);
    const line = sale.lines[0].saleLineId;
    const req = { shiftId: shift, action: 'REFUND', saleId: sale.saleId, lines: [{ saleLineId: line, qty: 1 }], refundMethod: 'CASH', reasonCode: 'DAMAGED' };
    const approvalId = await approveAtTill(db, f.alice, req, f.ownerPin);
    const res = await rpc(db, f.alice, 'reverse_sale', { ...req, kind: 'REFUND', approvalId });
    expect(await onHand(f.products.milk)).toBe(stock);
    const moves = await sql(db, `select type, qty_delta from public.stock_movements where ref_id in
      (select id from public.sale_reversal_lines where reversal_id = $1) order by qty_delta desc`, [res.reversalId]);
    expect(moves).toEqual([{ type: 'REFUND', qty_delta: 1 }, { type: 'DAMAGED', qty_delta: -1 }]);
    const [rl] = await sql(db, `select restocked from public.sale_reversal_lines where reversal_id = $1`, [res.reversalId]);
    expect(rl.restocked).toBe(false);
  });

  it('records M-Pesa refunds with a unique reversal code', async () => {
    const sale = await sell(db, f.bob, bobShift, [{ productId: f.products.bread, qty: 2 }], [{ method: 'MPESA', amountCents: 13000, mpesaCode: 'MPS1234567' }]);
    const line = sale.lines[0].saleLineId;
    const req = (qty: number) => ({ shiftId: bobShift, action: 'REFUND', saleId: sale.saleId, lines: [{ saleLineId: line, qty }], refundMethod: 'MPESA', reasonCode: 'CUSTOMER_RETURN' });
    const a = await approveAtTill(db, f.bob, req(1), f.ownerPin);
    await expect(rpc(db, f.bob, 'reverse_sale', { ...req(1), kind: 'REFUND', approvalId: a })).rejects.toThrow('INVALID_INPUT');
    const r = await rpc(db, f.bob, 'reverse_sale', { ...req(1), kind: 'REFUND', approvalId: a, refundRef: 'rev0000001' });
    expect(r).toMatchObject({ refundRef: 'REV0000001', openDrawer: false });
    const b = await approveAtTill(db, f.bob, req(1), f.ownerPin);
    await expect(rpc(db, f.bob, 'reverse_sale', { ...req(1), kind: 'REFUND', approvalId: b, refundRef: 'REV0000001' })).rejects.toThrow('MPESA_REF_USED');
  });

  it('raises HIGH_VOID_RATE once per shift', async () => {
    const alerts = await sql(db, `select count(*)::int as n from public.alerts where type = 'HIGH_VOID_RATE' and shift_id = $1`, [shift]);
    expect(alerts[0].n).toBe(1);
  });

  it('enforces the refund window', async () => {
    const sale = await sell(db, f.bob, bobShift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }]);
    await rpc(db, f.owner, 'owner_update_settings', { refundWindowDays: 0 });
    await expect(rpc(db, f.bob, 'request_approval', {
      shiftId: bobShift, action: 'REFUND', saleId: sale.saleId, lines: [{ saleLineId: sale.lines[0].saleLineId, qty: 1 }],
      refundMethod: 'CASH', reasonCode: 'CUSTOMER_RETURN',
    })).rejects.toThrow('REFUND_WINDOW_EXPIRED');
    await rpc(db, f.owner, 'owner_update_settings', { refundWindowDays: 7 });
  });

  it('looks up a receipt for a refund without exposing more than the receipt shows', async () => {
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.bread, qty: 2 }], [{ method: 'CASH', tenderedCents: 13000 }]);
    const found = await rpc(db, f.bob, 'lookup_sale_for_reversal', { shiftId: bobShift, receipt: sale.receiptLabel.toLowerCase() });
    expect(found).toMatchObject({ saleId: sale.saleId, totalCents: 13000, sameShift: false, canVoid: false, withinRefundWindow: true });
    expect(found.lines).toEqual([{ saleLineId: sale.lines[0].saleLineId, name: 'Bread 400g', qty: 2, unitPriceCents: 6500, lineTotalCents: 13000, reversedQty: 0 }]);
    await expect(rpc(db, f.bob, 'lookup_sale_for_reversal', { shiftId: bobShift, receipt: 'T9-000001' })).rejects.toThrow('NOT_FOUND');
    await expect(rpc(db, f.bob, 'lookup_sale_for_reversal', { shiftId: bobShift, receipt: 'garbage' })).rejects.toThrow('INVALID_INPUT');
  });

  it('lets an MFA owner refund directly, recording themselves as approver', async () => {
    const t3 = await rpc(db, f.owner, 'owner_upsert_register', { code: 'T3', name: 'Till 3', floatCents: 0 });
    const ownerShift = await openShift(db, f.owner, t3.id, 0);
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }]);
    const r = await rpc(db, f.owner, 'reverse_sale', {
      shiftId: ownerShift, saleId: sale.saleId, kind: 'REFUND', lines: [{ saleLineId: sale.lines[0].saleLineId, qty: 1 }],
      refundMethod: 'CASH', reasonCode: 'OTHER', note: 'goodwill',
    });
    const [row] = await sql(db, `select approved_by, approval_id from public.sale_reversals where id = $1`, [r.reversalId]);
    expect(row).toEqual({ approved_by: f.owner.id, approval_id: null });
    await expect(rpc(db, f.owner, 'reverse_sale', {
      shiftId: ownerShift, saleId: sale.saleId, kind: 'REFUND', lines: [{ saleLineId: sale.lines[0].saleLineId, qty: 1 }],
      refundMethod: 'CASH', reasonCode: 'OTHER',
    })).rejects.toThrow('INVALID_INPUT');
  });
});
