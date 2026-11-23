import type { Env } from './env.ts';

export type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message?: string; details?: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Call a Postgres function through PostgREST.
 *  - As a user: apikey = publishable key, Authorization = the user's JWT, so
 *    auth.uid() and RLS apply.
 *  - As a scheduled job: apikey = secret key only (new API keys are not JWTs
 *    and must not be sent as a Bearer token).
 */
export async function callRpc(
  env: Env,
  as: { userJwt: string } | { secret: true },
  fn: string,
  p: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<RpcResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if ('userJwt' in as) {
    headers.apikey = env.SUPABASE_PUBLISHABLE_KEY;
    headers.Authorization = `Bearer ${as.userJwt}`;
  } else {
    if (!env.SUPABASE_SECRET_KEY) return { ok: false, status: 500, message: 'SUPABASE_SECRET_KEY is not set' };
    headers.apikey = env.SUPABASE_SECRET_KEY;
  }

  let res: Response;
  try {
    res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(p === undefined ? {} : { p }),
    });
  } catch (e) {
    return { ok: false, status: 502, message: `network error: ${(e as Error).message}` };
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status >= 400 ? res.status : 502, message: 'non-JSON response from database' };
    }
  }
  if (res.ok) return { ok: true, data: body };
  const err = (body ?? {}) as { code?: string; message?: string; details?: string };
  return { ok: false, status: res.status, code: err.code, message: err.message, details: err.details };
}
