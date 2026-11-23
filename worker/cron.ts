import type { Env } from './env.ts';
import { callRpc, type FetchLike } from './supabase.ts';

interface PendingAlert {
  alertId: string;
  storeName: string;
  type: string;
  severity: string;
  subject: string;
  createdAt: string;
}

/**
 * Scheduled jobs (wrangler.jsonc triggers):
 *   every 15 minutes: stale-shift alerts + high-severity alert fan-out
 *   00:00 UTC daily:  integrity checks (stock = movements, audit hash chain, shifts)
 */
export async function runScheduled(cron: string, env: Env, fetchImpl: FetchLike = fetch): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { cron };
  if (!env.SUPABASE_SECRET_KEY) {
    console.error(JSON.stringify({ job: 'cron', error: 'SUPABASE_SECRET_KEY is not set' }));
    return { ...out, error: 'SUPABASE_SECRET_KEY is not set' };
  }
  const call = (fn: string, p?: unknown) => callRpc(env, { secret: true }, fn, p, fetchImpl);

  if (cron === '0 0 * * *') {
    const r = await call('cron_integrity_checks');
    out.integrity = r.ok ? r.data : r;
    // The head hash is logged every night so a later rewrite of the whole
    // chain can be compared against an independent record (Workers Logs).
    console.log(JSON.stringify({ job: 'integrity', result: out.integrity }));
  } else {
    const r = await call('cron_stale_shifts');
    out.stale = r.ok ? r.data : r;
  }

  out.notifications = await fanOutAlerts(env, call, fetchImpl);
  return out;
}

async function fanOutAlerts(
  env: Env,
  call: (fn: string, p?: unknown) => ReturnType<typeof callRpc>,
  fetchImpl: FetchLike,
): Promise<{ sent: number; failed: number; skipped?: string }> {
  if (!env.ALERT_WEBHOOK_URL) return { sent: 0, failed: 0, skipped: 'ALERT_WEBHOOK_URL not set' };
  const pending = await call('cron_pending_notifications');
  if (!pending.ok || !Array.isArray(pending.data)) {
    console.error(JSON.stringify({ job: 'alerts', error: pending }));
    return { sent: 0, failed: 0, skipped: 'could not read pending alerts' };
  }
  let sent = 0;
  let failed = 0;
  for (const a of pending.data as PendingAlert[]) {
    const text = `[${a.storeName}] ${a.severity} ${a.type}: ${a.subject}`;
    let status: 'SENT' | 'FAILED' = 'FAILED';
    let detail = '';
    try {
      const res = await fetchImpl(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.ALERT_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.ALERT_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ text, alert: a }),
      });
      status = res.ok ? 'SENT' : 'FAILED';
      detail = `HTTP ${res.status}`;
    } catch (e) {
      detail = (e as Error).message.slice(0, 200);
    }
    if (status === 'SENT') sent++; else failed++;
    await call('cron_record_notification', { alertId: a.alertId, channel: 'webhook', status, detail });
  }
  return { sent, failed };
}
