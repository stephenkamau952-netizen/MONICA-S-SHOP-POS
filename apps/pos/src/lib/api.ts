import { ERRORS, isErrorCode, type ErrorCode, type RouteInput, type RoutePath } from '@shop/shared';
import { sb } from './supabase.ts';

export type ClientErrorCode = ErrorCode | 'NETWORK';

export class ApiError extends Error {
  constructor(
    public code: ClientErrorCode,
    message: string,
    public detail?: string,
    public data: Record<string, unknown> = {},
    public status = 0,
  ) {
    super(message);
  }
}

async function accessToken(): Promise<string> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('NOT_AUTHENTICATED', ERRORS.NOT_AUTHENTICATED.message);
  return token;
}

/** Every write: POST /api/<path> through the Worker. */
export async function post<P extends RoutePath, R = any>(path: P, body: RouteInput<P>): Promise<R> {
  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('NETWORK', 'No connection. Nothing was saved; try again when the connection is back.');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = isErrorCode(json?.error) ? json!.error : res.status >= 500 ? 'UPSTREAM_ERROR' : 'INTERNAL';
    throw new ApiError(code, (json?.message as string) ?? ERRORS[code].message,
      (json?.detail as string) || undefined, json ?? {}, res.status);
  }
  return json as R;
}

/** Reads go straight to Supabase (RLS + owner checks in the database). */
export async function read<T = any>(fn: string, p?: Record<string, unknown>): Promise<T> {
  const { data, error } = p === undefined ? await sb().rpc(fn) : await sb().rpc(fn, { p });
  if (error) {
    const code: ErrorCode = isErrorCode(error.message) ? error.message
      : error.code === '42501' ? 'FORBIDDEN'
      : error.code === 'PGRST301' || error.code === 'PGRST303' ? 'NOT_AUTHENTICATED'
      : 'INTERNAL';
    if (code === 'INTERNAL' && /fetch|network/i.test(error.message)) {
      throw new ApiError('NETWORK', 'No connection.');
    }
    throw new ApiError(code, ERRORS[code].message, error.details || undefined);
  }
  return data as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.detail ? `${e.message} (${e.detail})` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const newId = () => crypto.randomUUID();
