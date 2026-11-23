// FR-CO-1..8 and §5.2 complete_sale steps.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, openShift, sell, uuid, type Db, type Fixture } from './db.ts';

describe('complete_sale', () => {
  let db: Db;
  let f: Fixture;
  let shift: string;
  let bobShift: string;
  const onHand = async (productId: string) =>
    (await sql(db, `select on_hand from public.stock_levels where product_id = $1`, [productId]))[0]?.on_hand ?? 0;
  const salesCount = async () => (await sql(db, `select count(*)::int as n from public.sales`))[0].n as number;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    shift = await openShift(db, f.alice, f.t1);
    bobShift = await openShift(db, f.bob, f.t2);
  });

  it('prices from the database, computes change and deducts stock in the same transaction', async () => {
    const key = uuid();
    const r = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 2 }, { productId: f.products.bread, qty: 1 }],
      [{ method: 'CASH', tenderedCents: 25000 }], key);
    expect(r).toMatchObject({
      receiptLabel: 'T1-000001', totalCents: 22500, listTotalCents: 22500, changeDueCents: 2500,
      openDrawer: true, cashierName: 'Alice', replayed: false, itemCount: 3,
    });
    expect(r.lines.map((l: any) => [l.name, l.qty, l.unitPriceCents, l.lineTotalCents])).toEqual([
      ['Soda 500ml', 2, 8000, 16000], ['Bread 400g', 1, 6500, 6500],
    ]);
    expect(r.payments).toEqual([{ method: 'CASH', amountCents: 22500, tenderedCents: 25000, changeCents: 2500, mpesaCode: null, cardRef: null }]);
    expect(await onHand(f.products.soda)).toBe(46);
    expect(await onHand(f.products.bread)).toBe(19);

    const moves = await sql(db, `select type, qty_delta from public.stock_movements where ref_id in
      (select id from public.sale_lines where sale_id = $1) order by qty_delta`, [r.saleId]);
    expect(moves).toEqual([{ type: 'SALE', qty_delta: -2 }, { type: 'SALE', qty_delta: -1 }]);
    const costs = await sql(db, `select cost_total_cents from public.sale_line_costs where sale_id = $1 order by cost_total_cents`, [r.saleId]);
    expect(costs.map((c) => Number(c.cost_total_cents))).toEqual([5000, 11000]);
    const audit = await sql(db, `select action from public.audit_log where target_id = $1`, [r.saleId]);
    expect(audit).toEqual([{ action: 'complete_sale' }]);
    const rt = await sql(db, `select event, topic, private from realtime.messages where payload->>'saleId' = $1`, [r.saleId]);
    expect(rt).toEqual([{ event: 'sale', topic: `store:${f.storeId}:owner`, private: true }]);
  });

  it('is idempotent: retrying the same key returns the original sale and writes nothing', async () => {
    const key = uuid();
    const lines = [{ productId: f.products.milk, qty: 1 }];
    const first = await sell(db, f.alice, shift, lines, [{ method: 'CASH', tenderedCents: 6000 }], key);
    const n = await salesCount();
    const stock = await onHand(f.products.milk);
    const again = await sell(db, f.alice, shift, lines, [{ method: 'CASH', tenderedCents: 6000 }], key);
    expect(again.saleId).toBe(first.saleId);
    expect(again.replayed).toBe(true);
    expect(await salesCount()).toBe(n);
    expect(await onHand(f.products.milk)).toBe(stock);
    await expect(sell(db, f.bob, bobShift, lines, [{ method: 'CASH', tenderedCents: 6000 }], key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('ignores any price the client sends and refuses unapproved overrides', async () => {
    const r = await rpc(db, f.alice, 'complete_sale', {
      idempotencyKey: uuid(), shiftId: shift,
      lines: [{ productId: f.products.soda, qty: 1, unitPriceCents: 1, priceCents: 1 }],
      payments: [{ method: 'CASH', tenderedCents: 8000 }],
    });
    expect(r.totalCents).toBe(8000);
    await expect(sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 1, overridePriceCents: 100 }],
      [{ method: 'CASH', tenderedCents: 100 }])).rejects.toThrow('APPROVAL_REQUIRED');
  });

  it('rejects bad shapes instead of coercing them', async () => {
    const pay = [{ method: 'CASH', tenderedCents: 100000 }];
    await expect(sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 1.5 }], pay)).rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, [{ productId: f.products.soda, qty: '2' as any }], pay)).rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 0 }], pay)).rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, [], pay)).rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, [{ productId: 'nope', qty: 1 }], pay)).rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, [{ productId: uuid(), qty: 1 }], pay)).rejects.toThrow('PRODUCT_UNAVAILABLE');
  });

  it('only sells on the caller\'s own open shift', async () => {
    const pay = [{ method: 'CASH', tenderedCents: 8000 }];
    await expect(sell(db, f.alice, bobShift, [{ productId: f.products.soda, qty: 1 }], pay)).rejects.toThrow('SHIFT_NOT_OPEN');
    await expect(sell(db, f.owner, shift, [{ productId: f.products.soda, qty: 1 }], pay)).rejects.toThrow('SHIFT_NOT_OPEN');
    await expect(sell(db, f.alice, uuid(), [{ productId: f.products.soda, qty: 1 }], pay)).rejects.toThrow('SHIFT_NOT_OPEN');
  });

  it('blocks selling below zero and writes nothing when it fails (receipt numbers stay gapless)', async () => {
    const before = await salesCount();
    const last = (await sql(db, `select max(receipt_no)::int as n from public.sales where register_id = $1`, [f.t1]))[0].n;
    await expect(sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 3 }], [{ method: 'CASH', tenderedCents: 96000 }]))
      .rejects.toThrow('INSUFFICIENT_STOCK');
    expect(await salesCount()).toBe(before);
    expect(await onHand(f.products.rice)).toBe(2);
    // Two tills, last units: the first sale takes them, the second is refused.
    await sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 2 }], [{ method: 'CASH', tenderedCents: 64000 }]);
    await expect(sell(db, f.bob, bobShift, [{ productId: f.products.rice, qty: 1 }], [{ method: 'CASH', tenderedCents: 32000 }]))
      .rejects.toThrow('INSUFFICIENT_STOCK');
    const nos = await sql(db, `select receipt_no::int as n from public.sales where register_id = $1 order by receipt_no`, [f.t1]);
    expect(nos.map((r) => r.n)).toEqual(Array.from({ length: last + 1 }, (_, i) => i + 1));
  });

  it('enforces that payments add up, and computes split tender', async () => {
    const lines = [{ productId: f.products.soda, qty: 2 }, { productId: f.products.bread, qty: 1 }]; // 22,500
    await expect(sell(db, f.alice, shift, lines, [{ method: 'MPESA', amountCents: 5000, mpesaCode: 'AAA1111111' }]))
      .rejects.toThrow('PAYMENT_MISMATCH');
    await expect(sell(db, f.alice, shift, lines, [{ method: 'CARD', amountCents: 30000, cardRef: '4242' }]))
      .rejects.toThrow('PAYMENT_MISMATCH');
    await expect(sell(db, f.alice, shift, lines, [{ method: 'CASH', tenderedCents: 22499 }])).rejects.toThrow('INSUFFICIENT_TENDER');
    await expect(sell(db, f.alice, shift, lines, [{ method: 'CASH', tenderedCents: 10000 }, { method: 'CASH', tenderedCents: 20000 }]))
      .rejects.toThrow('INVALID_INPUT');
    await expect(sell(db, f.alice, shift, lines, [
      { method: 'CARD', amountCents: 22500, cardRef: '4242' }, { method: 'CASH', tenderedCents: 1000 },
    ])).rejects.toThrow('PAYMENT_MISMATCH');

    const r = await sell(db, f.alice, shift, lines, [
      { method: 'MPESA', amountCents: 10000, mpesaCode: 'SPL1234567' }, { method: 'CASH', tenderedCents: 20000 },
    ]);
    expect(r.payments).toEqual([
      { method: 'MPESA', amountCents: 10000, tenderedCents: null, changeCents: null, mpesaCode: 'SPL1234567', cardRef: null },
      { method: 'CASH', amountCents: 12500, tenderedCents: 20000, changeCents: 7500, mpesaCode: null, cardRef: null },
    ]);
    expect(r.changeDueCents).toBe(7500);

    const card = await sell(db, f.alice, shift, [{ productId: f.products.milk, qty: 1 }], [{ method: 'CARD', amountCents: 6000, cardRef: 'TRM-88812' }]);
    expect(card.openDrawer).toBe(false);
  });

  it('never accepts the same M-Pesa code twice (across sales, tills and letter case)', async () => {
    const lines = [{ productId: f.products.milk, qty: 1 }];
    const m = await sell(db, f.alice, shift, lines, [{ method: 'MPESA', amountCents: 6000, mpesaCode: 'QWE1234567' }]);
    expect(m.openDrawer).toBe(false);
    await expect(sell(db, f.bob, bobShift, lines, [{ method: 'MPESA', amountCents: 6000, mpesaCode: 'QWE1234567' }]))
      .rejects.toThrow('MPESA_CODE_USED');
    await expect(sell(db, f.alice, shift, lines, [{ method: 'MPESA', amountCents: 6000, mpesaCode: 'qwe1234567' }]))
      .rejects.toThrow('MPESA_CODE_USED');
    await expect(sell(db, f.alice, shift, [{ productId: f.products.milk, qty: 2 }], [
      { method: 'MPESA', amountCents: 6000, mpesaCode: 'DUP1234567' }, { method: 'MPESA', amountCents: 6000, mpesaCode: 'DUP1234567' },
    ])).rejects.toThrow('MPESA_CODE_USED');
  });

  it('refuses products that are no longer sold', async () => {
    const p = await rpc(db, f.owner, 'owner_upsert_product', { sku: 'OLD1', name: 'Old item', priceCents: 1000, active: false });
    await expect(sell(db, f.alice, shift, [{ productId: p.id, qty: 1 }], [{ method: 'CASH', tenderedCents: 1000 }]))
      .rejects.toThrow('PRODUCT_UNAVAILABLE');
  });

  it('allows negative stock only when the owner enables it, and alerts each time', async () => {
    await rpc(db, f.owner, 'owner_update_settings', { allowNegativeStock: true });
    const r = await sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 1 }], [{ method: 'CASH', tenderedCents: 32000 }]);
    expect(await onHand(f.products.rice)).toBe(-1);
    const alerts = await sql(db, `select type, severity from public.alerts where type = 'NEGATIVE_STOCK' and payload->>'saleId' = $1`, [r.saleId]);
    expect(alerts).toEqual([{ type: 'NEGATIVE_STOCK', severity: 'LOW' }]);
    await rpc(db, f.owner, 'owner_update_settings', { allowNegativeStock: false });
  });

  it('logs removed lines and cancelled carts, and alerts past the thresholds (once per shift)', async () => {
    const cart = uuid();
    for (let i = 0; i < 6; i++) {
      await rpc(db, f.bob, 'log_cart_event', { shiftId: bobShift, eventKey: uuid(), cartKey: cart, kind: 'LINE_REMOVED', productId: f.products.soda, qty: 1 });
    }
    const key = uuid();
    await rpc(db, f.bob, 'log_cart_event', { shiftId: bobShift, eventKey: key, cartKey: cart, kind: 'QTY_REDUCED', productId: f.products.soda, qty: 1 });
    expect(await rpc(db, f.bob, 'log_cart_event', { shiftId: bobShift, eventKey: key, cartKey: cart, kind: 'QTY_REDUCED', productId: f.products.soda, qty: 1 }))
      .toEqual({ ok: true, duplicate: true });
    for (let i = 0; i < 3; i++) {
      await rpc(db, f.bob, 'log_cart_event', { shiftId: bobShift, eventKey: uuid(), cartKey: uuid(), kind: 'CART_CANCELLED', lines: [{ productId: f.products.milk, qty: 2 }] });
    }
    const events = await sql(db, `select kind, count(*)::int as n from public.cart_events where shift_id = $1 group by kind order by kind`, [bobShift]);
    expect(events).toEqual([{ kind: 'CART_CANCELLED', n: 3 }, { kind: 'LINE_REMOVED', n: 6 }, { kind: 'QTY_REDUCED', n: 1 }]);
    const alerts = await sql(db, `select dedupe_key from public.alerts where type = 'CART_DELETIONS' and shift_id = $1 order by dedupe_key`, [bobShift]);
    expect(alerts.map((a) => a.dedupe_key)).toEqual([`CART_DELETIONS:CARTS:${bobShift}`, `CART_DELETIONS:LINES:${bobShift}`]);
  });
});
