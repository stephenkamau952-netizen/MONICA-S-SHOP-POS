import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { createApp } from './index.ts';
import { setJwksForIssuer } from './auth.ts';
import { runScheduled } from './cron.ts';
import type { Env, Limiter } from './env.ts';

const randomUUID = () => crypto.randomUUID();
const SUPABASE_URL = 'https://proj.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

type Call = { url: string; init: RequestInit };

function mockFetch(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function env(extra: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ...extra,
  };
}

let token: string;
let otherIssuerToken: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
  setJwksForIssuer(ISSUER, createLocalJWKSet({ keys: [jwk] }));
  const sign = (iss: string) =>
    new SignJWT({ role: 'authenticated', aal: 'aal1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(randomUUID()).setIssuer(iss).setAudience('authenticated')
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  token = await sign(ISSUER);
  otherIssuerToken = await sign('https://evil.example/auth/v1');
});

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown, e: Env, auth = `Bearer ${token}`) {
  return app.request(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, e);
}

const validSale = () => ({
  idempotencyKey: randomUUID(),
  shiftId: randomUUID(),
  lines: [{ productId: randomUUID(), qty: 2 }],
  payments: [{ method: 'CASH', tenderedCents: 20000 }],
});

describe('worker /api', () => {
  it('rejects requests without a valid Supabase token', async () => {
    const m = mockFetch(() => json(200, {}));
    const app = createApp(m.fn);
    expect((await post(app, 'sales', validSale(), env(), '')).status).toBe(401);
    expect((await post(app, 'sales', validSale(), env(), 'Bearer not.a.jwt')).status).toBe(401);
    expect((await post(app, 'sales', validSale(), env(), `Bearer ${otherIssuerToken}`)).status).toBe(401);
    const hs = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID()).setIssuer(ISSUER).setAudience('authenticated').setExpirationTime('5m')
      .sign(new TextEncoder().encode('legacy-secret-legacy-secret-legacy'));
    expect((await post(app, 'sales', validSale(), env(), `Bearer ${hs}`)).status).toBe(401);
    expect((await post(app, 'sales', validSale(), env({ SUPABASE_JWT_SECRET: 'legacy-secret-legacy-secret-legacy' }), `Bearer ${hs}`)).status).toBe(200);
    expect(m.calls).toHaveLength(1);
  });

  it('validates the body with the shared Zod schema before calling the database', async () => {
    const m = mockFetch(() => json(200, {}));
    const app = createApp(m.fn);
    const bad = await post(app, 'sales', { ...validSale(), lines: [{ productId: randomUUID(), qty: 1.5 }] }, env());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'INVALID_INPUT', detail: expect.stringContaining('lines.0.qty') });
    expect((await post(app, 'sales', '{not json', env())).status).toBe(400);
    const twoCash = { ...validSale(), payments: [{ method: 'CASH', tenderedCents: 1 }, { method: 'CASH', tenderedCents: 1 }] };
    expect((await post(app, 'sales', twoCash, env())).status).toBe(400);
    expect((await post(app, 'reversals', { shiftId: randomUUID(), saleId: randomUUID(), kind: 'REFUND', refundMethod: 'MPESA', reasonCode: 'WRONG_ITEM' }, env())).status).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it('calls the RPC with the publishable key and the user JWT, and never caches', async () => {
    const m = mockFetch(() => json(200, { saleId: 'x', totalCents: 16000 }));
    const app = createApp(m.fn);
    const sale = validSale();
    const res = await post(app, 'sales', { ...sale, extra: 'stripped' }, env());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ saleId: 'x', totalCents: 16000 });
    expect(m.calls[0]!.url).toBe(`${SUPABASE_URL}/rest/v1/rpc/complete_sale`);
    const headers = m.calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('sb_publishable_test');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(m.calls[0]!.init.body as string)).toEqual({ p: sale });
  });

  it('maps database error codes to HTTP statuses', async () => {
    // [database response status, body, expected Worker status, expected code]
    const cases: [number, unknown, number, string][] = [
      [400, { code: 'P0001', message: 'SHIFT_NOT_OPEN', details: '' }, 409, 'SHIFT_NOT_OPEN'],
      [400, { code: 'P0001', message: 'APPROVAL_EXPIRED', details: '' }, 410, 'APPROVAL_EXPIRED'],
      [400, { code: 'P0001', message: 'INSUFFICIENT_STOCK', details: 'Rice 2kg: 0 in stock' }, 409, 'INSUFFICIENT_STOCK'],
      [401, { code: '42501', message: 'permission denied for function complete_sale' }, 403, 'FORBIDDEN'],
      [401, { code: 'PGRST301', message: 'JWT expired' }, 401, 'NOT_AUTHENTICATED'],
      [500, { code: 'XX000', message: 'boom' }, 502, 'UPSTREAM_ERROR'],
    ];
    for (const [dbStatus, body, status, code] of cases) {
      const app = createApp(mockFetch(() => json(dbStatus, body)).fn);
      const res = await post(app, 'sales', validSale(), env());
      expect(res.status, code).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
    const down = createApp(async () => { throw new Error('ECONNRESET'); });
    expect((await post(down, 'sales', validSale(), env())).status).toBe(502);
  });

  it('turns recorded PIN failures into 401 / 423 without losing the attempt', async () => {
    for (const [data, status] of [[{ ok: false, error: 'BAD_PIN', attemptsLeft: 3 }, 401], [{ ok: false, error: 'PIN_LOCKED', lockedUntil: 'x' }, 423]] as const) {
      const app = createApp(mockFetch(() => json(200, data)).fn);
      const res = await post(app, 'approvals/pin', { requestId: randomUUID(), pin: '123987' }, env());
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: data.error });
    }
    const ok = createApp(mockFetch(() => json(200, { ok: true, approvalId: 'a' })).fn);
    expect((await post(ok, 'approvals/pin', { requestId: randomUUID(), pin: '123987' }, env())).status).toBe(200);
  });

  it('rate-limits per user and per route group', async () => {
    const keys: string[] = [];
    const deny: Limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    const allow: Limiter = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
    const m = mockFetch(() => json(200, { ok: true }));
    const app = createApp(m.fn);
    const res = await post(app, 'approvals/pin', { requestId: randomUUID(), pin: '123987' }, env({ PIN_LIMITER: deny, API_LIMITER: allow }));
    expect(res.status).toBe(429);
    expect((await post(app, 'sales', validSale(), env({ PIN_LIMITER: deny, API_LIMITER: allow }))).status).toBe(200);
    expect(keys[0]).toMatch(/^PIN:/);
    expect(keys[1]).toMatch(/^API:/);
  });

  it('serves config and 404s unknown routes', async () => {
    const app = createApp(mockFetch(() => json(200, {})).fn);
    const cfg = await app.request('/api/config', {}, env());
    expect(await cfg.json()).toEqual({ supabaseUrl: SUPABASE_URL, supabasePublishableKey: 'sb_publishable_test' });
    expect((await post(app, 'nope', {}, env())).status).toBe(404);
    expect((await post(app, '__proto__', {}, env())).status).toBe(404);
    expect((await app.request('/api/sales', { method: 'GET' }, env())).status).toBe(404);
  });
});

describe('scheduled jobs', () => {
  it('uses the secret key only as apikey (never as a Bearer token) and fans out alerts', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/rpc/cron_stale_shifts')) return json(200, { staleAlerts: 0 });
      if (call.url.endsWith('/rpc/cron_pending_notifications')) {
        return json(200, [{ alertId: 'a1', storeName: 'Shop', type: 'CASH_VARIANCE', severity: 'HIGH', subject: 'T1 short', createdAt: 'x' }]);
      }
      if (call.url === 'https://hooks.example/alert') return new Response('ok');
      return json(200, { ok: true });
    });
    const out = await runScheduled('*/15 * * * *', env({ ALERT_WEBHOOK_URL: 'https://hooks.example/alert' }), m.fn);
    expect(out.notifications).toEqual({ sent: 1, failed: 0 });
    const rpcCalls = m.calls.filter((c) => c.url.includes('/rest/v1/'));
    for (const c of rpcCalls) {
      const h = c.init.headers as Record<string, string>;
      expect(h.apikey).toBe('sb_secret_test');
      expect(h.Authorization).toBeUndefined();
    }
    const record = m.calls.find((c) => c.url.endsWith('/rpc/cron_record_notification'))!;
    expect(JSON.parse(record.init.body as string)).toEqual({ p: { alertId: 'a1', channel: 'webhook', status: 'SENT', detail: 'HTTP 200' } });
  });

  it('runs the nightly integrity job at midnight UTC', async () => {
    const m = mockFetch((call) => json(200, call.url.endsWith('cron_integrity_checks') ? { auditChain: { ok: true } } : []));
    const out = await runScheduled('0 0 * * *', env(), m.fn);
    expect(out.integrity).toEqual({ auditChain: { ok: true } });
    expect(m.calls.some((c) => c.url.endsWith('cron_stale_shifts'))).toBe(false);
  });
});
