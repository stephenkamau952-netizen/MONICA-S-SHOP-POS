// FR-VR-2 / FR-VR-6 approvals, FR-CO-3 overrides, PIN lockout.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, openShift, sell, approveAtTill, uuid, type Db, type Fixture } from './db.ts';

describe('owner approvals', () => {
  let db: Db;
  let f: Fixture;
  let shift: string;
  let bobShift: string;
  const override = (productId: string, priceCents: number) =>
    ({ shiftId: shift, action: 'PRICE_OVERRIDE', productId, priceCents, reasonCode: 'PRICE_ERROR' });

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    shift = await openShift(db, f.alice, f.t1);
    bobShift = await openShift(db, f.bob, f.t2);
  });

  it('approves a price override with the owner PIN, single use, bound to product and price', async () => {
    const approvalId = await approveAtTill(db, f.alice, override(f.products.soda, 7000), f.ownerPin);
    const sale = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 2, overridePriceCents: 7000, overrideApprovalId: approvalId }],
      [{ method: 'CASH', tenderedCents: 14000 }]);
    expect(sale.totalCents).toBe(14000);
    expect(sale.listTotalCents).toBe(16000);
    expect(sale.lines[0]).toMatchObject({ unitPriceCents: 7000, listPriceCents: 8000, overridden: true });
    const [line] = await sql(db, `select override_approved_by, approval_id from public.sale_lines where sale_id = $1`, [sale.saleId]);
    expect(line).toEqual({ override_approved_by: f.owner.id, approval_id: approvalId });
    const alerts = await sql(db, `select type from public.alerts where ref_id = $1`, [sale.saleId]);
    expect(alerts).toEqual([{ type: 'PRICE_OVERRIDE' }]);

    // Reuse -> used
    await expect(sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 1, overridePriceCents: 7000, overrideApprovalId: approvalId }],
      [{ method: 'CASH', tenderedCents: 7000 }])).rejects.toThrow('APPROVAL_USED');
  });

  it('rejects a token used on another product, at another price, or by another cashier', async () => {
    const a1 = await approveAtTill(db, f.alice, override(f.products.soda, 7500), f.ownerPin);
    await expect(sell(db, f.alice, shift,
      [{ productId: f.products.bread, qty: 1, overridePriceCents: 7500, overrideApprovalId: a1 }],
      [{ method: 'CASH', tenderedCents: 7500 }])).rejects.toThrow('APPROVAL_INVALID');
    await expect(sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 1, overridePriceCents: 100, overrideApprovalId: a1 }],
      [{ method: 'CASH', tenderedCents: 100 }])).rejects.toThrow('APPROVAL_MISMATCH');
    await expect(sell(db, f.bob, bobShift,
      [{ productId: f.products.soda, qty: 1, overridePriceCents: 7500, overrideApprovalId: a1 }],
      [{ method: 'CASH', tenderedCents: 7500 }])).rejects.toThrow('APPROVAL_INVALID');
    // Failed attempts do not burn the token.
    const ok = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 1, overridePriceCents: 7500, overrideApprovalId: a1 }],
      [{ method: 'CASH', tenderedCents: 7500 }]);
    expect(ok.totalCents).toBe(7500);
  });

  it('rejects an expired token', async () => {
    const req = await rpc(db, f.alice, 'request_approval', override(f.products.milk, 5000));
    // Mint an already-expired token directly (the only way to make time pass in a test).
    const [ap] = await sql(db, `insert into public.approvals (store_id, request_id, action, target_id, payload, requested_by,
                                   approved_by, channel, expires_at)
                                select store_id, id, action, target_id, payload, requested_by, $2, 'TILL_PIN', now() - interval '1 second'
                                  from public.approval_requests where id = $1 returning id`, [req.requestId, f.owner.id]);
    await expect(sell(db, f.alice, shift,
      [{ productId: f.products.milk, qty: 1, overridePriceCents: 5000, overrideApprovalId: ap.id }],
      [{ method: 'CASH', tenderedCents: 5000 }])).rejects.toThrow('APPROVAL_EXPIRED');
    expect(await rpc(db, f.alice, 'my_approval', { requestId: req.requestId })).toEqual({ status: 'EXPIRED' });
  });

  it('records which owner approved when two owners have PINs', async () => {
    const id = await approveAtTill(db, f.alice, override(f.products.bread, 6000), f.owner2Pin);
    const [row] = await sql(db, `select approved_by, channel from public.approvals where id = $1`, [id]);
    expect(row).toEqual({ approved_by: f.owner2.id, channel: 'TILL_PIN' });
  });

  it('does not accept a cashier PIN as an owner PIN', async () => {
    const req = await rpc(db, f.alice, 'request_approval', override(f.products.bread, 5500));
    expect(await rpc(db, f.alice, 'approve_with_pin', { requestId: req.requestId, pin: f.alicePin }))
      .toEqual({ ok: false, error: 'BAD_PIN', attemptsLeft: 4 });
  });

  it('locks owner-PIN approvals on a register after 5 wrong PINs and raises PIN_LOCKOUT', async () => {
    const req = await rpc(db, f.alice, 'request_approval', override(f.products.soda, 6000));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rpc(db, f.alice, 'approve_with_pin', { requestId: req.requestId, pin: '000001' }));
    // One failure already happened on this register in the previous test.
    expect(results.map((r) => r.attemptsLeft ?? r.error)).toEqual([3, 2, 1, 'PIN_LOCKED']);
    const correct = await rpc(db, f.alice, 'approve_with_pin', { requestId: req.requestId, pin: f.ownerPin });
    expect(correct.error).toBe('PIN_LOCKED');
    const alerts = await sql(db, `select severity, ref_id from public.alerts where type = 'PIN_LOCKOUT'`);
    expect(alerts).toEqual([{ severity: 'HIGH', ref_id: f.t1 }]);
    const attempts = await sql(db, `select count(*)::int as n from public.pin_attempts where register_id = $1 and not success`, [f.t1]);
    expect(attempts[0].n).toBe(5);
    // Other registers are not affected.
    const other = await approveAtTill(db, f.bob, { ...override(f.products.soda, 6000), shiftId: bobShift }, f.ownerPin);
    expect(other).toBeTruthy();
  });

  it('approves from the dashboard only with an MFA owner session, never by the requester', async () => {
    const req = await rpc(db, f.bob, 'request_approval', { shiftId: bobShift, action: 'NO_SALE', reasonCode: 'CHANGE_GIVEN' });
    expect(await rpc(db, f.bob, 'my_approval', { requestId: req.requestId })).toMatchObject({ status: 'PENDING' });
    await expect(rpc(db, f.ownerNoMfa, 'approve_request', { requestId: req.requestId })).rejects.toThrow('MFA_REQUIRED');
    await expect(rpc(db, f.alice, 'approve_request', { requestId: req.requestId })).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'my_approval', { requestId: req.requestId })).rejects.toThrow('NOT_FOUND');
    const dash = await rpc(db, f.owner, 'owner_dashboard_today', {});
    expect(dash.pendingApprovals.map((r: any) => r.requestId)).toContain(req.requestId);

    const ap = await rpc(db, f.owner, 'approve_request', { requestId: req.requestId });
    const status = await rpc(db, f.bob, 'my_approval', { requestId: req.requestId });
    expect(status).toMatchObject({ status: 'APPROVED', approvalId: ap.approvalId, approvedBy: 'Monica' });
    await expect(rpc(db, f.owner, 'approve_request', { requestId: req.requestId })).rejects.toThrow('APPROVAL_ALREADY_DECIDED');

    const mv = await rpc(db, f.bob, 'record_cash_movement', {
      shiftId: bobShift, kind: 'NO_SALE', reasonCode: 'CHANGE_GIVEN', approvalId: ap.approvalId,
    });
    expect(mv).toMatchObject({ kind: 'NO_SALE', openDrawer: true });
    expect(await rpc(db, f.bob, 'my_approval', { requestId: req.requestId })).toEqual({ status: 'USED' });
    const alerts = await sql(db, `select type from public.alerts where ref_id = $1`, [mv.movementId]);
    expect(alerts).toEqual([{ type: 'NO_SALE_OPEN' }]);
  });

  it('lets the owner reject a request', async () => {
    const req = await rpc(db, f.bob, 'request_approval', { shiftId: bobShift, action: 'PAID_OUT', amountCents: 50000, reasonCode: 'SUPPLIER_PAYMENT' });
    await rpc(db, f.owner, 'reject_request', { requestId: req.requestId, note: 'pay by M-Pesa' });
    expect(await rpc(db, f.bob, 'my_approval', { requestId: req.requestId })).toEqual({ status: 'REJECTED', note: 'pay by M-Pesa' });
    await expect(rpc(db, f.bob, 'approve_with_pin', { requestId: req.requestId, pin: f.ownerPin })).rejects.toThrow('APPROVAL_ALREADY_DECIDED');
  });

  it('stops an owner approving their own request, but lets an MFA owner act directly', async () => {
    // Owner rings sales on their own shift.
    const t3 = await rpc(db, f.owner, 'owner_upsert_register', { code: 'T3', name: 'Till 3', floatCents: 0 });
    const ownerShift = await openShift(db, f.owner, t3.id, 0);
    const req = await rpc(db, f.owner, 'request_approval', { shiftId: ownerShift, action: 'PRICE_OVERRIDE', productId: f.products.milk, priceCents: 5000, reasonCode: 'DAMAGED' });
    await expect(rpc(db, f.owner, 'approve_with_pin', { requestId: req.requestId, pin: f.ownerPin })).rejects.toThrow('SELF_APPROVAL');
    await expect(rpc(db, f.owner, 'approve_request', { requestId: req.requestId })).rejects.toThrow('SELF_APPROVAL');
    const direct = await sell(db, f.owner, ownerShift, [{ productId: f.products.milk, qty: 1, overridePriceCents: 5000 }],
      [{ method: 'CASH', tenderedCents: 5000 }]);
    expect(direct.lines[0]).toMatchObject({ unitPriceCents: 5000, overridden: true });
    // Without MFA the owner is treated like anyone else.
    await expect(sell(db, f.ownerNoMfa, ownerShift, [{ productId: f.products.milk, qty: 1, overridePriceCents: 5000 }],
      [{ method: 'CASH', tenderedCents: 5000 }])).rejects.toThrow('APPROVAL_REQUIRED');
  });

  it('requires approval for paid-outs and no-sales, but not for drops and paid-ins', async () => {
    await expect(rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'PAID_OUT', amountCents: 1000, reasonCode: 'PETTY_EXPENSE' }))
      .rejects.toThrow('APPROVAL_REQUIRED');
    await expect(rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'NO_SALE', reasonCode: 'CHANGE_GIVEN' }))
      .rejects.toThrow('APPROVAL_REQUIRED');
    expect((await rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'DROP', amountCents: 100000, reasonCode: 'SAFE_DROP' })).kind).toBe('DROP');
    expect((await rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'PAID_IN', amountCents: 5000, reasonCode: 'FLOAT_TOP_UP' })).kind).toBe('PAID_IN');
    await expect(rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'DROP', amountCents: 100, reasonCode: 'OTHER' }))
      .rejects.toThrow('INVALID_INPUT');
    // A paid-out approval is bound to its amount.
    const ap = await approveAtTill(db, f.bob, { shiftId: bobShift, action: 'PAID_OUT', amountCents: 2000, reasonCode: 'PETTY_EXPENSE' }, f.ownerPin);
    await expect(rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'PAID_OUT', amountCents: 9000, reasonCode: 'PETTY_EXPENSE', approvalId: ap }))
      .rejects.toThrow('APPROVAL_MISMATCH');
    const ok = await rpc(db, f.bob, 'record_cash_movement', { shiftId: bobShift, kind: 'PAID_OUT', amountCents: 2000, reasonCode: 'PETTY_EXPENSE', approvalId: ap });
    const [row] = await sql(db, `select approved_by from public.cash_movements where id = $1`, [ok.movementId]);
    expect(row.approved_by).toBe(f.owner.id);
  });

  it('validates the PIN request shape without leaking which owner exists', async () => {
    const req = await rpc(db, f.bob, 'request_approval', { ...override(f.products.milk, 5800), shiftId: bobShift });
    expect(await rpc(db, f.bob, 'approve_with_pin', { requestId: req.requestId, pin: 'abc' })).toMatchObject({ ok: false, error: 'BAD_PIN' });
    expect(await rpc(db, f.bob, 'approve_with_pin', { requestId: req.requestId, pin: 123456 })).toMatchObject({ ok: false, error: 'BAD_PIN' });
    await expect(rpc(db, f.alice, 'approve_with_pin', { requestId: req.requestId, pin: f.ownerPin })).rejects.toThrow('NOT_FOUND');
    await expect(rpc(db, f.bob, 'approve_with_pin', { requestId: uuid(), pin: f.ownerPin })).rejects.toThrow('NOT_FOUND');
  });
});
