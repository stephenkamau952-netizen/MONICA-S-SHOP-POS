// Test harness: a fresh PGlite (real Postgres) per test file, with the
// Supabase shim and every migration applied in order.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

export type Db = PGlite;

export interface Actor {
  id: string;
  aal?: 'aal1' | 'aal2';
}

export async function createDb(): Promise<Db> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

async function asRole(db: Db, role: 'authenticated' | 'anon' | 'service_role', claims: object) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
}

/** Call an RPC as a signed-in user (role authenticated, auth.uid() = actor.id). */
export async function rpc<T = any>(db: Db, actor: Actor, fn: string, p?: unknown): Promise<T> {
  await asRole(db, 'authenticated', { sub: actor.id, role: 'authenticated', aal: actor.aal ?? 'aal1' });
  try {
    const sql = p === undefined ? `select public.${fn}() as r` : `select public.${fn}($1::jsonb) as r`;
    const res = await db.query<{ r: T }>(sql, p === undefined ? [] : [JSON.stringify(p)]);
    return res.rows[0]!.r;
  } finally {
    await db.exec('reset role');
  }
}

/** Run SQL as a given database role with optional JWT claims. */
export async function sqlAs<T = any>(
  db: Db,
  role: 'authenticated' | 'anon' | 'service_role',
  claims: object,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await asRole(db, role, claims);
  try {
    const res = await db.query<T>(sql, params);
    return res.rows;
  } finally {
    await db.exec('reset role');
  }
}

/** Run SQL as the table owner (postgres superuser in PGlite). */
export async function sql<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  const res = await db.query<T>(text, params);
  return res.rows;
}

export const uuid = () => randomUUID();

export const ZERO = { n1000: 0, n500: 0, n200: 0, n100: 0, n50: 0, c20: 0, c10: 0, c5: 0, c1: 0 };
/** Denominations for a whole-shilling amount, greedy. */
export function denoms(kes: number) {
  const out: Record<string, number> = { ...ZERO };
  const order: [string, number][] = [
    ['n1000', 1000], ['n500', 500], ['n200', 200], ['n100', 100], ['n50', 50],
    ['c20', 20], ['c10', 10], ['c5', 5], ['c1', 1],
  ];
  let rest = kes;
  for (const [k, v] of order) {
    out[k] = Math.floor(rest / v);
    rest -= out[k]! * v;
  }
  return out;
}

export interface Fixture {
  storeId: string;
  owner: Actor;
  ownerNoMfa: Actor;
  owner2: Actor;
  alice: Actor;
  bob: Actor;
  t1: string;
  t2: string;
  products: { soda: string; bread: string; milk: string; rice: string };
  ownerPin: string;
  owner2Pin: string;
  alicePin: string;
}

/**
 * Store with two owners, two cashiers, two registers (float KES 5,000) and
 * four products. Stock is received through the RPC so costs are real.
 */
export async function seedStore(db: Db): Promise<Fixture> {
  const ownerId = uuid();
  const owner2Id = uuid();
  const aliceId = uuid();
  const bobId = uuid();
  await sql(db, `insert into auth.users (id, email) values ($1,'owner@shop.test'),($2,'owner2@shop.test'),($3,'alice@shop.test'),($4,'bob@shop.test')`,
    [ownerId, owner2Id, aliceId, bobId]);
  const boot = (await sql<{ r: any }>(db, `select public.bootstrap_store($1::jsonb) as r`, [JSON.stringify({
    storeName: "Monica's Shop", ownerEmail: 'owner@shop.test', ownerName: 'Monica', ownerPin: '482915',
    registerCode: 'T1', registerName: 'Till 1', floatCents: 500000,
  })]))[0]!.r;

  const owner: Actor = { id: ownerId, aal: 'aal2' };
  await rpc(db, owner, 'owner_assign_staff', { userId: owner2Id, role: 'OWNER', displayName: 'Peter' });
  await rpc(db, owner, 'owner_assign_staff', { userId: aliceId, role: 'CASHIER', displayName: 'Alice' });
  await rpc(db, owner, 'owner_assign_staff', { userId: bobId, role: 'CASHIER', displayName: 'Bob' });
  await rpc(db, owner, 'owner_set_pin', { userId: owner2Id, pin: '730164' });
  await rpc(db, owner, 'owner_set_pin', { userId: aliceId, pin: '284613' });
  const t2 = await rpc(db, owner, 'owner_upsert_register', { code: 'T2', name: 'Till 2', floatCents: 500000 });

  const mk = async (sku: string, barcode: string, name: string, priceCents: number, reorderLevel: number) =>
    (await rpc(db, owner, 'owner_upsert_product', { sku, barcode, name, priceCents, reorderLevel })).id as string;
  const soda = await mk('SODA500', '5449000000996', 'Soda 500ml', 8000, 5);
  const bread = await mk('BREAD400', '6161100000017', 'Bread 400g', 6500, 3);
  const milk = await mk('MILK500', '6161100000024', 'Milk 500ml', 6000, 2);
  const rice = await mk('RICE2KG', '6161100000031', 'Rice 2kg', 32000, 1);

  await rpc(db, owner, 'receive_stock', { productId: soda, qty: 48, unitCostCents: 5500, supplier: 'Coca-Cola distributor' });
  await rpc(db, owner, 'receive_stock', { productId: bread, qty: 20, unitCostCents: 5000, supplier: 'Bakery' });
  await rpc(db, owner, 'receive_stock', { productId: milk, qty: 30, unitCostCents: 4500, supplier: 'Dairy' });
  await rpc(db, owner, 'receive_stock', { productId: rice, qty: 2, unitCostCents: 26000, supplier: 'Wholesaler' });

  return {
    storeId: boot.storeId,
    owner,
    ownerNoMfa: { id: ownerId, aal: 'aal1' },
    owner2: { id: owner2Id, aal: 'aal2' },
    alice: { id: aliceId },
    bob: { id: bobId },
    t1: boot.registerId,
    t2: t2.id,
    products: { soda, bread, milk, rice },
    ownerPin: '482915',
    owner2Pin: '730164',
    alicePin: '284613',
  };
}

export async function openShift(db: Db, who: Actor, registerId: string, floatKes = 5000): Promise<string> {
  const r = await rpc(db, who, 'open_shift', { registerId, denominations: denoms(floatKes) });
  return r.shiftId;
}

export async function sell(
  db: Db,
  who: Actor,
  shiftId: string,
  lines: { productId: string; qty: number; overridePriceCents?: number; overrideApprovalId?: string }[],
  payments: unknown[],
  idempotencyKey = uuid(),
) {
  return rpc(db, who, 'complete_sale', { idempotencyKey, shiftId, lines, payments });
}

/** Ask for an approval and have an owner approve it with their PIN at the till. */
export async function approveAtTill(db: Db, who: Actor, request: object, pin: string): Promise<string> {
  const req = await rpc(db, who, 'request_approval', request);
  const res = await rpc(db, who, 'approve_with_pin', { requestId: req.requestId, pin });
  if (!res.ok) throw new Error(`approval failed: ${res.error}`);
  return res.approvalId;
}
