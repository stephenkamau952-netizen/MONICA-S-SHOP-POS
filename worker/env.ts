/** Minimal shape of a Workers Rate Limiting binding. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Static assets (Vite build in ./dist) */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Plain vars (wrangler.jsonc) */
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Secrets (wrangler secret put ...) */
  SUPABASE_SECRET_KEY?: string;
  /** Only for projects still signing JWTs with the legacy HS256 secret. */
  SUPABASE_JWT_SECRET?: string;
  /** Optional owner-alert fan-out (SMS/WhatsApp provider to be chosen). */
  ALERT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_TOKEN?: string;
  /** Rate limiting bindings */
  API_LIMITER?: Limiter;
  PIN_LIMITER?: Limiter;
}
