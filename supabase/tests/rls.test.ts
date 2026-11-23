// PRD §2 permissions matrix and §5.3 row-level security.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, sqlAs, openShift, sell, denoms, type Db, type Fixture } from './db.ts';

const OWNER_ONLY = [
  'store_settings', 'product_costs', 'product_price_history', 'sale_line_costs', 'approvals', 'approval_rejections',
  'stock_movements', 'stock_levels', 'cart_events', 'alerts', 'alert_notifications', 'pin_attempts', 'pin_lockouts',
  'audit_log',
];

describe('row-level security and column privileges', () => {
  let db: Db;
  let f: Fixture;
  let aliceShift: string;
  let bobShift: string;
  const asAlice = (q: string, params: unknown[] = []) =>
    sqlAs(db, 'authenticated', { sub: f.alice.id, role: 'authenticated', aal: 'aal1' }, q, params);
  const asOwner = (q: string, aal: 'aal1' | 'aal2' = 'aal2', params: unknown[] = []) =>
    sqlAs(db, 'authenticated', { sub: f.owner.id, role: 'authenticated', aal }, q, params);

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    aliceShift = await openShift(db, f.alice, f.t1);
    bobShift = await openShift(db, f.bob, f.t2);
    await sell(db, f.alice, aliceShift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 10000 }]);
    await sell(db, f.bob, bobShift, [{ productId: f.products.bread, qty: 1 }], [{ method: 'CASH', tenderedCents: 6500 }]);
    await sell(db, f.bob, bobShift, [{ productId: f.products.milk, qty: 1 }], [{ method: 'MPESA', amountCents: 6000, mpesaCode: 'RLS1234567' }]);
  });

  it('shows a cashier only their own shifts, sales, lines and payments', async () => {
    expect(await asAlice(`select id from public.shifts`)).toEqual([{ id: aliceShift }]);
    expect((await asAlice(`select shift_id from public.sales`)).map((r) => r.shift_id)).toEqual([aliceShift]);
    expect((await asAlice(`select shift_id from public.sale_lines`)).every((r) => r.shift_id === aliceShift)).toBe(true);
    expect((await asAlice(`select shift_id from public.payments`)).map((r) => r.shift_id)).toEqual([aliceShift]);
    expect((await asAlice(`select shift_id from public.cash_movements`)).every((r) => r.shift_id === aliceShift)).toBe(true);
    const owner = await asOwner(`select count(*)::int as n from public.sales`);
    expect(owner[0].n).toBe(3);
  });

  it('never lets a cashier select expected cash, variance or PIN hashes', async () => {
    await expect(asAlice(`select expected_cash_cents from public.shifts`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select variance_cents from public.shifts`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select counted_cash_cents from public.shifts`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select expected_cents from public.cash_counts`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select pin_hash from public.profiles`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select system_qty from public.stock_count_lines`)).rejects.toThrow(/permission denied/);
    // Owners read these through owner RPCs, never through the table.
    await expect(asOwner(`select pin_hash from public.profiles`)).rejects.toThrow(/permission denied/);
    await expect(sqlAs(db, 'service_role', { role: 'service_role' }, `select pin_hash from public.profiles`))
      .rejects.toThrow(/permission denied/);
  });

  it('shows a cashier only their own profile', async () => {
    expect(await asAlice(`select id, display_name from public.profiles`)).toEqual([{ id: f.alice.id, display_name: 'Alice' }]);
  });

  it('hides owner-only tables from cashiers and from owners without MFA', async () => {
    for (const t of OWNER_ONLY) {
      expect(await asAlice(`select * from public.${t}`), `cashier ${t}`).toEqual([]);
      expect(await asOwner(`select * from public.${t}`, 'aal1'), `owner aal1 ${t}`).toEqual([]);
    }
    expect((await asOwner(`select * from public.product_costs`)).length).toBe(4);
    expect((await asOwner(`select * from public.audit_log`)).length).toBeGreaterThan(0);
  });

  it('requires MFA for every owner RPC and rejects cashiers', async () => {
    await expect(rpc(db, f.ownerNoMfa, 'owner_dashboard_today', {})).rejects.toThrow('MFA_REQUIRED');
    await expect(rpc(db, f.ownerNoMfa, 'owner_products')).rejects.toThrow('MFA_REQUIRED');
    await expect(rpc(db, f.alice, 'owner_dashboard_today', {})).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'owner_upsert_product', { sku: 'X', name: 'X', priceCents: 1 })).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'receive_stock', { productId: f.products.soda, qty: 1, unitCostCents: 1, supplier: 'x' }))
      .rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'adjust_stock', { productId: f.products.soda, qtyDelta: 5, reasonCode: 'FOUND' }))
      .rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'owner_set_pin', { userId: f.alice.id, pin: '902817' })).rejects.toThrow('FORBIDDEN');
    await expect(rpc(db, f.alice, 'owner_force_close_shift', { shiftId: bobShift, reason: 'test' })).rejects.toThrow('FORBIDDEN');
  });

  it('blocks anonymous users and internal helpers entirely', async () => {
    await expect(sqlAs(db, 'anon', {}, `select * from public.products`)).rejects.toThrow(/permission denied/);
    await expect(sqlAs(db, 'anon', {}, `select public.complete_sale('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select public._expected_cash($1)`, [aliceShift])).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select public._raise_alert(null,null,null,null,null,null,null,null,null)`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select public.bootstrap_store('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    await expect(asAlice(`select public.cron_integrity_checks()`)).rejects.toThrow(/permission denied/);
    await expect(sqlAs(db, 'service_role', { role: 'service_role' }, `select public.complete_sale('{}'::jsonb)`))
      .rejects.toThrow(/permission denied/);
  });

  it('delivers the private owner channel to owners only', async () => {
    const topic = `store:${f.storeId}:owner`;
    // Supabase Realtime sets realtime.topic for the subscriber, then checks the policy.
    const count = async (sub: string, aal: string) => {
      await db.exec('reset role');
      await db.query(`select set_config('realtime.topic', $1, false)`, [topic]);
      const rows = await sqlAs(db, 'authenticated', { sub, role: 'authenticated', aal },
        `select count(*)::int as n from realtime.messages`);
      return rows[0].n as number;
    };
    expect(await count(f.owner.id, 'aal2')).toBeGreaterThan(0);
    expect(await count(f.owner.id, 'aal1')).toBe(0);
    expect(await count(f.alice.id, 'aal1')).toBe(0);
    await db.query(`select set_config('realtime.topic', '', false)`);
  });

  it('never returns expected cash to a cashier before their blind count, and only variance after', async () => {
    const before = await rpc(db, f.alice, 'shift_status_for_cashier', { shiftId: aliceShift });
    expect(before.countCommitted).toBe(false);
    expect(before).not.toHaveProperty('expectedCents');
    expect(before).not.toHaveProperty('varianceCents');
    expect(before).not.toHaveProperty('countedCents');

    await expect(rpc(db, f.alice, 'shift_status_for_cashier', { shiftId: bobShift })).rejects.toThrow('NOT_FOUND');

    const result = await rpc(db, f.alice, 'commit_close_count', { shiftId: aliceShift, denominations: denoms(5080) });
    expect(result).toMatchObject({ status: 'CLOSED', varianceCents: 0 });
    expect(result).not.toHaveProperty('expectedCents');
    const after = await rpc(db, f.alice, 'shift_status_for_cashier', { shiftId: aliceShift });
    expect(after).toMatchObject({ countCommitted: true, varianceCents: 0 });
    expect(after).not.toHaveProperty('expectedCents');
  });

  it('cuts off a deactivated user immediately (role read live, not from the JWT)', async () => {
    await rpc(db, f.owner, 'owner_update_staff', { userId: f.bob.id, active: false });
    expect(await rpc(db, f.bob, 'my_context')).toMatchObject({ hasProfile: true, active: false });
    await expect(sell(db, f.bob, bobShift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }]))
      .rejects.toThrow('FORBIDDEN');
    expect(await sqlAs(db, 'authenticated', { sub: f.bob.id, role: 'authenticated' }, `select id from public.products`)).toEqual([]);
    await rpc(db, f.owner, 'owner_update_staff', { userId: f.bob.id, active: true });
  });

  it('protects the last owner and owners from changing themselves', async () => {
    await expect(rpc(db, f.owner, 'owner_update_staff', { userId: f.owner.id, active: false })).rejects.toThrow('CANNOT_CHANGE_SELF');
    await rpc(db, f.owner, 'owner_update_staff', { userId: f.owner2.id, role: 'CASHIER' });
    await expect(rpc(db, f.owner2, 'owner_update_staff', { userId: f.owner.id, role: 'CASHIER' })).rejects.toThrow('FORBIDDEN');
    await rpc(db, f.owner, 'owner_update_staff', { userId: f.owner2.id, role: 'OWNER' });
    expect((await sql(db, `select count(*)::int as n from public.profiles where role = 'OWNER'`))[0].n).toBe(2);
  });
});
