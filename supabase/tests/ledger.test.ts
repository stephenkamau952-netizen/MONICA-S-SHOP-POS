// PRD §4 "How immutability is enforced" and KPI "Hard deletes on ledger
// tables: 0 possible": every append-only table rejects UPDATE, DELETE and
// TRUNCATE for every role, including the table owner (postgres).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createDb, seedStore, rpc, sql, sqlAs, openShift, sell, approveAtTill, uuid, denoms,
  type Db, type Fixture,
} from './db.ts';

const APPEND_ONLY = [
  'product_price_history', 'cash_counts', 'cash_movements', 'sales', 'sale_lines', 'sale_line_costs',
  'payments', 'sale_reversals', 'sale_reversal_lines', 'approval_requests', 'approval_rejections',
  'stock_movements', 'stock_count_items', 'stock_count_lines', 'cart_events', 'alert_notifications',
  'pin_attempts', 'pin_lockouts', 'audit_log',
];
const ALL_TABLES = [
  ...APPEND_ONLY, 'stores', 'store_settings', 'profiles', 'registers', 'products', 'product_costs',
  'shifts', 'approvals', 'stock_levels', 'stock_counts', 'alerts',
];
const API_ROLES = ['anon', 'authenticated', 'service_role'] as const;

describe('immutable ledger', () => {
  let db: Db;
  let f: Fixture;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    // Put at least one row in every ledger table.
    const shift = await openShift(db, f.alice, f.t1);
    const sale = await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 2 }], [{ method: 'CASH', tenderedCents: 20000 }]);
    const approvalId = await approveAtTill(db, f.alice,
      { shiftId: shift, action: 'VOID', saleId: sale.saleId, refundMethod: 'CASH', reasonCode: 'WRONG_ITEM' }, f.ownerPin);
    await rpc(db, f.alice, 'reverse_sale', {
      shiftId: shift, saleId: sale.saleId, kind: 'VOID', refundMethod: 'CASH', reasonCode: 'WRONG_ITEM', approvalId,
    });
    const noSale = await rpc(db, f.alice, 'request_approval', { shiftId: shift, action: 'NO_SALE', reasonCode: 'CHANGE_GIVEN' });
    await rpc(db, f.owner, 'reject_request', { requestId: noSale.requestId, note: 'not now' });
    await rpc(db, f.alice, 'log_cart_event', {
      shiftId: shift, eventKey: uuid(), cartKey: uuid(), kind: 'LINE_REMOVED', productId: f.products.bread, qty: 1,
    });
    const count = await rpc(db, f.owner, 'open_stock_count', { productIds: [f.products.milk] });
    await rpc(db, f.owner, 'record_count_line', { countId: count.countId, productId: f.products.milk, countedQty: 30 });
    const paidOut = await rpc(db, f.alice, 'request_approval', {
      shiftId: shift, action: 'PAID_OUT', amountCents: 1000, reasonCode: 'PETTY_EXPENSE',
    });
    for (let i = 0; i < 5; i++) await rpc(db, f.alice, 'approve_with_pin', { requestId: paidOut.requestId, pin: '111222' });
    const [lockAlert] = await sql(db, `select id from public.alerts where type = 'PIN_LOCKOUT'`);
    await sqlAs(db, 'service_role', { role: 'service_role' },
      `select public.cron_record_notification($1::jsonb)`, [JSON.stringify({ alertId: lockAlert.id, channel: 'test', status: 'SENT' })]);
  });

  it('has rows in every append-only table (so row triggers are exercised)', async () => {
    for (const t of APPEND_ONLY) {
      const [{ n }] = await sql(db, `select count(*)::int as n from public.${t}`);
      expect(n, t).toBeGreaterThan(0);
    }
  });

  it('rejects UPDATE and DELETE on append-only tables even for the table owner', async () => {
    for (const t of APPEND_ONLY) {
      await expect(sql(db, `delete from public.${t}`), `delete ${t}`).rejects.toThrow('LEDGER_IMMUTABLE');
      await expect(sql(db, `update public.${t} set store_id = store_id`), `update ${t}`).rejects.toThrow('LEDGER_IMMUTABLE');
    }
  });

  it('rejects TRUNCATE on every table, for every role', async () => {
    for (const t of ALL_TABLES) {
      await expect(sql(db, `truncate public.${t} cascade`), `truncate ${t}`).rejects.toThrow();
      for (const role of API_ROLES) {
        await expect(sqlAs(db, role, {}, `truncate public.${t} cascade`), `${role} truncate ${t}`).rejects.toThrow();
      }
    }
    const [{ n }] = await sql(db, `select count(*)::int as n from public.sales`);
    expect(n).toBe(1);
  });

  it('gives API roles no INSERT, UPDATE or DELETE on any table', async () => {
    for (const t of ALL_TABLES) {
      for (const role of API_ROLES) {
        const claims = { sub: f.owner.id, role, aal: 'aal2' };
        const col = t === 'stores' ? 'id' : 'store_id';
        await expect(sqlAs(db, role, claims, `delete from public.${t}`), `${role} delete ${t}`).rejects.toThrow(/permission denied/);
        await expect(sqlAs(db, role, claims, `update public.${t} set ${col} = ${col}`), `${role} update ${t}`)
          .rejects.toThrow(/permission denied/);
        await expect(sqlAs(db, role, claims, `insert into public.${t} default values`), `${role} insert ${t}`)
          .rejects.toThrow(/permission denied/);
      }
    }
  });

  it('only changes stock_levels through stock_movements', async () => {
    await expect(sql(db, `update public.stock_levels set on_hand = on_hand + 100`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.stock_levels`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `insert into public.stock_levels (product_id, store_id, on_hand) values ($1, $2, 5)`,
      [uuid(), f.storeId])).rejects.toThrow('LEDGER_IMMUTABLE');
  });

  it('lets an approval token be consumed only once, and never edited', async () => {
    const [ap] = await sql(db, `select id from public.approvals where consumed_at is not null limit 1`);
    await expect(sql(db, `update public.approvals set consumed_at = now() where id = $1`, [ap.id])).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `update public.approvals set payload = '{}' where id = $1`, [ap.id])).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.approvals`)).rejects.toThrow('LEDGER_IMMUTABLE');
  });

  it('lets an alert be acknowledged once and nothing else', async () => {
    const [al] = await sql(db, `select id from public.alerts limit 1`);
    await expect(sql(db, `update public.alerts set subject = 'x' where id = $1`, [al.id])).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.alerts`)).rejects.toThrow('LEDGER_IMMUTABLE');
  });

  it('never deletes reference rows and never reopens a shift', async () => {
    await expect(sql(db, `delete from public.products`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.profiles`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.shifts`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `delete from public.registers`)).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `update public.registers set code = 'X9'`)).rejects.toThrow('LEDGER_IMMUTABLE');

    const [s] = await sql(db, `select id from public.shifts where cashier_id = $1`, [f.alice.id]);
    await rpc(db, f.alice, 'commit_close_count', { shiftId: s.id, denominations: denoms(5000) });
    await expect(sql(db, `update public.shifts set status = 'OPEN', closed_at = null where id = $1`, [s.id]))
      .rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(sql(db, `update public.shifts set cashier_id = $2 where id = $1`, [s.id, f.bob.id]))
      .rejects.toThrow('LEDGER_IMMUTABLE');
  });
});
