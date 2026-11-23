// §4 audit hash chain and §7 owner dashboard numbers.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, seedStore, rpc, sql, sqlAs, openShift, sell, approveAtTill, denoms, type Db, type Fixture } from './db.ts';

describe('dashboard metrics', () => {
  let db: Db;
  let f: Fixture;
  let shift: string;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    shift = await openShift(db, f.alice, f.t1);
    // A: cash, 2 soda (cost 5,500) + 1 bread (cost 5,000) = 22,500
    const a = await sell(db, f.alice, shift,
      [{ productId: f.products.soda, qty: 2 }, { productId: f.products.bread, qty: 1 }], [{ method: 'CASH', tenderedCents: 25000 }]);
    // B: M-Pesa, 2 milk (cost 4,500) = 12,000
    await sell(db, f.alice, shift, [{ productId: f.products.milk, qty: 2 }], [{ method: 'MPESA', amountCents: 12000, mpesaCode: 'DSH1234567' }]);
    // Cash refund of 1 soda, restocked
    const soda = a.lines.find((l: any) => l.name === 'Soda 500ml').saleLineId;
    const req = { shiftId: shift, action: 'REFUND', saleId: a.saleId, lines: [{ saleLineId: soda, qty: 1 }], refundMethod: 'CASH', reasonCode: 'CUSTOMER_RETURN' };
    const approvalId = await approveAtTill(db, f.alice, req, f.ownerPin);
    await rpc(db, f.alice, 'reverse_sale', { ...req, kind: 'REFUND', approvalId });
  });

  it('computes gross, net, COGS, gross margin and payment mix from the ledger', async () => {
    const d = await rpc(db, f.owner, 'owner_dashboard_today', {});
    expect(d).toMatchObject({
      grossSalesCents: 34500,
      salesCount: 2,
      avgBasketCents: 17250,
      voidsCents: 0,
      refundsCents: 8000,
      netSalesCents: 26500,
      cogsCents: 11000 + 5000 + 9000 - 5500,
      grossProfitCents: 26500 - 19500,
      grossMarginBps: 2642, // 7,000 / 26,500
    });
    expect(d.paymentMix).toEqual([
      { method: 'CASH', amountCents: 22500 - 8000 },
      { method: 'MPESA', amountCents: 12000 },
      { method: 'CARD', amountCents: 0 },
    ]);
    expect(d.paymentMix.reduce((s: number, m: any) => s + m.amountCents, 0)).toBe(d.netSalesCents);
    expect(d.drawers).toEqual([expect.objectContaining({ registerCode: 'T1', cashier: 'Alice', expectedCents: 500000 + 22500 - 8000 })]);
    expect(d.recentSales).toHaveLength(2);
    expect(d.exceptions).toEqual([expect.objectContaining({ name: 'Alice', current: expect.objectContaining({ refunds: 1, refundCents: 8000 }) })]);
    expect(d.alerts.unacknowledged.HIGH).toBeGreaterThanOrEqual(1); // HIGH_VOID_RATE: 8,000 > 2% of 34,500
  });

  it('accepts a custom range and rejects nonsense ranges', async () => {
    const tomorrow = new Date(Date.now() + 86400_000).toISOString();
    const later = new Date(Date.now() + 2 * 86400_000).toISOString();
    const empty = await rpc(db, f.owner, 'owner_dashboard_today', { from: tomorrow, to: later });
    expect(empty).toMatchObject({ grossSalesCents: 0, netSalesCents: 0, salesCount: 0, grossMarginBps: null });
    await expect(rpc(db, f.owner, 'owner_dashboard_today', { from: later, to: tomorrow })).rejects.toThrow('INVALID_INPUT');
    await expect(rpc(db, f.owner, 'owner_dashboard_today', { from: 'yesterday' })).rejects.toThrow('INVALID_INPUT');
  });
});

describe('audit log hash chain', () => {
  let db: Db;
  let f: Fixture;

  beforeAll(async () => {
    db = await createDb();
    f = await seedStore(db);
    const shift = await openShift(db, f.alice, f.t1);
    const s = await sell(db, f.alice, shift, [{ productId: f.products.soda, qty: 1 }], [{ method: 'CASH', tenderedCents: 8000 }]);
    const req = { shiftId: shift, action: 'VOID', saleId: s.saleId, refundMethod: 'CASH', reasonCode: 'DUPLICATE_SCAN' };
    const approvalId = await approveAtTill(db, f.alice, req, f.ownerPin);
    await rpc(db, f.alice, 'reverse_sale', { ...req, kind: 'VOID', approvalId });
    await rpc(db, f.alice, 'record_cash_movement', { shiftId: shift, kind: 'DROP', amountCents: 100000, reasonCode: 'SAFE_DROP' });
    await rpc(db, f.alice, 'commit_close_count', { shiftId: shift, denominations: denoms(4000) });
  });

  it('records every action with actor, and the chain verifies', async () => {
    const actions = (await sql(db, `select distinct action from public.audit_log`)).map((r) => r.action).sort();
    for (const a of ['open_shift', 'complete_sale', 'request_approval', 'approve_with_pin', 'reverse_sale', 'record_cash_movement', 'commit_close_count']) {
      expect(actions).toContain(a);
    }
    const [{ n }] = await sql(db, `select count(*)::int as n from public.audit_log where action = 'complete_sale' and actor_id = $1`, [f.alice.id]);
    expect(n).toBe(1);
    const [{ r }] = await sql(db, `select public._verify_audit_chain() as r`);
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(10);
    // The chain links each row to the previous row's hash.
    const rows = await sql(db, `select prev_hash, row_hash from public.audit_log order by id`);
    expect(rows[0].prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash);
  });

  it('detects tampering by someone who bypasses the triggers (superuser)', async () => {
    const [victim] = await sql(db, `select id from public.audit_log where action = 'complete_sale'`);
    await sql(db, `alter table public.audit_log disable trigger audit_log_append_only`);
    await sql(db, `update public.audit_log set after = jsonb_set(after, '{totalCents}', '1') where id = $1`, [victim.id]);
    await sql(db, `alter table public.audit_log enable trigger audit_log_append_only`);
    const [{ r }] = await sql(db, `select public._verify_audit_chain() as r`);
    expect(r).toMatchObject({ ok: false, brokenAtId: victim.id });
    const [{ r: job }] = await sqlAs(db, 'service_role', { role: 'service_role' }, `select public.cron_integrity_checks() as r`);
    expect(job.auditChain.ok).toBe(false);
    const alerts = await sql(db, `select type, severity from public.alerts where type = 'INTEGRITY_AUDIT'`);
    expect(alerts).toEqual([{ type: 'INTEGRITY_AUDIT', severity: 'HIGH' }]);
    const pending = (await sqlAs(db, 'service_role', { role: 'service_role' }, `select public.cron_pending_notifications() as r`))[0].r;
    expect(pending.map((p: any) => p.type)).toContain('INTEGRITY_AUDIT');
  });
});
