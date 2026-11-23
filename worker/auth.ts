import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Env } from './env.ts';

export interface VerifiedUser {
  sub: string;
  token: string;
  aal: string | undefined;
}

export class AuthError extends Error {}

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** For tests: inject the key set used for asymmetric tokens. */
export function setJwksForIssuer(issuer: string, jwks: JWTVerifyGetKey) {
  jwksCache.set(issuer, jwks);
}

export function issuerFor(env: Pick<Env, 'SUPABASE_URL'>): string {
  return `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
}

/**
 * Verify a Supabase Auth access token. New projects sign with asymmetric keys
 * published at /auth/v1/.well-known/jwks.json; projects still on the legacy
 * HS256 secret need SUPABASE_JWT_SECRET.
 */
export async function verifySupabaseJwt(authorization: string | undefined, env: Env): Promise<VerifiedUser> {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(authorization ?? '');
  if (!m) throw new AuthError('missing bearer token');
  const token = m[1]!;
  const issuer = issuerFor(env);

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new AuthError('malformed token');
  }

  let payload: JWTPayload;
  try {
    if (alg === 'HS256') {
      if (!env.SUPABASE_JWT_SECRET) throw new AuthError('HS256 tokens are not accepted');
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), {
        issuer, audience: 'authenticated', algorithms: ['HS256'],
      }));
    } else {
      let jwks = jwksCache.get(issuer);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cacheMaxAge: 10 * 60 * 1000 });
        jwksCache.set(issuer, jwks);
      }
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'] }));
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError('invalid or expired token');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.role !== 'authenticated') {
    throw new AuthError('not a signed-in user token');
  }
  return { sub: payload.sub, token, aal: typeof payload.aal === 'string' ? payload.aal : undefined };
}
