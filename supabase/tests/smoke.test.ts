import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, type Db, type Fixture } from './db.ts';

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
});
