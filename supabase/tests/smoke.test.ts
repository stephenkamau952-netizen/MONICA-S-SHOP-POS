import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, type Db, type Fixture } from './db.ts';

describe('migrations and seed', () => {
  let db: Db;
  let f: Fixture;
  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
  });

  it('bootstraps a store with owners, cashiers, registers and stock', async () => {
    const ctx = await rpc(db, f.alice, 'my_context');
    expect(ctx).toMatchObject({ hasProfile: true, role: 'CASHIER', displayName: 'Alice', storeName: "Monica's Shop" });
    const products = await rpc(db, f.owner, 'owner_products');
    expect(products.map((p: any) => [p.sku, p.onHand])).toEqual([
      ['BREAD400', 20], ['MILK500', 30], ['RICE2KG', 2], ['SODA500', 48],
    ]);
  });

  it('bootstraps without a PIN and lets the owner set their own PIN privately', async () => {
    const id = crypto.randomUUID();
    await sql(db, `insert into auth.users (id, email) values ($1, 'second@shop.test')`, [id]);
    const r = (await sql(db, `select public.bootstrap_store($1::jsonb) as r`, [JSON.stringify({ storeName: 'Second', ownerEmail: 'second@shop.test', ownerName: 'Sam' })]))[0].r;
    const owner = { id, aal: 'aal2' as const };
    expect(await rpc(db, owner, 'my_context')).toMatchObject({ role: 'OWNER', hasPin: false });
    await rpc(db, owner, 'owner_set_pin', { userId: id, pin: '503918' });
    expect(await rpc(db, owner, 'my_context')).toMatchObject({ hasPin: true });
    expect(r.registerId).toBeTruthy();
    await expect(sql(db, `select public.bootstrap_store($1::jsonb)`, [JSON.stringify({ storeName: 'X', ownerEmail: 'second@shop.test', ownerName: 'X', ownerPin: '111111' })]))
      .rejects.toThrow();
  });
});
