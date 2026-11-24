import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Invite and password-reset emails land here with "#...&type=invite" or
 * "type=recovery". supabase-js consumes the hash when it starts, so it is read
 * once at load: the user must then choose a password before using the app.
 */
let pendingPasswordSetup: 'invite' | 'recovery' | null = (() => {
  const m = /(?:^|[#&?])type=(invite|recovery)(?:&|$)/.exec(window.location.hash + window.location.search);
  return (m?.[1] as 'invite' | 'recovery' | undefined) ?? null;
})();

export const passwordSetupNeeded = () => pendingPasswordSetup;
export function passwordSetupDone() {
  pendingPasswordSetup = null;
}

/**
 * The Supabase URL and publishable key come from the Worker (/api/config), so
 * wrangler.jsonc is the single place they are configured. Both are public.
 */
export async function initSupabase(): Promise<SupabaseClient> {
  if (client) return client;
  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load configuration (HTTP ${res.status})`);
  const cfg = (await res.json()) as { supabaseUrl: string; supabasePublishableKey: string };
  if (!cfg.supabaseUrl || !cfg.supabasePublishableKey || cfg.supabaseUrl.includes('YOUR-PROJECT-REF')) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in wrangler.jsonc.');
  }
  client = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export function sb(): SupabaseClient {
  if (!client) throw new Error('Supabase client used before initSupabase()');
  return client;
}

/** Private Realtime topic the database broadcasts owner events on (PRD §7). */
export function ownerTopic(storeId: string): string {
  return `store:${storeId}:owner`;
}
