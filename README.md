# Monica's Shop POS

Anti-theft retail point of sale with live owner analytics. Every shilling and every unit of stock is tied to a named
person, an open shift and a reason. Built from the PRD "Anti-Theft Retail POS & Owner Analytics" (20 Nov 2026).

| Part | Where | What it does |
|---|---|---|
| Database and ledger | `supabase/migrations/` | Tables, append-only guards, RLS, hash-chained audit log, every RPC (`complete_sale` etc.) |
| Database tests | `supabase/tests/` | 67 tests run against real Postgres (PGlite) covering every PRD rule |
| API | `worker/` | Cloudflare Worker (Hono): JWT check, rate limit, Zod validation, RPC call as the user; cron jobs |
| Shared contract | `packages/shared/` | Zod schemas, route table, error codes, reason codes, money helpers |
| Till and dashboard | `apps/pos/` | React + Vite + Tailwind. `/till` for cashiers, `/admin` for the owner |

## Live deployment

| | |
|---|---|
| App (till: `/till`, owner: `/admin`) | https://shop-pos.monicashop.workers.dev |
| Supabase project | `rjbgpwyikthelpmjuxnl` (eu-west-1), migrations 0100–0600 applied |
| Cloudflare Worker | `shop-pos` on account `Dukayamonica20@gmail.com's Account`, crons every 15 min and 00:00 UTC |
| Owner | dukayamonica20@gmail.com (invited; sets password, MFA and PIN on first sign-in) |

First sign-in for the owner: open the invite email → choose a password → scan the authenticator QR code → in the
dashboard go to **Staff → Set PIN** on your own name → **Settings → Tills** to set T1's opening float → **Products &
stock** to add products and receive opening stock.

## Run the checks locally

Needs Node 20.19 or newer.

```powershell
npm install
npm test            # database + worker tests
npm run typecheck   # all packages
npm run build       # builds the app into ./dist
npm run check:deploy  # build + wrangler dry-run (validates wrangler.jsonc and the Worker bundle)
```

> On this PC, Node is installed in `C:\Program Files\nodejs` but is not on PATH, which is also why the Wallaby
> extension reported "spawn node ENOENT". Add that folder to your user PATH (Windows Settings → "Edit environment
> variables for your account" → Path → New), then open a new terminal.

## Deploy (PRD §8.1)

1. **Domain first.** Cloudflare → Add a site (Free plan) → note the two nameservers. Namecheap → Domain List → Manage →
   Nameservers → Custom DNS → enter both → Save. Delegation can take 24–48 h.
2. **Supabase project.** Create it in the region closest to the shop.
   - Project Settings → API Keys: create a **publishable** key and a **secret** key (do not use the legacy anon /
     service_role keys; they stop working at the end of 2026).
   - Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
   - Authentication → Multi-Factor: enable **TOTP**.
   - Realtime → Settings: turn **off** "Allow public access" so only private channels work.
3. **Schema.** From this folder:
   ```powershell
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
4. **Owner account.** Authentication → Users → Invite user → the owner's email. Then open the SQL editor and run:
   ```sql
   select public.bootstrap_store('{"storeName":"Monica''s Shop","ownerEmail":"OWNER@EMAIL",
     "ownerName":"Monica","registerCode":"T1","registerName":"Till 1","floatCents":500000}'::jsonb);
   ```
   `floatCents` is the opening float in cents (500000 = KES 5,000). The owner sets their own PIN in the app
   (Staff → Set PIN), so it is never typed into SQL.
5. **Worker config.** In `wrangler.jsonc` set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Then:
   ```powershell
   npx wrangler login
   npx wrangler secret put SUPABASE_SECRET_KEY
   npm run deploy
   ```
   Optional: `npx wrangler secret put ALERT_WEBHOOK_URL` (and `ALERT_WEBHOOK_TOKEN`) to forward HIGH alerts to your SMS or
   WhatsApp provider. The Worker POSTs `{ "text": "...", "alert": {...} }`.
6. **Custom domains.** Workers → shop-pos → Settings → Domains & Routes → add `pos.<domain>` (tills) and
   `admin.<domain>` (owner). `pos.` opens the till and `admin.` opens the dashboard.
7. **TLS.** SSL/TLS → Full (strict); Always Use HTTPS on; minimum TLS 1.2; HSTS only after every hostname works on HTTPS.
8. **WAF.** Security → WAF → Rate limiting rules: 10 requests/minute per IP on `/api/approvals*` and `/api/till/unlock`.
   Optionally put `admin.<domain>` behind Cloudflare Access with only the owner's email allowed.
9. **CI.** Workers → shop-pos → Settings → Builds → connect the GitHub repo. Build command `npm run build`, deploy
   command `npx wrangler deploy`. Only `main` deploys to production; point preview builds at a Supabase branch.
10. **Smoke test on the real till** (step 10 / hour 21–23 of the PRD): scanner, receipt printer, drawer kick, then open
    a shift → sale → void with the owner PIN → blind close with a deliberate KES 500 shortage → check the CASH_VARIANCE
    alert on the owner's phone and the entries in the Audit log tab.

### Adding staff

Supabase → Authentication → Users → **Invite user**. Once they have accepted, the owner opens **Staff** in the
dashboard, assigns a role and sets a 6-digit PIN. Never share logins: attribution depends on it. Deactivate people
instead of deleting them (their history must stay).

### Till hardware

- **Scanner:** any USB keyboard-wedge scanner, set to send Enter after each code.
- **Receipt printer and drawer:** in the till's **Printer** dialog choose **ESC/POS over USB-serial** (Chrome or Edge;
  the printer must expose a COM port, as most 80 mm ESC/POS printers do with their virtual-COM driver). In this mode
  the app sends the drawer-kick pulse **only** for cash sales, change due, approved no-sales, drops, paid-ins/outs and
  cash refunds (FR-CO-7). The **browser print** mode works with any printer but cannot control the drawer: if the
  driver opens it on every print, it also opens for M-Pesa and card sales.
- Run the till browser full-screen, e.g. `chrome --kiosk --kiosk-printing https://pos.<domain>/till`.

## How the controls are enforced

- **Append-only ledger.** API roles have no INSERT/UPDATE/DELETE/TRUNCATE on any table. Triggers reject UPDATE and DELETE
  on every ledger table for **every** role, including the table owner and the secret key. Corrections are new rows
  (reversal, `ADJUSTMENT`, `COUNT_VARIANCE`).
- **Stock** changes only through `stock_movements`. A trigger maintains `stock_levels`, and direct writes are rejected
  whoever sends them. A sale's stock deduction is in the same transaction as its payment.
- **Blind close.** No API returns expected cash, cash-sales total or drawer balance to a cashier before their count
  commits. Those columns are not even selectable (column-level grants). The variance is computed in the database.
- **Approvals.** Single-use tokens bound to the action, target, exact payload, requester and shift, valid 120 s. Five
  wrong owner PINs lock approvals on that till for 15 minutes and raise PIN_LOCKOUT.
- **Owner MFA.** Every owner privilege (reads and writes) needs an MFA-verified session (`aal2`); an owner signed in
  without MFA has no owner powers.
- **Audit.** Every RPC writes a hash-chained `audit_log` row; a nightly job verifies the chain and alerts on any break.

## Where this build interprets or tightens the PRD

| Topic | Decision |
|---|---|
| Stock visibility | Cashiers cannot read `stock_levels` at all (stricter than "hidden during counts"). |
| Recounts (FR-SH-4) | The owner enters the recount. The cashier has already seen their variance by then, so a cashier recount would not be blind. |
| Approval storage | Two tables: `approval_requests` (append-only) and `approvals` (single-use token; only `consumed_at` is ever set). This supports both PIN-at-till and dashboard approval. |
| Refund lookup | A cashier can open another cashier's sale only by its exact receipt number (needed to refund it); the lookup is audited. |
| No-sale | Recorded as a `cash_movements` row of kind `NO_SALE` (amount 0) with approver and reason. |
| Damaged returns | Recorded as a `REFUND` (+qty) and a `DAMAGED` (−qty) movement, so the write-off is visible and stock is unchanged. |
| Staff invites | Done in the Supabase dashboard; roles are assigned in the app. The secret key is used only by scheduled jobs, as the PRD requires. |
| PINs | All PINs are 6 digits. Till-unlock PINs also lock after 5 failures. |
| Owner alert channel | Generic webhook until the SMS/WhatsApp provider is chosen (open question). |

## Known limits

- PGlite runs one connection, so the tests check the logic of "two tills selling the last unit" (the second is
  refused) but cannot exercise true concurrent locking. The RPCs lock product and stock rows in id order to prevent
  deadlocks, and `complete_sale` serialises retries on the idempotency key.
- A cashier can still add up their own receipts by hand. The blind count stops the system from telling them the
  expected total; it does not stop arithmetic.
- Online-only (v1): with no connection, sales are blocked and the current cart is kept for a retry with the same sale
  key, so a retry can never create a second sale.
- Open PRD questions still to decide: KRA eTIMS, M-Pesa Till vs Paybill (Daraja automation is v2), number of tills,
  threshold values, negative stock, expenses ledger for true net profit, refund window per category, alert provider.
