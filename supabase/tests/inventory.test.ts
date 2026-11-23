// FR-IN-1..6 inventory, stock counts and alerts.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, sqlAs, openShift, sell, type Db, type Fixture } from './db.ts';

describe('inventory', () => {
  let db: Db;
  let f: Fixture;
  let shift: string;
  const onHand = async (productId: string) =>
    (await sql(db, `select on_hand from public.stock_levels where product_id = $1`, [productId]))[0].on_hand as number;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    shift = await openShift(db, f.alice, f.t1);
  });

  it('updates weighted-average cost on receipt and snapshots cost at sale time', async () => {
    const r = await rpc(db, f.owner, 'receive_stock', { productId: f.products.soda, qty: 12, unitCostCents: 6000, supplier: 'Coca-Cola distributor' });
    // (48 x 5,500 + 12 x 6,000) / 60 = 5,600
    expect(r).toMatchObject({ onHand: 60, avgCostCents: 5600 });
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 3 }], [{ method: 'CASH', tenderedCents: 24000 }]);
    const [c] = await sql(db, `select unit_cost_cents, cost_total_cents from public.sale_line_costs where sale_id = $1`, [sale.saleId]);
    expect(Number(c.unit_cost_cents)).toBe(5600);
    expect(Number(c.cost_total_cents)).toBe(16800);
  });

  it('requires a reason with the right sign for every adjustment', async () => {
    const adj = (qtyDelta: number, reasonCode: string, note?: string) =>
      rpc(db, f.owner, 'adjust_stock', { productId: f.products.bread, qtyDelta, reasonCode, note });
    await expect(adj(2, 'LOST')).rejects.toThrow('INVALID_INPUT');
    await expect(adj(-2, 'FOUND')).rejects.toThrow('INVALID_INPUT');
    await expect(adj(1, 'OTHER')).rejects.toThrow('INVALID_INPUT');
    await expect(adj(1, 'BECAUSE')).rejects.toThrow('INVALID_INPUT');
    await expect(adj(-1000, 'THEFT')).rejects.toThrow('INSUFFICIENT_STOCK');
    await adj(-2, 'THEFT', 'shoplifter seen on CCTV');
    await adj(-1, 'DAMAGED');
    expect(await onHand(f.products.bread)).toBe(17);
    const moves = await sql(db, `select type, qty_delta, reason_code from public.stock_movements
                                  where product_id = $1 and type in ('ADJUST','DAMAGED') order by created_at, qty_delta`, [f.products.bread]);
    expect(moves).toEqual([
      { type: 'ADJUST', qty_delta: -2, reason_code: 'THEFT' },
      { type: 'DAMAGED', qty_delta: -1, reason_code: 'DAMAGED' },
    ]);
  });

  it('runs a blind stock count: counters never see system quantities', async () => {
    const count = await rpc(db, f.owner, 'open_stock_count', { productIds: [f.products.bread, f.products.milk], assignedTo: f.alice.id, note: 'Friday count' });
    expect(count.items).toBe(2);
    await expect(rpc(db, f.owner, 'open_stock_count', { allProducts: true })).rejects.toThrow('STOCK_COUNT_ALREADY_OPEN');

    const mine = await rpc(db, f.alice, 'my_stock_count');
    expect(mine.items.map((i: any) => Object.keys(i).sort())).toEqual([
      ['barcode', 'countedQty', 'name', 'productId', 'sku'], ['barcode', 'countedQty', 'name', 'productId', 'sku'],
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/onHand|systemQty|system_qty/);
    expect((await rpc(db, f.alice, 'my_context')).assignedStockCount.id).toBe(count.countId);

    // Bread system qty is 17; Alice counts 15. Then a sale happens before posting.
    await rpc(db, f.alice, 'record_count_line', { countId: count.countId, productId: f.products.bread, countedQty: 15 });
    await expect(rpc(db, f.bob, 'record_count_line', { countId: count.countId, productId: f.products.bread, countedQty: 1 })).rejects.toThrow('NOT_FOUND');
    await expect(rpc(db, f.alice, 'record_count_line', { countId: count.countId, productId: f.products.soda, countedQty: 1 })).rejects.toThrow('INVALID_INPUT');
    await expect(sqlAs(db, 'authenticated', { sub: f.alice.id, role: 'authenticated' }, `select system_qty from public.stock_count_lines`))
      .rejects.toThrow(/permission denied/);
    await sell(db, f.alice, shift, [{ productId: f.products.bread, qty: 1 }], [{ method: 'CASH', tenderedCents: 6500 }]);
    expect(await onHand(f.products.bread)).toBe(16);

    await expect(rpc(db, f.alice, 'post_stock_count', { countId: count.countId })).rejects.toThrow('FORBIDDEN');
    const posted = await rpc(db, f.owner, 'post_stock_count', { countId: count.countId });
    // Difference is taken at the moment of counting: 15 - 17 = -2, so 16 - 2 = 14.
    expect(posted.lines).toEqual([{ productId: f.products.bread, name: 'Bread 400g', systemQty: 17, countedQty: 15, diff: -2, valueCents: -10000 }]);
    expect(posted).toMatchObject({ varianceValueCents: -10000, uncounted: 1 });
    expect(await onHand(f.products.bread)).toBe(14);
    await expect(rpc(db, f.alice, 'record_count_line', { countId: count.countId, productId: f.products.bread, countedQty: 1 })).rejects.toThrow();
    expect((await rpc(db, f.alice, 'my_context')).assignedStockCount).toBeNull();
  });

  it('raises LOW_STOCK once until the product is restocked', async () => {
    const lowAlerts = async () =>
      (await sql(db, `select count(*)::int as n from public.alerts where type = 'LOW_STOCK' and ref_id = $1`, [f.products.rice]))[0].n;
    await sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 1 }], [{ method: 'CASH', tenderedCents: 32000 }]); // 1 left, reorder 1
    expect(await lowAlerts()).toBe(1);
    await sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 1 }], [{ method: 'CASH', tenderedCents: 32000 }]); // 0 left
    expect(await lowAlerts()).toBe(1);
    await rpc(db, f.owner, 'receive_stock', { productId: f.products.rice, qty: 5, unitCostCents: 26000, supplier: 'Wholesaler' });
    await sell(db, f.alice, shift, [{ productId: f.products.rice, qty: 4 }], [{ method: 'CASH', tenderedCents: 128000 }]); // 1 left
    expect(await lowAlerts()).toBe(2);
    const dash = await rpc(db, f.owner, 'owner_dashboard_today', {});
    expect(dash.lowStock.map((p: any) => [p.sku, p.onHand])).toEqual([['RICE2KG', 1]]);
  });

  it('copies every price change to price history', async () => {
    await rpc(db, f.owner, 'owner_upsert_product', { id: f.products.milk, sku: 'MILK500', barcode: '6161100000024', name: 'Milk 500ml', priceCents: 6500, reorderLevel: 2 });
    const hist = await sql(db, `select old_price_cents, new_price_cents, changed_by from public.product_price_history
                                 where product_id = $1 order by changed_at, old_price_cents nulls first`, [f.products.milk]);
    expect(hist).toEqual([
      { old_price_cents: null, new_price_cents: 6000, changed_by: f.owner.id },
      { old_price_cents: 6000, new_price_cents: 6500, changed_by: f.owner.id },
    ]);
    await expect(rpc(db, f.owner, 'owner_upsert_product', { sku: 'MILK500', name: 'Copy', priceCents: 1 })).rejects.toThrow('DUPLICATE_PRODUCT');
  });

  it('passes the nightly integrity check: SUM(movements) = on_hand for every product', async () => {
    const [{ r }] = await sqlAs(db, 'service_role', { role: 'service_role' }, `select public.cron_integrity_checks() as r`);
    expect(r.stockMismatches).toEqual([]);
    expect(r.shiftProblems).toEqual([]);
    expect(r.auditChain.ok).toBe(true);
    const rows = await sql(db, `select p.id, coalesce(sl.on_hand,0) as on_hand, coalesce(sum(m.qty_delta),0)::int as total
                                  from public.products p left join public.stock_levels sl on sl.product_id = p.id
                                  left join public.stock_movements m on m.product_id = p.id group by p.id, sl.on_hand`);
    for (const row of rows) expect(row.on_hand).toBe(row.total);
  });
});
