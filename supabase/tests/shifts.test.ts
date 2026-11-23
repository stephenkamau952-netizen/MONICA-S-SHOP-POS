// FR-SH-1..7 shifts, blind close and variance.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, sqlAs, openShift, sell, approveAtTill, denoms, type Db, type Fixture } from './db.ts';

describe('shifts and blind counts', () => {
  let db: Db;
  let f: Fixture;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
  });

  it('computes expected cash = float + cash sales - cash refunds - drops - paid-outs + paid-ins', async () => {
    const shift = await openShift(db, f.alice, f.t1, 5000); // 500,000 cents
    // Cash sale 22,500 tendered 30,000 (change 7,500 does not count)
    const s1 = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 2 }, { productId: f.products.bread, qty: 1 }], [{ method: 'CASH', tenderedCents: 30000 }]);
    // M-Pesa sale: no effect on drawer
    await sell(db, f.alice, shift, [{ productId: f.products.milk, qty: 1 }], [{ method: 'MPESA', amountCents: 6000, mpesaCode: 'SHF1234567' }]);
    // Split: 10,000 card + 6,000 cash
    await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 2 }], [
      { method: 'CARD', amountCents: 10000, cardRef: 'TRM-1' }, { method: 'CASH', tenderedCents: 10000 },
    ]);
    await rpc(db, f.alice, 'record_cash_movement', { shiftId: shift, kind: 'DROP', amountCents: 10000, reasonCode: 'SAFE_DROP' });
    await rpc(db, f.alice, 'record_cash_movement', { shiftId: shift, kind: 'PAID_IN', amountCents: 5000, reasonCode: 'FLOAT_TOP_UP' });
    const po = await approveAtTill(db, f.alice, { shiftId: shift, action: 'PAID_OUT', amountCents: 3000, reasonCode: 'PETTY_EXPENSE' }, f.ownerPin);
    await rpc(db, f.alice, 'record_cash_movement', { shiftId: shift, kind: 'PAID_OUT', amountCents: 3000, reasonCode: 'PETTY_EXPENSE', approvalId: po });
    // Cash refund of one soda (8,000) from the same drawer
    const soda = s1.lines.find((l: any) => l.name === 'Soda 500ml');
    const refundReq = { shiftId: shift, action: 'REFUND', saleId: s1.saleId, lines: [{ saleLineId: soda.saleLineId, qty: 1 }], refundMethod: 'CASH', reasonCode: 'CUSTOMER_RETURN' };
    const ra = await approveAtTill(db, f.alice, refundReq, f.ownerPin);
    await rpc(db, f.alice, 'reverse_sale', { ...refundReq, kind: 'REFUND', approvalId: ra });

    const expected = 500000 + 22500 + 6000 - 10000 + 5000 - 3000 - 8000; // 512,500
    const owner = await rpc(db, f.owner, 'shift_status_for_cashier', { shiftId: shift });
    expect(owner.expectedCents).toBe(expected);

    // Cashier sees nothing about expected cash before committing.
    const before = await rpc(db, f.alice, 'shift_status_for_cashier', { shiftId: shift });
    expect(Object.keys(before).sort()).toEqual(['closedAt', 'countCommitted', 'openedAt', 'registerCode', 'shiftId', 'status']);

    // Count KES 500 short -> beyond the KES 200 threshold.
    const counted = expected - 50000;
    const res = await rpc(db, f.alice, 'commit_close_count', { shiftId: shift, denominations: denoms(counted / 100) });
    expect(res).toEqual({ shiftId: shift, status: 'CLOSED_UNRECONCILED', countedCents: counted, varianceCents: -50000, flagged: true, overThreshold: true });
    const [row] = await sql(db, `select expected_cash_cents, counted_cash_cents, variance_cents, status from public.shifts where id = $1`, [shift]);
    expect(row).toEqual({ expected_cash_cents: expected, counted_cash_cents: counted, variance_cents: -50000, status: 'CLOSED_UNRECONCILED' });
    const alerts = await sql(db, `select type, severity from public.alerts where shift_id = $1 and type = 'CASH_VARIANCE'`, [shift]);
    expect(alerts).toEqual([{ type: 'CASH_VARIANCE', severity: 'HIGH' }]);

    // Single attempt, and the shift is closed for sales.
    await expect(rpc(db, f.alice, 'commit_close_count', { shiftId: shift, denominations: denoms(counted / 100) })).rejects.toThrow('COUNT_ALREADY_COMMITTED');
    await expect(sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }])).rejects.toThrow('SHIFT_NOT_OPEN');

    // After commit the cashier sees their own variance, still not expected cash.
    const after = await rpc(db, f.alice, 'shift_status_for_cashier', { shiftId: shift });
    expect(after).toMatchObject({ countCommitted: true, varianceCents: -50000, countedCents: counted });
    expect(after).not.toHaveProperty('expectedCents');

    // Owner recount (second row, both visible), then acknowledgement.
    const re = await rpc(db, f.owner, 'owner_recount_shift', { shiftId: shift, denominations: denoms((expected - 40000) / 100) });
    expect(re).toMatchObject({ status: 'CLOSED_UNRECONCILED', varianceCents: -40000 });
    const detail = await rpc(db, f.owner, 'owner_shift_detail', { shiftId: shift });
    expect(detail.counts.map((c: any) => [c.kind, c.variance_cents])).toEqual([['OPENING', 0], ['CLOSING', -50000], ['RECOUNT', -40000]]);
    await expect(rpc(db, f.alice, 'owner_recount_shift', { shiftId: shift, denominations: denoms(1) })).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.owner, 'owner_acknowledge_shift', { shiftId: shift, note: '' })).rejects.toThrow('INVALID_INPUT');
    await rpc(db, f.owner, 'owner_acknowledge_shift', { shiftId: shift, note: 'Short KES 400; deducted from wages' });
    const [acked] = await sql(db, `select status, acknowledged_by from public.shifts where id = $1`, [shift]);
    expect(acked).toEqual({ status: 'CLOSED', acknowledged_by: f.owner.id });
    const open = await sql(db, `select count(*)::int as n from public.alerts where shift_id = $1 and type = 'CASH_VARIANCE' and acknowledged_at is null`, [shift]);
    expect(open[0].n).toBe(0);

    // Correction is a new entry, never an edit.
    await rpc(db, f.owner, 'owner_cash_adjustment', { shiftId: shift, amountCents: -40000, reasonCode: 'CORRECTION', note: 'Found receipt for supplier paid from drawer' });
    const dash = await rpc(db, f.owner, 'owner_dashboard_today', {});
    const board = dash.shifts.find((s: any) => s.shiftId === shift);
    expect(board).toMatchObject({ varianceCents: -40000, netVarianceCents: 0, recounts: 1 });
  });

  it('closes within the threshold as CLOSED but still flags any non-zero variance', async () => {
    const shift = await openShift(db, f.bob, f.t2, 5000);
    const res = await rpc(db, f.bob, 'commit_close_count', { shiftId: shift, denominations: denoms(4850) });
    expect(res).toMatchObject({ status: 'CLOSED', varianceCents: -15000, flagged: true, overThreshold: false });
    expect((await sql(db, `select count(*)::int as n from public.alerts where shift_id = $1 and type = 'CASH_VARIANCE'`, [shift]))[0].n).toBe(0);
  });

  it('flags an opening float that differs from the set float', async () => {
    const shift = await openShift(db, f.bob, f.t2, 4900);
    const alerts = await sql(db, `select type, payload from public.alerts where shift_id = $1`, [shift]);
    expect(alerts).toEqual([{ type: 'OPENING_VARIANCE', payload: { countedCents: 490000, expectedCents: 500000 } }]);
    await rpc(db, f.bob, 'commit_close_count', { shiftId: shift, denominations: denoms(4900) });
  });

  it('allows one open shift per cashier and per register', async () => {
    const shift = await openShift(db, f.alice, f.t1);
    await expect(openShift(db, f.alice, f.t2)).rejects.toThrow('SHIFT_ALREADY_OPEN');
    await expect(openShift(db, f.bob, f.t1)).rejects.toThrow('REGISTER_BUSY');
    await rpc(db, f.alice, 'commit_close_count', { shiftId: shift, denominations: denoms(5000) });
  });

  it('force-closes a shift only by the owner, and requires a count before the drawer is reused', async () => {
    const shift = await openShift(db, f.bob, f.t2);
    await expect(rpc(db, f.owner, 'commit_close_count', { shiftId: shift, denominations: denoms(5000) })).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'owner_force_close_shift', { shiftId: shift, reason: 'went home' })).rejects.toThrow('FORBIDDEN');
    await rpc(db, f.owner, 'owner_force_close_shift', { shiftId: shift, reason: 'Bob went home without closing' });
    await expect(sell(db, f.bob, shift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }])).rejects.toThrow('SHIFT_NOT_OPEN');
    await expect(openShift(db, f.alice, f.t2)).rejects.toThrow('REGISTER_BUSY');
    const res = await rpc(db, f.owner, 'commit_close_count', { shiftId: shift, denominations: denoms(5000) });
    expect(res.status).toBe('CLOSED');
    const reopened = await openShift(db, f.alice, f.t2);
    await rpc(db, f.alice, 'commit_close_count', { shiftId: reopened, denominations: denoms(5000) });
  });

  it('alerts once on a shift left open past the stale limit', async () => {
    // Make time pass by inserting an old shift directly (owner privileges in the test only).
    const [old] = await sql(db, `insert into public.shifts (store_id, register_id, cashier_id, opened_at, opening_float_expected_cents, opening_float_counted_cents)
                                 values ($1, $2, $3, now() - interval '15 hours', 0, 0) returning id`, [f.storeId, f.t1, f.alice.id]);
    const run = () => sqlAs(db, 'service_role', { role: 'service_role' }, `select public.cron_stale_shifts() as r`);
    expect((await run())[0].r).toEqual({ staleAlerts: 1 });
    expect((await run())[0].r).toEqual({ staleAlerts: 0 });
    const alerts = await sql(db, `select type from public.alerts where shift_id = $1`, [old.id]);
    expect(alerts).toEqual([{ type: 'STALE_SHIFT' }]);
    await rpc(db, f.alice, 'commit_close_count', { shiftId: old.id, denominations: denoms(0) });
  });

  it('rejects malformed denomination counts', async () => {
    await expect(rpc(db, f.alice, 'open_shift', { registerId: f.t1, denominations: { n1000: 1.5 } })).rejects.toThrow('INVALID_INPUT');
    await expect(rpc(db, f.alice, 'open_shift', { registerId: f.t1, denominations: { n2000: 1 } })).rejects.toThrow('INVALID_INPUT');
    await expect(rpc(db, f.alice, 'open_shift', { registerId: f.t1, denominations: { n1000: -1 } })).rejects.toThrow('INVALID_INPUT');
  });
});
