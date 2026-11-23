-- =============================================================================
-- Monica's Shop POS — 1/6 schema
--
-- Conventions
--   * Money is bigint cents (KES). Weighted-average unit costs are numeric(18,4)
--     cents because an average is not a whole number of cents.
--   * Timestamps are timestamptz defaulting to now(); clients never send them.
--   * Every table carries store_id so a second shop needs no migration.
--   * Ledger tables are append-only (see 2/6 guards). Corrections are new rows.
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Store, settings, staff, registers
-- ---------------------------------------------------------------------------
create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  currency    text not null default 'KES' check (currency = 'KES'),
  timezone    text not null default 'Africa/Nairobi',
  created_at  timestamptz not null default now()
);

create table public.store_settings (
  store_id                     uuid primary key references public.stores (id),
  variance_threshold_cents     bigint  not null default 20000 check (variance_threshold_cents between 0 and 100000000),
  stale_shift_hours            integer not null default 14    check (stale_shift_hours between 1 and 72),
  allow_negative_stock         boolean not null default false,
  refund_window_days           integer not null default 7     check (refund_window_days between 0 and 365),
  void_count_threshold         integer not null default 3     check (void_count_threshold between 0 and 1000),
  void_rate_bps                integer not null default 200   check (void_rate_bps between 0 and 10000),
  override_batch_threshold     integer not null default 5     check (override_batch_threshold between 0 and 1000),
  cart_line_removal_threshold  integer not null default 5     check (cart_line_removal_threshold between 0 and 1000),
  cart_cancel_threshold        integer not null default 2     check (cart_cancel_threshold between 0 and 1000),
  till_idle_lock_seconds       integer not null default 120   check (till_idle_lock_seconds between 30 and 3600),
  approval_ttl_seconds         integer not null default 120   check (approval_ttl_seconds between 30 and 600),
  updated_at                   timestamptz not null default now(),
  updated_by                   uuid
);

create table public.profiles (
  id            uuid primary key references auth.users (id),
  store_id      uuid not null references public.stores (id),
  role          text not null check (role in ('OWNER', 'CASHIER')),
  display_name  text not null check (length(btrim(display_name)) between 1 and 60),
  pin_hash      text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index profiles_store_idx on public.profiles (store_id);

create table public.registers (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id),
  code             text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  name             text not null check (length(btrim(name)) between 1 and 60),
  float_cents      bigint not null default 0 check (float_cents between 0 and 100000000),
  next_receipt_no  bigint not null default 1 check (next_receipt_no > 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (store_id, code)
);

-- ---------------------------------------------------------------------------
-- Catalogue and cost (cost tables are owner-only)
-- ---------------------------------------------------------------------------
create table public.products (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores (id),
  sku            text not null check (sku ~ '^[A-Za-z0-9._-]{1,40}$'),
  barcode        text check (barcode ~ '^[0-9A-Za-z-]{4,64}$'),
  name           text not null check (length(btrim(name)) between 1 and 120),
  price_cents    bigint not null check (price_cents between 0 and 100000000),
  reorder_level  integer not null default 0 check (reorder_level between 0 and 1000000),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (store_id, sku),
  unique (store_id, barcode)
);

create table public.product_costs (
  product_id      uuid primary key references public.products (id),
  store_id        uuid not null references public.stores (id),
  avg_cost_cents  numeric(18, 4) not null default 0 check (avg_cost_cents >= 0),
  updated_at      timestamptz not null default now()
);

create table public.product_price_history (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id),
  product_id       uuid not null references public.products (id),
  old_price_cents  bigint,
  new_price_cents  bigint not null,
  changed_by       uuid references public.profiles (id),
  changed_at       timestamptz not null default now()
);
create index product_price_history_product_idx on public.product_price_history (product_id, changed_at);

-- ---------------------------------------------------------------------------
-- Shifts and cash
-- ---------------------------------------------------------------------------
create table public.shifts (
  id                            uuid primary key default gen_random_uuid(),
  store_id                      uuid not null references public.stores (id),
  register_id                   uuid not null references public.registers (id),
  cashier_id                    uuid not null references public.profiles (id),
  status                        text not null default 'OPEN'
                                check (status in ('OPEN', 'PENDING_COUNT', 'CLOSED_UNRECONCILED', 'CLOSED')),
  opened_at                     timestamptz not null default now(),
  opening_float_expected_cents  bigint not null check (opening_float_expected_cents >= 0),
  opening_float_counted_cents   bigint not null check (opening_float_counted_cents >= 0),
  forced_close_at               timestamptz,
  forced_close_by               uuid references public.profiles (id),
  forced_close_reason           text,
  closed_at                     timestamptz,
  closed_by                     uuid references public.profiles (id),
  expected_cash_cents           bigint,
  counted_cash_cents            bigint,
  variance_cents                bigint,
  variance_flagged              boolean not null default false,
  acknowledged_at               timestamptz,
  acknowledged_by               uuid references public.profiles (id),
  acknowledgement_note          text,
  check ((status in ('OPEN', 'PENDING_COUNT')) = (closed_at is null)),
  check (closed_at is null or (expected_cash_cents is not null and counted_cash_cents is not null and variance_cents is not null))
);
create unique index shifts_one_live_per_cashier  on public.shifts (cashier_id)  where status in ('OPEN', 'PENDING_COUNT');
create unique index shifts_one_live_per_register on public.shifts (register_id) where status in ('OPEN', 'PENDING_COUNT');
create index shifts_store_opened_idx on public.shifts (store_id, opened_at);

create table public.cash_counts (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id),
  shift_id        uuid not null references public.shifts (id),
  kind            text not null check (kind in ('OPENING', 'CLOSING', 'RECOUNT')),
  counted_by      uuid not null references public.profiles (id),
  n1000           integer not null default 0 check (n1000 between 0 and 100000),
  n500            integer not null default 0 check (n500  between 0 and 100000),
  n200            integer not null default 0 check (n200  between 0 and 100000),
  n100            integer not null default 0 check (n100  between 0 and 100000),
  n50             integer not null default 0 check (n50   between 0 and 100000),
  c20             integer not null default 0 check (c20   between 0 and 100000),
  c10             integer not null default 0 check (c10   between 0 and 100000),
  c5              integer not null default 0 check (c5    between 0 and 100000),
  c1              integer not null default 0 check (c1    between 0 and 100000),
  counted_cents   bigint generated always as (
                    (n1000::bigint * 1000 + n500::bigint * 500 + n200::bigint * 200 + n100::bigint * 100
                     + n50::bigint * 50 + c20::bigint * 20 + c10::bigint * 10 + c5::bigint * 5 + c1::bigint) * 100
                  ) stored,
  expected_cents  bigint,
  variance_cents  bigint,
  created_at      timestamptz not null default now()
);
create unique index cash_counts_one_opening on public.cash_counts (shift_id) where kind = 'OPENING';
create unique index cash_counts_one_closing on public.cash_counts (shift_id) where kind = 'CLOSING';

-- ---------------------------------------------------------------------------
-- Owner approvals: a request (append-only) and a single-use token
-- ---------------------------------------------------------------------------
create table public.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id),
  action        text not null check (action in ('PRICE_OVERRIDE', 'VOID', 'REFUND', 'NO_SALE', 'PAID_OUT')),
  requested_by  uuid not null references public.profiles (id),
  shift_id      uuid not null references public.shifts (id),
  register_id   uuid not null references public.registers (id),
  target_id     uuid not null,
  payload       jsonb not null,
  summary       text not null,
  reason_code   text not null,
  note          text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index approval_requests_store_idx on public.approval_requests (store_id, created_at);

create table public.approvals (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id),
  request_id    uuid not null unique references public.approval_requests (id),
  action        text not null,
  target_id     uuid not null,
  payload       jsonb not null,
  requested_by  uuid not null references public.profiles (id),
  approved_by   uuid not null references public.profiles (id),
  channel       text not null check (channel in ('TILL_PIN', 'DASHBOARD')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  check (approved_by <> requested_by)
);

create table public.approval_rejections (
  request_id   uuid primary key references public.approval_requests (id),
  store_id     uuid not null references public.stores (id),
  rejected_by  uuid not null references public.profiles (id),
  note         text,
  created_at   timestamptz not null default now()
);

create table public.cash_movements (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id),
  shift_id      uuid not null references public.shifts (id),
  register_id   uuid not null references public.registers (id),
  kind          text not null check (kind in ('FLOAT', 'DROP', 'PAID_OUT', 'PAID_IN', 'ADJUSTMENT', 'NO_SALE')),
  amount_cents  bigint not null,
  reason_code   text not null,
  note          text,
  actor_id      uuid not null references public.profiles (id),
  approved_by   uuid references public.profiles (id),
  approval_id   uuid unique references public.approvals (id),
  created_at    timestamptz not null default now(),
  check (case kind
           when 'ADJUSTMENT' then amount_cents <> 0
           when 'NO_SALE'    then amount_cents = 0
           when 'FLOAT'      then amount_cents >= 0
           else amount_cents > 0
         end),
  check (kind not in ('PAID_OUT', 'NO_SALE', 'ADJUSTMENT') or approved_by is not null)
);
create index cash_movements_shift_idx on public.cash_movements (shift_id);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create table public.sales (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id),
  register_id       uuid not null references public.registers (id),
  shift_id          uuid not null references public.shifts (id),
  cashier_id        uuid not null references public.profiles (id),
  idempotency_key   uuid not null unique,
  receipt_no        bigint not null,
  item_count        integer not null check (item_count > 0),
  list_total_cents  bigint not null check (list_total_cents >= 0),
  total_cents       bigint not null check (total_cents > 0),
  status            text not null default 'COMPLETED' check (status = 'COMPLETED'),
  created_at        timestamptz not null default now(),
  unique (register_id, receipt_no)
);
create index sales_shift_idx on public.sales (shift_id);
create index sales_store_created_idx on public.sales (store_id, created_at);

create table public.sale_lines (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores (id),
  sale_id               uuid not null references public.sales (id),
  shift_id              uuid not null references public.shifts (id),
  line_no               integer not null check (line_no > 0),
  product_id            uuid not null references public.products (id),
  product_name          text not null,
  qty                   integer not null check (qty between 1 and 999),
  list_price_cents      bigint not null check (list_price_cents >= 0),
  unit_price_cents      bigint not null check (unit_price_cents >= 0),
  line_total_cents      bigint not null,
  price_overridden      boolean not null default false,
  override_approved_by  uuid references public.profiles (id),
  approval_id           uuid unique references public.approvals (id),
  check (line_total_cents = unit_price_cents * qty),
  check (price_overridden = (unit_price_cents <> list_price_cents)),
  check (not price_overridden or override_approved_by is not null),
  unique (sale_id, line_no)
);
create index sale_lines_shift_idx on public.sale_lines (shift_id);
create index sale_lines_product_idx on public.sale_lines (product_id);

create table public.sale_line_costs (
  sale_line_id      uuid primary key references public.sale_lines (id),
  store_id          uuid not null references public.stores (id),
  sale_id           uuid not null references public.sales (id),
  product_id        uuid not null references public.products (id),
  unit_cost_cents   numeric(18, 4) not null check (unit_cost_cents >= 0),
  cost_total_cents  bigint not null check (cost_total_cents >= 0)
);
create index sale_line_costs_sale_idx on public.sale_line_costs (sale_id);

create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id),
  sale_id         uuid not null references public.sales (id),
  shift_id        uuid not null references public.shifts (id),
  seq             smallint not null check (seq between 1 and 4),
  method          text not null check (method in ('CASH', 'MPESA', 'CARD')),
  amount_cents    bigint not null check (amount_cents > 0),
  tendered_cents  bigint,
  change_cents    bigint,
  mpesa_code      text,
  card_ref        text,
  created_at      timestamptz not null default now(),
  unique (sale_id, seq),
  check (case method
           when 'CASH'  then tendered_cents is not null and change_cents is not null and change_cents >= 0
                             and tendered_cents = amount_cents + change_cents and mpesa_code is null and card_ref is null
           when 'MPESA' then mpesa_code ~ '^[A-Z0-9]{10}$' and tendered_cents is null and change_cents is null and card_ref is null
           when 'CARD'  then length(card_ref) between 4 and 32 and tendered_cents is null and change_cents is null and mpesa_code is null
         end)
);
create unique index payments_mpesa_code_unique on public.payments (mpesa_code) where mpesa_code is not null;
create index payments_shift_idx on public.payments (shift_id);
create index payments_sale_idx on public.payments (sale_id);

create table public.sale_reversals (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id),
  original_sale_id  uuid not null references public.sales (id),
  kind              text not null check (kind in ('VOID', 'REFUND')),
  shift_id          uuid not null references public.shifts (id),
  register_id       uuid not null references public.registers (id),
  requested_by      uuid not null references public.profiles (id),
  approved_by       uuid not null references public.profiles (id),
  approval_id       uuid unique references public.approvals (id),
  reason_code       text not null check (reason_code in ('CUSTOMER_RETURN', 'WRONG_ITEM', 'DAMAGED', 'PRICE_ERROR', 'DUPLICATE_SCAN', 'OTHER')),
  note              text,
  refund_method     text not null check (refund_method in ('CASH', 'MPESA', 'CARD')),
  refund_ref        text,
  amount_cents      bigint not null check (amount_cents > 0),
  created_at        timestamptz not null default now(),
  check (reason_code <> 'OTHER' or length(btrim(coalesce(note, ''))) > 0),
  check (case refund_method
           when 'CASH'  then refund_ref is null
           when 'MPESA' then refund_ref ~ '^[A-Z0-9]{10}$'
           when 'CARD'  then length(refund_ref) between 4 and 32
         end)
);
create unique index sale_reversals_one_void on public.sale_reversals (original_sale_id) where kind = 'VOID';
create unique index sale_reversals_mpesa_ref_unique on public.sale_reversals (refund_ref) where refund_method = 'MPESA';
create index sale_reversals_shift_idx on public.sale_reversals (shift_id);
create index sale_reversals_store_created_idx on public.sale_reversals (store_id, created_at);
create index sale_reversals_sale_idx on public.sale_reversals (original_sale_id);

create table public.sale_reversal_lines (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id),
  reversal_id   uuid not null references public.sale_reversals (id),
  sale_line_id  uuid not null references public.sale_lines (id),
  product_id    uuid not null references public.products (id),
  qty           integer not null check (qty > 0),
  amount_cents  bigint not null check (amount_cents >= 0),
  restocked     boolean not null
);
create index sale_reversal_lines_line_idx on public.sale_reversal_lines (sale_line_id);
create index sale_reversal_lines_reversal_idx on public.sale_reversal_lines (reversal_id);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
create table public.stock_movements (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id),
  product_id       uuid not null references public.products (id),
  qty_delta        integer not null check (qty_delta <> 0),
  type             text not null check (type in ('SALE', 'REFUND', 'VOID', 'RECEIVE', 'ADJUST', 'DAMAGED', 'COUNT_VARIANCE', 'TRANSFER')),
  reason_code      text not null,
  ref_type         text,
  ref_id           uuid,
  actor_id         uuid not null references public.profiles (id),
  unit_cost_cents  numeric(18, 4),
  supplier         text,
  note             text,
  created_at       timestamptz not null default now(),
  check (type <> 'RECEIVE' or (qty_delta > 0 and unit_cost_cents is not null and supplier is not null)),
  check (type not in ('SALE', 'DAMAGED') or qty_delta < 0),
  check (type not in ('REFUND', 'VOID') or qty_delta > 0)
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at);
create index stock_movements_store_created_idx on public.stock_movements (store_id, created_at);

create table public.stock_levels (
  product_id            uuid primary key references public.products (id),
  store_id              uuid not null references public.stores (id),
  on_hand               integer not null default 0,
  low_stock_alert_open  boolean not null default false,
  updated_at            timestamptz not null default now()
);

create table public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id),
  status       text not null default 'OPEN' check (status in ('OPEN', 'POSTED', 'CANCELLED')),
  assigned_to  uuid references public.profiles (id),
  note         text,
  opened_by    uuid not null references public.profiles (id),
  opened_at    timestamptz not null default now(),
  closed_by    uuid references public.profiles (id),
  closed_at    timestamptz,
  check ((status = 'OPEN') = (closed_at is null))
);
create unique index stock_counts_one_open_per_store on public.stock_counts (store_id) where status = 'OPEN';

create table public.stock_count_items (
  count_id    uuid not null references public.stock_counts (id),
  product_id  uuid not null references public.products (id),
  store_id    uuid not null references public.stores (id),
  primary key (count_id, product_id)
);

create table public.stock_count_lines (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id),
  count_id     uuid not null,
  product_id   uuid not null,
  counted_qty  integer not null check (counted_qty between 0 and 1000000),
  system_qty   integer not null,
  counted_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  foreign key (count_id, product_id) references public.stock_count_items (count_id, product_id)
);
create index stock_count_lines_count_idx on public.stock_count_lines (count_id, product_id, created_at);

-- ---------------------------------------------------------------------------
-- Cart audit, alerts, PIN attempts, audit log
-- ---------------------------------------------------------------------------
create table public.cart_events (
  id                uuid primary key default gen_random_uuid(),
  event_key         uuid not null unique,
  store_id          uuid not null references public.stores (id),
  shift_id          uuid not null references public.shifts (id),
  register_id       uuid not null references public.registers (id),
  cashier_id        uuid not null references public.profiles (id),
  cart_key          uuid not null,
  kind              text not null check (kind in ('LINE_REMOVED', 'QTY_REDUCED', 'CART_CANCELLED')),
  product_id        uuid references public.products (id),
  qty               integer not null check (qty between 0 and 200000),
  unit_price_cents  bigint,
  lines             jsonb,
  created_at        timestamptz not null default now(),
  check (kind = 'CART_CANCELLED' or (product_id is not null and qty > 0))
);
create index cart_events_shift_idx on public.cart_events (shift_id);
create index cart_events_store_created_idx on public.cart_events (store_id, created_at);

create table public.alerts (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id),
  type             text not null check (type in (
                     'CASH_VARIANCE', 'HIGH_VOID_RATE', 'PRICE_OVERRIDE', 'CART_DELETIONS', 'NO_SALE_OPEN',
                     'OPENING_VARIANCE', 'STALE_SHIFT', 'NEGATIVE_STOCK', 'LOW_STOCK', 'PIN_LOCKOUT',
                     'INTEGRITY_STOCK', 'INTEGRITY_AUDIT', 'INTEGRITY_SHIFT')),
  severity         text not null check (severity in ('HIGH', 'MEDIUM', 'LOW')),
  subject          text not null,
  shift_id         uuid references public.shifts (id),
  user_id          uuid references public.profiles (id),
  ref_id           uuid,
  payload          jsonb not null default '{}'::jsonb,
  dedupe_key       text,
  created_at       timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references public.profiles (id),
  ack_note         text
);
create unique index alerts_dedupe_key_unique on public.alerts (dedupe_key) where dedupe_key is not null;
create index alerts_store_created_idx on public.alerts (store_id, created_at);
create index alerts_unacknowledged_idx on public.alerts (store_id) where acknowledged_at is null;

create table public.alert_notifications (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id),
  alert_id    uuid not null references public.alerts (id),
  channel     text not null check (length(channel) between 1 and 40),
  status      text not null check (status in ('SENT', 'FAILED', 'SKIPPED')),
  detail      text,
  created_at  timestamptz not null default now()
);
create index alert_notifications_alert_idx on public.alert_notifications (alert_id);

create table public.pin_attempts (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id),
  register_id         uuid references public.registers (id),
  kind                text not null check (kind in ('OWNER_APPROVAL', 'TILL_UNLOCK')),
  actor_id            uuid not null references public.profiles (id),
  matched_profile_id  uuid references public.profiles (id),
  success             boolean not null,
  created_at          timestamptz not null default now()
);
create index pin_attempts_register_idx on public.pin_attempts (register_id, kind, created_at);
create index pin_attempts_actor_idx on public.pin_attempts (actor_id, kind, created_at);

create table public.pin_lockouts (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id),
  register_id   uuid references public.registers (id),
  actor_id      uuid references public.profiles (id),
  kind          text not null check (kind in ('OWNER_APPROVAL', 'TILL_UNLOCK')),
  locked_until  timestamptz not null,
  created_at    timestamptz not null default now()
);
create index pin_lockouts_register_idx on public.pin_lockouts (register_id, kind, locked_until);
create index pin_lockouts_actor_idx on public.pin_lockouts (actor_id, kind, locked_until);

create table public.audit_log (
  id           bigint generated always as identity primary key,
  store_id     uuid,
  actor_id     uuid,
  action       text not null,
  target_type  text,
  target_id    text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now(),
  prev_hash    text not null,
  row_hash     text not null unique
);
create index audit_log_store_created_idx on public.audit_log (store_id, created_at);
