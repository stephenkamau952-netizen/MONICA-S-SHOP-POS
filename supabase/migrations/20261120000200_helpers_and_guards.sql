-- =============================================================================
-- Monica's Shop POS — 2/6 helpers and ledger guards
--
-- Every function uses search_path = '' and fully-qualified names.
-- Functions whose name starts with "_" are internal: no API role can execute
-- them (see 6/6 grants). They run inside SECURITY DEFINER RPCs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Errors: RPCs raise a stable machine code as the message (P0001).
-- The Worker and UI map these codes; see packages/shared/src/errors.ts.
-- ---------------------------------------------------------------------------
create or replace function public._err(p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = p_code, errcode = 'P0001', detail = coalesce(p_detail, '');
end;
$$;

-- ---------------------------------------------------------------------------
-- JSON input helpers. They reject wrong types instead of coercing them, so
-- 1.5 is never silently turned into 2 and "12" is never read as a number.
-- ---------------------------------------------------------------------------
create or replace function public._obj(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform public._err('INVALID_INPUT', 'request body must be a JSON object');
  end if;
end;
$$;

create or replace function public._j_uuid(p jsonb, k text, p_required boolean default true)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  s text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_required then perform public._err('INVALID_INPUT', k || ' is required'); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform public._err('INVALID_INPUT', k || ' must be a UUID');
  end if;
  s := v #>> '{}';
  if s !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform public._err('INVALID_INPUT', k || ' must be a UUID');
  end if;
  return s::uuid;
end;
$$;

create or replace function public._j_int(p jsonb, k text, p_min bigint, p_max bigint, p_required boolean default true)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  s text;
  n bigint;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_required then perform public._err('INVALID_INPUT', k || ' is required'); end if;
    return null;
  end if;
  s := v #>> '{}';
  if jsonb_typeof(v) <> 'number' or s !~ '^-?[0-9]{1,15}$' then
    perform public._err('INVALID_INPUT', k || ' must be a whole number');
  end if;
  n := s::bigint;
  if n < p_min or n > p_max then
    perform public._err('INVALID_INPUT', k || ' must be between ' || p_min || ' and ' || p_max);
  end if;
  return n;
end;
$$;

create or replace function public._j_text(p jsonb, k text, p_required boolean default true, p_max integer default 500)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> k;
  s text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_required then perform public._err('INVALID_INPUT', k || ' is required'); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform public._err('INVALID_INPUT', k || ' must be text');
  end if;
  s := btrim(v #>> '{}');
  if s = '' then
    if p_required then perform public._err('INVALID_INPUT', k || ' is required'); end if;
    return null;
  end if;
  if length(s) > p_max then
    perform public._err('INVALID_INPUT', k || ' must be at most ' || p_max || ' characters');
  end if;
  return s;
end;
$$;

create or replace function public._j_bool(p jsonb, k text, p_default boolean)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> k;
begin
  if v is null or jsonb_typeof(v) = 'null' then return p_default; end if;
  if jsonb_typeof(v) <> 'boolean' then
    perform public._err('INVALID_INPUT', k || ' must be true or false');
  end if;
  return (v #>> '{}')::boolean;
end;
$$;

create or replace function public._j_ts(p jsonb, k text, p_required boolean default true)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  s text := public._j_text(p, k, p_required, 40);
begin
  if s is null then return null; end if;
  if s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$' then
    perform public._err('INVALID_INPUT', k || ' must be an ISO-8601 timestamp with a time zone');
  end if;
  return s::timestamptz;
end;
$$;

-- Reason-code lists (mirrored in packages/shared/src/reasons.ts)
create or replace function public._reversal_reasons()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['CUSTOMER_RETURN', 'WRONG_ITEM', 'DAMAGED', 'PRICE_ERROR', 'DUPLICATE_SCAN', 'OTHER'] $$;

create or replace function public._cash_reasons()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['SAFE_DROP', 'SUPPLIER_PAYMENT', 'PETTY_EXPENSE', 'CHANGE_GIVEN', 'FLOAT_TOP_UP', 'OWNER_WITHDRAWAL', 'CORRECTION', 'OTHER'] $$;

create or replace function public._stock_reasons()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['FOUND', 'LOST', 'THEFT', 'EXPIRED', 'DAMAGED', 'CORRECTION', 'OTHER'] $$;

-- Validates a reason code against a list and enforces "OTHER needs a note".
create or replace function public._reason(p jsonb, p_allowed text[], p_note text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := public._j_text(p, 'reasonCode', true, 40);
begin
  if not (v = any (p_allowed)) then
    perform public._err('INVALID_INPUT', 'reasonCode must be one of ' || array_to_string(p_allowed, ', '));
  end if;
  if v = 'OTHER' and p_note is null then
    perform public._err('INVALID_INPUT', 'a note is required when the reason is OTHER');
  end if;
  return v;
end;
$$;

-- KES formatting for alert subjects and approval summaries.
create or replace function public._kes(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_cents < 0 then '-' else '' end
         || 'KES ' || to_char(abs(p_cents) / 100.0, 'FM999,999,999,990.00')
$$;

-- Denomination counts: {"n1000": 3, ..., "c1": 0}. Unknown keys are rejected.
create or replace function public._denoms(d jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  k text;
  r jsonb := '{}'::jsonb;
  keys constant text[] := array['n1000', 'n500', 'n200', 'n100', 'n50', 'c20', 'c10', 'c5', 'c1'];
begin
  if d is null or jsonb_typeof(d) <> 'object' then
    perform public._err('INVALID_INPUT', 'denominations must be an object');
  end if;
  for k in select jsonb_object_keys(d) loop
    if not (k = any (keys)) then
      perform public._err('INVALID_INPUT', 'unknown denomination ' || k);
    end if;
  end loop;
  foreach k in array keys loop
    r := r || jsonb_build_object(k, coalesce(public._j_int(d, k, 0, 100000, false), 0));
  end loop;
  return r;
end;
$$;

create or replace function public._denom_cents(d jsonb)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select ((d ->> 'n1000')::bigint * 1000 + (d ->> 'n500')::bigint * 500 + (d ->> 'n200')::bigint * 200
          + (d ->> 'n100')::bigint * 100 + (d ->> 'n50')::bigint * 50 + (d ->> 'c20')::bigint * 20
          + (d ->> 'c10')::bigint * 10 + (d ->> 'c5')::bigint * 5 + (d ->> 'c1')::bigint) * 100
$$;

-- ---------------------------------------------------------------------------
-- Identity and role. Roles are read live from profiles, never from JWT
-- claims, so demoting or deactivating someone takes effect immediately.
-- Owner privileges also require an MFA-verified session (aal2).
-- ---------------------------------------------------------------------------
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.app_store_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.store_id from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.role = 'OWNER' from public.profiles p where p.id = auth.uid() and p.active), false)
         and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

create or replace function public._me()
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.profiles;
begin
  if auth.uid() is null then
    perform public._err('NOT_AUTHENTICATED');
  end if;
  select * into v from public.profiles where id = auth.uid();
  if not found or not v.active then
    perform public._err('FORBIDDEN', 'no active staff profile for this account');
  end if;
  return v;
end;
$$;

create or replace function public._require_owner()
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.profiles := public._me();
begin
  if v.role <> 'OWNER' then
    perform public._err('FORBIDDEN', 'owner only');
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    perform public._err('MFA_REQUIRED');
  end if;
  return v;
end;
$$;

-- The caller's own OPEN shift, locked FOR SHARE so a close count cannot
-- commit while a sale or movement on that shift is still being written.
create or replace function public._own_open_shift(p_me public.profiles, p_shift uuid)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shifts;
begin
  select * into v from public.shifts where id = p_shift for share;
  if not found or v.cashier_id <> p_me.id or v.status <> 'OPEN' then
    perform public._err('SHIFT_NOT_OPEN');
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: small events on the private owner channel. A failed broadcast
-- must never roll back a sale, so errors are downgraded to warnings.
-- ---------------------------------------------------------------------------
create or replace function public._notify_owner(p_store uuid, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.send(p_payload, p_event, 'store:' || p_store::text || ':owner', true);
  exception when others then
    raise warning 'realtime.send failed: %', sqlerrm;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alerts. dedupe_key makes "once per shift" alerts idempotent.
-- ---------------------------------------------------------------------------
create or replace function public._raise_alert(
  p_store uuid, p_type text, p_severity text, p_subject text,
  p_shift uuid, p_user uuid, p_ref uuid, p_payload jsonb, p_dedupe text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.alerts (store_id, type, severity, subject, shift_id, user_id, ref_id, payload, dedupe_key)
  values (p_store, p_type, p_severity, p_subject, p_shift, p_user, p_ref, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  if v_id is not null then
    perform public._notify_owner(p_store, 'alert', jsonb_build_object(
      'id', v_id, 'type', p_type, 'severity', p_severity, 'subject', p_subject, 'at', now()));
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit log: append-only and hash-chained.
-- row_hash = sha256(prev_hash || canonical row JSON). jsonb text output is
-- canonical (sorted keys), and the timestamp is rendered in UTC so the hash
-- does not depend on the session time zone.
-- ---------------------------------------------------------------------------
create or replace function public._audit_hash(
  p_prev text, p_store uuid, p_actor uuid, p_action text, p_target_type text,
  p_target_id text, p_before jsonb, p_after jsonb, p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_prev || jsonb_build_object(
           'store_id', p_store, 'actor_id', p_actor, 'action', p_action,
           'target_type', p_target_type, 'target_id', p_target_id,
           'before', p_before, 'after', p_after,
           'created_at', to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         )::text, 'UTF8')), 'hex')
$$;

create or replace function public._audit(
  p_store uuid, p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
begin
  -- Serialise writers so the chain is linear; held until commit.
  perform pg_advisory_xact_lock(8675309001);
  select row_hash into v_prev from public.audit_log order by id desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  insert into public.audit_log (store_id, actor_id, action, target_type, target_id, before, after, created_at, prev_hash, row_hash)
  values (p_store, v_actor, p_action, p_target_type, p_target_id, p_before, p_after, v_now, v_prev,
          public._audit_hash(v_prev, p_store, v_actor, p_action, p_target_type, p_target_id, p_before, p_after, v_now));
end;
$$;

create or replace function public._verify_audit_chain()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.audit_log;
  v_prev text := repeat('0', 64);
  v_checked bigint := 0;
begin
  for r in select * from public.audit_log order by id loop
    if r.prev_hash <> v_prev
       or r.row_hash <> public._audit_hash(r.prev_hash, r.store_id, r.actor_id, r.action, r.target_type,
                                           r.target_id, r.before, r.after, r.created_at) then
      return jsonb_build_object('ok', false, 'brokenAtId', r.id, 'checked', v_checked);
    end if;
    v_prev := r.row_hash;
    v_checked := v_checked + 1;
  end loop;
  return jsonb_build_object('ok', true, 'checked', v_checked, 'headHash', v_prev);
end;
$$;

-- ---------------------------------------------------------------------------
-- Guards (defence in depth: they apply to every role, including the table
-- owner and the secret key, so history cannot be rewritten by accident).
-- ---------------------------------------------------------------------------
create or replace function public._deny_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
    detail = tg_table_name || ' is append-only: ' || lower(tg_op) || ' is not allowed';
end;
$$;

-- Generic guard for mutable reference tables: no DELETE, and the columns
-- named in the trigger arguments can never change.
create or replace function public._guard_fixed_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c text;
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
      detail = 'rows in ' || tg_table_name || ' are never deleted; deactivate instead';
  end if;
  foreach c in array tg_argv loop
    if (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
      raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
        detail = tg_table_name || '.' || c || ' cannot be changed';
    end if;
  end loop;
  return new;
end;
$$;

-- Approval tokens: only consumed_at may be set, exactly once.
create or replace function public._guard_approvals()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'approvals are never deleted';
  end if;
  if old.consumed_at is not null or new.consumed_at is null
     or (to_jsonb(new) - 'consumed_at') <> (to_jsonb(old) - 'consumed_at') then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
      detail = 'an approval token can only be consumed, once';
  end if;
  return new;
end;
$$;

-- Alerts: only the acknowledgement fields may be set, exactly once.
create or replace function public._guard_alerts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'alerts are never deleted';
  end if;
  if old.acknowledged_at is not null or new.acknowledged_at is null or new.acknowledged_by is null
     or (to_jsonb(new) - array['acknowledged_at', 'acknowledged_by', 'ack_note'])
        <> (to_jsonb(old) - array['acknowledged_at', 'acknowledged_by', 'ack_note']) then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
      detail = 'an alert can only be acknowledged, once';
  end if;
  return new;
end;
$$;

-- Shifts: identity and opening float are fixed; a closed shift never reopens.
create or replace function public._guard_shifts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'shifts are never deleted';
  end if;
  if new.id <> old.id or new.store_id <> old.store_id or new.register_id <> old.register_id
     or new.cashier_id <> old.cashier_id or new.opened_at <> old.opened_at
     or new.opening_float_expected_cents <> old.opening_float_expected_cents
     or new.opening_float_counted_cents <> old.opening_float_counted_cents then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'shift identity and opening float are fixed';
  end if;
  if old.status <> 'OPEN' and new.status = 'OPEN' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'a shift cannot be reopened';
  end if;
  if old.status in ('CLOSED', 'CLOSED_UNRECONCILED') and new.status = 'PENDING_COUNT' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'a closed shift cannot return to counting';
  end if;
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001', detail = 'closed_at is fixed once set';
  end if;
  return new;
end;
$$;

-- stock_levels may change only from inside the stock_movements trigger
-- (trigger depth 2). A direct INSERT/UPDATE/DELETE runs at depth 1 and fails,
-- whoever issues it.
create or replace function public._guard_stock_levels()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() < 2 or tg_op = 'DELETE' then
    raise exception using message = 'LEDGER_IMMUTABLE', errcode = 'P0001',
      detail = 'stock_levels changes only through stock_movements';
  end if;
  return new;
end;
$$;

-- stock_movements -> stock_levels, plus LOW_STOCK alerting (once until restocked).
create or replace function public._apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_on_hand integer;
  v_open boolean;
  v_reorder integer;
  v_name text;
begin
  insert into public.stock_levels as sl (product_id, store_id, on_hand, updated_at)
  values (new.product_id, new.store_id, new.qty_delta, now())
  on conflict (product_id) do update set on_hand = sl.on_hand + excluded.on_hand, updated_at = now()
  returning sl.on_hand, sl.low_stock_alert_open into v_on_hand, v_open;

  select reorder_level, name into v_reorder, v_name from public.products where id = new.product_id;

  if v_on_hand <= v_reorder and not v_open then
    update public.stock_levels set low_stock_alert_open = true where product_id = new.product_id;
    perform public._raise_alert(new.store_id, 'LOW_STOCK', 'LOW',
      v_name || ' is at or below its reorder level (' || v_on_hand || ' left)',
      null, null, new.product_id,
      jsonb_build_object('productId', new.product_id, 'onHand', v_on_hand, 'reorderLevel', v_reorder), null);
  elsif v_on_hand > v_reorder and v_open then
    update public.stock_levels set low_stock_alert_open = false where product_id = new.product_id;
  end if;
  return null;
end;
$$;

-- Every product price change (and the initial price) is copied to history.
create or replace function public._product_price_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.price_cents is distinct from old.price_cents then
    insert into public.product_price_history (store_id, product_id, old_price_cents, new_price_cents, changed_by)
    values (new.store_id, new.id, case when tg_op = 'UPDATE' then old.price_cents end, new.price_cents,
            (select id from public.profiles where id = auth.uid()));
  end if;
  return null;
end;
$$;

create or replace function public._touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attach triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Strictly append-only ledger tables.
  foreach t in array array[
    'product_price_history', 'cash_counts', 'cash_movements', 'sales', 'sale_lines', 'sale_line_costs',
    'payments', 'sale_reversals', 'sale_reversal_lines', 'approval_requests', 'approval_rejections',
    'stock_movements', 'stock_count_items', 'stock_count_lines', 'cart_events', 'alert_notifications',
    'pin_attempts', 'pin_lockouts', 'audit_log'
  ] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._deny_mutation()',
                   t || '_append_only', t);
  end loop;

  -- No table may be truncated.
  foreach t in array array[
    'stores', 'store_settings', 'profiles', 'registers', 'products', 'product_costs', 'product_price_history',
    'shifts', 'cash_counts', 'approval_requests', 'approvals', 'approval_rejections', 'cash_movements', 'sales',
    'sale_lines', 'sale_line_costs', 'payments', 'sale_reversals', 'sale_reversal_lines', 'stock_movements',
    'stock_levels', 'stock_counts', 'stock_count_items', 'stock_count_lines', 'cart_events', 'alerts',
    'alert_notifications', 'pin_attempts', 'pin_lockouts', 'audit_log'
  ] loop
    execute format('create trigger %I before truncate on public.%I for each statement execute function public._deny_mutation()',
                   t || '_no_truncate', t);
  end loop;
end;
$$;

create trigger stores_fixed          before update or delete on public.stores          for each row execute function public._guard_fixed_columns('id');
create trigger store_settings_fixed  before update or delete on public.store_settings  for each row execute function public._guard_fixed_columns('store_id');
create trigger profiles_fixed        before update or delete on public.profiles        for each row execute function public._guard_fixed_columns('id', 'store_id');
create trigger registers_fixed       before update or delete on public.registers       for each row execute function public._guard_fixed_columns('id', 'store_id', 'code');
create trigger products_fixed        before update or delete on public.products        for each row execute function public._guard_fixed_columns('id', 'store_id');
create trigger product_costs_fixed   before update or delete on public.product_costs   for each row execute function public._guard_fixed_columns('product_id', 'store_id');
create trigger stock_counts_fixed    before update or delete on public.stock_counts    for each row execute function public._guard_fixed_columns('id', 'store_id', 'opened_by', 'opened_at');
create trigger approvals_guard       before update or delete on public.approvals       for each row execute function public._guard_approvals();
create trigger alerts_guard          before update or delete on public.alerts          for each row execute function public._guard_alerts();
create trigger shifts_guard          before update or delete on public.shifts          for each row execute function public._guard_shifts();
create trigger stock_levels_guard    before insert or update or delete on public.stock_levels for each row execute function public._guard_stock_levels();

create trigger stock_movements_apply after insert on public.stock_movements for each row execute function public._apply_stock_movement();
create trigger products_price_history after insert or update on public.products for each row execute function public._product_price_history();
create trigger products_touch  before update on public.products for each row execute function public._touch_updated_at();
create trigger profiles_touch  before update on public.profiles for each row execute function public._touch_updated_at();
