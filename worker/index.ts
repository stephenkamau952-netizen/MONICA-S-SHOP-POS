// Cloudflare Worker: serves the POS/dashboard static assets and the /api/* write
// path. Every write is: size check -> JWT check -> rate limit -> Zod parse ->
// Postgres RPC with the user's own JWT (so auth.uid() and RLS always apply).
import { Hono, type Context } from 'hono';
import { ERRORS, ROUTES, isErrorCode, type ErrorCode, type RouteDef } from '@shop/shared';
import { AuthError, verifySupabaseJwt } from './auth.ts';
import { callRpc, type FetchLike } from './supabase.ts';
import { runScheduled } from './cron.ts';
import type { Env } from './env.ts';

export type { Env } from './env.ts';

const MAX_BODY_BYTES = 64 * 1024;
const ROUTE_TABLE: Record<string, RouteDef> = ROUTES;

/** RPCs that report a PIN failure as {ok:false,error} (so the attempt is kept). */
const PIN_RESULT_ROUTES = new Set(['approvals/pin', 'till/unlock']);

type AppEnv = { Bindings: Env };

function errorBody(code: ErrorCode, extra: Record<string, unknown> = {}) {
  return { error: code, message: ERRORS[code].message, ...extra };
}

function fail(c: Context<AppEnv>, code: ErrorCode, extra: Record<string, unknown> = {}) {
  return c.json(errorBody(code, extra), ERRORS[code].status as 400);
}

export function createApp(fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Public, non-secret values the browser needs to talk to Supabase directly
  // (auth, reads under RLS, realtime). Keeps one source of truth: wrangler vars.
  app.get('/api/config', (c) =>
    c.json({ supabaseUrl: c.env.SUPABASE_URL, supabasePublishableKey: c.env.SUPABASE_PUBLISHABLE_KEY }));

  app.post('/api/*', async (c) => {
    const path = c.req.path.replace(/^\/api\//, '');
    const route = Object.prototype.hasOwnProperty.call(ROUTE_TABLE, path) ? ROUTE_TABLE[path] : undefined;
    if (!route) return fail(c, 'NOT_FOUND');

    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return fail(c, 'INVALID_INPUT', { detail: 'Content-Type must be application/json' });
    }
    const declared = Number(c.req.header('Content-Length') ?? '0');
    if (declared > MAX_BODY_BYTES) return fail(c, 'INVALID_INPUT', { detail: 'request body too large' });

    // Authenticate before parsing anything else.
    let user;
    try {
      user = await verifySupabaseJwt(c.req.header('Authorization'), c.env);
    } catch (e) {
      if (e instanceof AuthError) return fail(c, 'NOT_AUTHENTICATED');
      throw e;
    }

    const limiter = route.limiter === 'PIN' ? c.env.PIN_LIMITER : c.env.API_LIMITER;
    if (limiter) {
      const { success } = await limiter.limit({ key: `${route.limiter}:${user.sub}` });
      if (!success) return fail(c, 'RATE_LIMITED');
    }

    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(c, 'INVALID_INPUT', { detail: 'request body too large' });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(c, 'INVALID_INPUT', { detail: 'body is not valid JSON' });
    }
    const parsed = route.schema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 'INVALID_INPUT', {
        detail: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }

    const started = Date.now();
    const result = await callRpc(c.env, { userJwt: user.token }, route.rpc, parsed.data, fetchImpl);
    const ms = Date.now() - started;

    if (result.ok) {
      console.log(JSON.stringify({ rpc: route.rpc, ok: true, ms }));
      const data = result.data as Record<string, unknown> | null;
      if (PIN_RESULT_ROUTES.has(path) && data && data.ok === false && isErrorCode(data.error)) {
        const { error, ...rest } = data;
        return fail(c, error as ErrorCode, rest);
      }
      return c.json(data);
    }

    // Map database errors. RPCs raise P0001 with a stable code as the message.
    let code: ErrorCode;
    if (result.code === 'P0001' && isErrorCode(result.message)) code = result.message;
    else if (result.code === '42501') code = 'FORBIDDEN';
    else if (result.status === 401 || result.code === 'PGRST301' || result.code === 'PGRST303') code = 'NOT_AUTHENTICATED';
    else if (result.status >= 500 || result.status === 0) code = 'UPSTREAM_ERROR';
    else code = 'INTERNAL';
    console.log(JSON.stringify({ rpc: route.rpc, ok: false, ms, code, pg: result.code, status: result.status,
                                 message: code === 'INTERNAL' || code === 'UPSTREAM_ERROR' ? result.message : undefined }));
    return fail(c, code, result.details ? { detail: result.details } : {});
  });

  app.all('/api/*', (c) => fail(c, 'NOT_FOUND'));

  // Non-API paths are normally served by static assets before the Worker runs;
  // this fallback keeps behaviour correct if routing changes.
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

  app.onError((err, c) => {
    console.error(JSON.stringify({ error: 'unhandled', message: err.message }));
    return c.json(errorBody('INTERNAL'), 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: { cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runScheduled(controller.cron, env).then((r) => console.log(JSON.stringify({ job: 'scheduled', ...r }))));
  },
};
