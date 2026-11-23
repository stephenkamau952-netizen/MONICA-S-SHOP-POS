-- =============================================================================
-- Monica's Shop POS — 4/6 till RPCs (cashier and owner at the till)
--
-- Every RPC: SECURITY DEFINER, search_path = '', one transaction, validates
-- its own input, writes an audit_log row, and notifies the owner channel.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers used by several RPCs
-- ---------------------------------------------------------------------------

-- Expected drawer cash (FR-SH-5):
--   opening float + cash sales - cash refunds/voids - drops - paid-outs + paid-ins (+ owner adjustments)
create or replace function public._expected_cash(p_shift uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select
      coalesce((select sum(case kind
                               when 'FLOAT'      then amount_cents
                               when 'PAID_IN'    then amount_cents
                               when 'ADJUSTMENT' then amount_cents
                               when 'DROP'       then -amount_cents
                               when 'PAID_OUT'   then -amount_cents
                               else 0
                             end)
                from public.cash_movements where shift_id = p_shift), 0)
    + coalesce((select sum(amount_cents) from public.payments where shift_id = p_shift and method = 'CASH'), 0)
    - coalesce((select sum(amount_cents) from public.sale_reversals where shift_id = p_shift and refund_method = 'CASH'), 0)
$$;

create or replace function public._insert_cash_count(
  p_store uuid, p_shift uuid, p_kind text, p_by uuid, d jsonb, p_expected bigint, p_variance bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.cash_counts (store_id, shift_id, kind, counted_by, n1000, n500, n200, n100, n50, c20, c10, c5, c1,
                                  expected_cents, variance_cents)
  values (p_store, p_shift, p_kind, p_by,
          (d ->> 'n1000')::integer, (d ->> 'n500')::integer, (d ->> 'n200')::integer, (d ->> 'n100')::integer,
          (d ->> 'n50')::integer, (d ->> 'c20')::integer, (d ->> 'c10')::integer, (d ->> 'c5')::integer,
          (d ->> 'c1')::integer, p_expected, p_variance)
  returning id into v_id;
  return v_id;
end;
$$;

-- Consume a single-use owner approval token. It must match the action, the
-- target, the exact payload, the requesting user and the shift it was asked
-- on, be unexpired and unused. Returns the approving owner's id.
create or replace function public._consume_approval(
  p_approval uuid, p_action text, p_target uuid, p_payload jsonb, p_requester uuid, p_shift uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.approvals;
  v_req_shift uuid;
begin
  select * into v from public.approvals where id = p_approval for update;
  if not found then
    perform public._err('APPROVAL_INVALID', 'approval not found');
  end if;
  select shift_id into v_req_shift from public.approval_requests where id = v.request_id;
  if v.action <> p_action or v.target_id <> p_target or v.requested_by <> p_requester or v_req_shift <> p_shift then
    perform public._err('APPROVAL_INVALID', 'this approval was given for a different action');
  end if;
  if v.payload <> p_payload then
    perform public._err('APPROVAL_MISMATCH', 'the details differ from what the owner approved');
  end if;
  if v.consumed_at is not null then
    perform public._err('APPROVAL_USED');
  end if;
  if v.expires_at <= now() then
    perform public._err('APPROVAL_EXPIRED');
  end if;
  update public.approvals set consumed_at = now() where id = p_approval;
  return v.approved_by;
end;
$$;

-- Canonical reversal payload, used both when asking for approval and when
-- executing, so the owner approves exactly what is executed.
create or replace function public._reversal_payload(
  p_sale public.sales, p_kind text, p_lines jsonb, p_method text, p_reason text, p_shift public.shifts)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_window integer;
  v_lines jsonb;
  v_amount bigint := 0;
  e jsonb;
  v_lid uuid;
  v_q bigint;
  v_sl public.sale_lines;
  v_done bigint;
  v_seen uuid[] := '{}';
begin
  if p_kind not in ('VOID', 'REFUND') then
    perform public._err('INVALID_INPUT', 'kind must be VOID or REFUND');
  end if;
  if p_method not in ('CASH', 'MPESA', 'CARD') then
    perform public._err('INVALID_INPUT', 'refundMethod must be CASH, MPESA or CARD');
  end if;

  if p_kind = 'VOID' then
    if p_sale.shift_id <> p_shift.id then
      perform public._err('VOID_NOT_ALLOWED', 'a void must be done on the same open shift as the sale; use a refund');
    end if;
    if exists (select 1 from public.sale_reversals where original_sale_id = p_sale.id) then
      perform public._err('VOID_NOT_ALLOWED', 'this sale already has a void or refund');
    end if;
    select jsonb_agg(jsonb_build_object('saleLineId', l.id, 'qty', l.qty) order by l.id),
           sum(l.line_total_cents)
      into v_lines, v_amount
      from public.sale_lines l where l.sale_id = p_sale.id;
  else
    select refund_window_days into v_window from public.store_settings where store_id = p_sale.store_id;
    if p_sale.created_at < now() - make_interval(days => v_window) then
      perform public._err('REFUND_WINDOW_EXPIRED');
    end if;
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 200 then
      perform public._err('INVALID_INPUT', 'lines must contain 1 to 200 items');
    end if;
    for e in select value from jsonb_array_elements(p_lines) loop
      if jsonb_typeof(e) <> 'object' then
        perform public._err('INVALID_INPUT', 'each line must be an object');
      end if;
      v_lid := public._j_uuid(e, 'saleLineId');
      v_q := public._j_int(e, 'qty', 1, 999);
      if v_lid = any (v_seen) then
        perform public._err('INVALID_INPUT', 'a sale line appears twice');
      end if;
      v_seen := v_seen || v_lid;
      select * into v_sl from public.sale_lines where id = v_lid and sale_id = p_sale.id;
      if not found then
        perform public._err('INVALID_INPUT', 'a line is not part of this sale');
      end if;
      select coalesce(sum(qty), 0) into v_done from public.sale_reversal_lines where sale_line_id = v_lid;
      if v_q > v_sl.qty - v_done then
        perform public._err('REFUND_EXCEEDS_SALE', v_sl.product_name || ': only ' || (v_sl.qty - v_done) || ' left to refund');
      end if;
      v_amount := v_amount + v_sl.unit_price_cents * v_q;
    end loop;
    select jsonb_agg(x order by (x ->> 'saleLineId')::uuid)
      into v_lines
      from (select jsonb_build_object('saleLineId', (value ->> 'saleLineId')::uuid, 'qty', (value ->> 'qty')::bigint) as x
              from jsonb_array_elements(p_lines)) t;
  end if;

  if v_amount <= 0 then
    perform public._err('INVALID_INPUT', 'nothing to refund: the amount is zero');
  end if;

  return jsonb_build_object('kind', p_kind, 'saleId', p_sale.id, 'lines', v_lines,
                            'refundMethod', p_method, 'amountCents', v_amount, 'reasonCode', p_reason);
end;
$$;

create or replace function public._receipt_label(p_register uuid, p_receipt_no bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.code || '-' || lpad(p_receipt_no::text, 6, '0') from public.registers r where r.id = p_register
$$;

create or replace function public._receipt_for(p_sale uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'saleId', s.id,
    'receiptNo', s.receipt_no,
    'receiptLabel', r.code || '-' || lpad(s.receipt_no::text, 6, '0'),
    'registerCode', r.code,
    'storeName', st.name,
    'cashierName', pr.display_name,
    'createdAt', s.created_at,
    'itemCount', s.item_count,
    'listTotalCents', s.list_total_cents,
    'totalCents', s.total_cents,
    'lines', (select jsonb_agg(jsonb_build_object(
                       'lineNo', l.line_no, 'saleLineId', l.id, 'productId', l.product_id, 'name', l.product_name,
                       'qty', l.qty, 'unitPriceCents', l.unit_price_cents, 'listPriceCents', l.list_price_cents,
                       'lineTotalCents', l.line_total_cents, 'overridden', l.price_overridden)
                     order by l.line_no)
                from public.sale_lines l where l.sale_id = s.id),
    'payments', (select jsonb_agg(jsonb_build_object(
                          'method', pm.method, 'amountCents', pm.amount_cents, 'tenderedCents', pm.tendered_cents,
                          'changeCents', pm.change_cents, 'mpesaCode', pm.mpesa_code, 'cardRef', pm.card_ref)
                        order by pm.seq)
                   from public.payments pm where pm.sale_id = s.id),
    'changeDueCents', coalesce((select sum(change_cents) from public.payments where sale_id = s.id and method = 'CASH'), 0),
    'openDrawer', exists (select 1 from public.payments where sale_id = s.id and method = 'CASH'))
  from public.sales s
  join public.registers r on r.id = s.register_id
  join public.stores st on st.id = s.store_id
  join public.profiles pr on pr.id = s.cashier_id
  where s.id = p_sale
$$;

-- PIN lockout helpers (5 consecutive failures within 15 minutes -> 15 minute lock)
create or replace function public._pin_locked_until(p_kind text, p_register uuid, p_actor uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(locked_until) from public.pin_lockouts
   where kind = p_kind and locked_until > now()
     and ((p_kind = 'OWNER_APPROVAL' and register_id = p_register)
          or (p_kind = 'TILL_UNLOCK' and actor_id = p_actor))
$$;

create or replace function public._pin_recent_failures(p_kind text, p_register uuid, p_actor uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with scope as (
    select * from public.pin_attempts
     where kind = p_kind
       and ((p_kind = 'OWNER_APPROVAL' and register_id = p_register)
            or (p_kind = 'TILL_UNLOCK' and actor_id = p_actor))
  ), since as (
    select greatest(
             now() - interval '15 minutes',
             coalesce((select max(created_at) from scope where success), '-infinity'::timestamptz),
             coalesce((select max(created_at) from public.pin_lockouts
                        where kind = p_kind
                          and ((p_kind = 'OWNER_APPROVAL' and register_id = p_register)
                               or (p_kind = 'TILL_UNLOCK' and actor_id = p_actor))), '-infinity'::timestamptz)
           ) as t
  )
  select count(*)::integer from scope, since where not scope.success and scope.created_at >= since.t
$$;

-- ---------------------------------------------------------------------------
-- my_context: who am I, my open shift, my till settings
-- ---------------------------------------------------------------------------
create or replace function public.my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.profiles;
  v_store public.stores;
  v_set public.store_settings;
  v_shift jsonb;
  v_count jsonb;
begin
  if auth.uid() is null then
    perform public._err('NOT_AUTHENTICATED');
  end if;
  select * into v from public.profiles where id = auth.uid();
  if not found then
    return jsonb_build_object('userId', auth.uid(), 'hasProfile', false);
  end if;
  if not v.active then
    return jsonb_build_object('userId', auth.uid(), 'hasProfile', true, 'active', false);
  end if;
  select * into v_store from public.stores where id = v.store_id;
  select * into v_set from public.store_settings where store_id = v.store_id;

  select jsonb_build_object('id', s.id, 'status', s.status, 'registerId', s.register_id, 'registerCode', r.code,
                            'registerName', r.name, 'openedAt', s.opened_at)
    into v_shift
    from public.shifts s join public.registers r on r.id = s.register_id
   where s.cashier_id = v.id and s.status in ('OPEN', 'PENDING_COUNT')
   limit 1;

  select jsonb_build_object('id', c.id, 'note', c.note, 'openedAt', c.opened_at)
    into v_count
    from public.stock_counts c
   where c.store_id = v.store_id and c.status = 'OPEN' and c.assigned_to = v.id
   limit 1;

  return jsonb_build_object(
    'userId', v.id, 'hasProfile', true, 'active', true, 'role', v.role, 'displayName', v.display_name,
    'hasPin', v.pin_hash is not null, 'storeId', v.store_id, 'storeName', v_store.name,
    'mfaVerified', coalesce(auth.jwt() ->> 'aal', '') = 'aal2',
    'idleLockSeconds', v_set.till_idle_lock_seconds, 'refundWindowDays', v_set.refund_window_days,
    'approvalTtlSeconds', v_set.approval_ttl_seconds,
    'openShift', v_shift, 'assignedStockCount', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-SH-1 open_shift
-- ---------------------------------------------------------------------------
create or replace function public.open_shift(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_reg public.registers;
  v_shift_id uuid := gen_random_uuid();
  d jsonb;
  v_counted bigint;
  v_flag boolean;
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_reg from public.registers
   where id = public._j_uuid(p, 'registerId') and store_id = v_me.store_id
   for update;
  if not found or not v_reg.active then
    perform public._err('NOT_FOUND', 'register not found');
  end if;
  if exists (select 1 from public.shifts where cashier_id = v_me.id and status in ('OPEN', 'PENDING_COUNT')) then
    perform public._err('SHIFT_ALREADY_OPEN');
  end if;
  if exists (select 1 from public.shifts where register_id = v_reg.id and status in ('OPEN', 'PENDING_COUNT')) then
    perform public._err('REGISTER_BUSY');
  end if;

  d := public._denoms(p -> 'denominations');
  v_counted := public._denom_cents(d);

  begin
    insert into public.shifts (id, store_id, register_id, cashier_id, opening_float_expected_cents, opening_float_counted_cents)
    values (v_shift_id, v_me.store_id, v_reg.id, v_me.id, v_reg.float_cents, v_counted);
  exception when unique_violation then
    perform public._err('REGISTER_BUSY');
  end;

  perform public._insert_cash_count(v_me.store_id, v_shift_id, 'OPENING', v_me.id, d,
                                    v_reg.float_cents, v_counted - v_reg.float_cents);
  insert into public.cash_movements (store_id, shift_id, register_id, kind, amount_cents, reason_code, actor_id)
  values (v_me.store_id, v_shift_id, v_reg.id, 'FLOAT', v_counted, 'OPENING_FLOAT', v_me.id);

  v_flag := v_counted <> v_reg.float_cents;
  if v_flag then
    perform public._raise_alert(v_me.store_id, 'OPENING_VARIANCE', 'MEDIUM',
      v_me.display_name || ' opened ' || v_reg.code || ' with ' || public._kes(v_counted)
        || '; the set float is ' || public._kes(v_reg.float_cents),
      v_shift_id, v_me.id, v_shift_id,
      jsonb_build_object('countedCents', v_counted, 'expectedCents', v_reg.float_cents),
      'OPENING_VARIANCE:' || v_shift_id);
  end if;

  perform public._audit(v_me.store_id, 'open_shift', 'shift', v_shift_id::text, null,
    jsonb_build_object('registerId', v_reg.id, 'openingFloatCountedCents', v_counted,
                       'openingFloatExpectedCents', v_reg.float_cents, 'denominations', d));
  perform public._notify_owner(v_me.store_id, 'shift', jsonb_build_object(
    'kind', 'opened', 'shiftId', v_shift_id, 'registerCode', v_reg.code, 'cashier', v_me.display_name, 'at', now()));

  return jsonb_build_object('shiftId', v_shift_id, 'registerId', v_reg.id, 'registerCode', v_reg.code,
                            'registerName', v_reg.name, 'openingVarianceFlagged', v_flag);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-CO-4 complete_sale — the only way a sale exists.
-- ---------------------------------------------------------------------------
create or replace function public.complete_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_key uuid;
  v_existing public.sales;
  v_shift public.shifts;
  v_set public.store_settings;
  v_lines jsonb := p -> 'lines';
  v_pays jsonb := p -> 'payments';
  v_norm jsonb := '[]'::jsonb;
  v_priced jsonb := '[]'::jsonb;
  v_ids uuid[];
  e jsonb;
  v_n integer := 0;
  v_pid uuid;
  v_qty bigint;
  v_ovr_price bigint;
  v_ovr_approval uuid;
  v_ovr_by uuid;
  v_unit bigint;
  v_prod public.products;
  v_on_hand integer;
  v_sale_id uuid := gen_random_uuid();
  v_line_id uuid;
  v_receipt bigint;
  v_total bigint := 0;
  v_list_total bigint := 0;
  v_items bigint := 0;
  v_noncash bigint := 0;
  v_cash_due bigint;
  v_tendered bigint;
  v_change bigint := 0;
  v_cash_count integer := 0;
  v_method text;
  v_amount bigint;
  v_code text;
  v_ref text;
  v_codes text[] := '{}';
  v_seq integer := 0;
  v_override_count integer := 0;
  v_shift_overrides integer;
  v_avg numeric;
  v_receipt_json jsonb;
  r record;
begin
  perform public._obj(p);
  v_me := public._me();
  v_key := public._j_uuid(p, 'idempotencyKey');

  -- 1. Idempotency: a retry with the same key returns the original sale.
  perform pg_advisory_xact_lock(hashtextextended('sale:' || v_key::text, 0));
  select * into v_existing from public.sales where idempotency_key = v_key;
  if found then
    if v_existing.cashier_id <> v_me.id then
      perform public._err('IDEMPOTENCY_CONFLICT');
    end if;
    return public._receipt_for(v_existing.id) || jsonb_build_object('replayed', true);
  end if;

  -- 2. The caller's own OPEN shift.
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  select * into v_set from public.store_settings where store_id = v_me.store_id;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) not between 1 and 200 then
    perform public._err('INVALID_INPUT', 'lines must contain 1 to 200 items');
  end if;
  if v_pays is null or jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) not between 1 and 4 then
    perform public._err('INVALID_INPUT', 'payments must contain 1 to 4 items');
  end if;

  -- Validate line shapes. The client sends product ids and quantities only.
  for e in select value from jsonb_array_elements(v_lines) loop
    if jsonb_typeof(e) <> 'object' then
      perform public._err('INVALID_INPUT', 'each line must be an object');
    end if;
    v_n := v_n + 1;
    v_pid := public._j_uuid(e, 'productId');
    v_qty := public._j_int(e, 'qty', 1, 999);
    v_ovr_price := public._j_int(e, 'overridePriceCents', 0, 100000000, false);
    v_ovr_approval := public._j_uuid(e, 'overrideApprovalId', false);
    if v_ovr_approval is not null and v_ovr_price is null then
      perform public._err('INVALID_INPUT', 'overridePriceCents is required with overrideApprovalId');
    end if;
    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'lineNo', v_n, 'productId', v_pid, 'qty', v_qty,
      'overridePriceCents', v_ovr_price, 'overrideApprovalId', v_ovr_approval));
  end loop;

  -- 3. Lock product rows (share) and stock rows (update) in id order so two
  --    tills selling the same items cannot deadlock.
  select array_agg(distinct (x ->> 'productId')::uuid order by (x ->> 'productId')::uuid)
    into v_ids from jsonb_array_elements(v_norm) x;
  perform 1 from public.products where id = any (v_ids) order by id for share;
  perform 1 from public.stock_levels where product_id = any (v_ids) order by product_id for update;

  if (select count(*) from public.products
       where id = any (v_ids) and store_id = v_me.store_id and active) <> cardinality(v_ids) then
    perform public._err('PRODUCT_UNAVAILABLE', 'a product is unknown or no longer sold');
  end if;

  -- 4. Price every line from the database; overrides need a valid token.
  for e in select value from jsonb_array_elements(v_norm) loop
    v_pid := (e ->> 'productId')::uuid;
    v_qty := (e ->> 'qty')::bigint;
    select * into v_prod from public.products where id = v_pid;
    v_ovr_by := null;
    v_unit := v_prod.price_cents;
    if e ->> 'overridePriceCents' is not null then
      v_ovr_price := (e ->> 'overridePriceCents')::bigint;
      if v_ovr_price = v_prod.price_cents then
        perform public._err('INVALID_INPUT', 'override price equals the current price');
      end if;
      if e ->> 'overrideApprovalId' is null then
        if not public.is_owner() then
          perform public._err('APPROVAL_REQUIRED', 'a price override needs owner approval');
        end if;
        v_ovr_by := v_me.id;
      else
        v_ovr_by := public._consume_approval((e ->> 'overrideApprovalId')::uuid, 'PRICE_OVERRIDE', v_pid,
                      jsonb_build_object('productId', v_pid, 'priceCents', v_ovr_price), v_me.id, v_shift.id);
      end if;
      v_unit := v_ovr_price;
      v_override_count := v_override_count + 1;
    end if;
    v_total := v_total + v_unit * v_qty;
    v_list_total := v_list_total + v_prod.price_cents * v_qty;
    v_items := v_items + v_qty;
    v_priced := v_priced || jsonb_build_array(e || jsonb_build_object(
      'name', v_prod.name, 'listPriceCents', v_prod.price_cents, 'unitPriceCents', v_unit,
      'overrideBy', v_ovr_by));
  end loop;

  if v_total <= 0 then
    perform public._err('INVALID_INPUT', 'the sale total must be greater than zero');
  end if;

  -- 5. Stock check (aggregated per product).
  for r in select (x ->> 'productId')::uuid as pid, sum((x ->> 'qty')::bigint) as q
             from jsonb_array_elements(v_norm) x group by 1 loop
    v_on_hand := coalesce((select on_hand from public.stock_levels where product_id = r.pid), 0);
    if v_on_hand - r.q < 0 and not v_set.allow_negative_stock then
      perform public._err('INSUFFICIENT_STOCK',
        (select name from public.products where id = r.pid) || ': ' || greatest(v_on_hand, 0) || ' in stock');
    end if;
  end loop;

  -- 6. Payments must add up to the total; cash change is computed here.
  for e in select value from jsonb_array_elements(v_pays) loop
    if jsonb_typeof(e) <> 'object' then
      perform public._err('INVALID_INPUT', 'each payment must be an object');
    end if;
    v_method := public._j_text(e, 'method', true, 10);
    if v_method = 'CASH' then
      v_cash_count := v_cash_count + 1;
      if v_cash_count > 1 then
        perform public._err('INVALID_INPUT', 'only one cash payment per sale');
      end if;
      v_tendered := public._j_int(e, 'tenderedCents', 1, 100000000);
    elsif v_method = 'MPESA' then
      v_amount := public._j_int(e, 'amountCents', 1, 100000000);
      v_code := upper(public._j_text(e, 'mpesaCode', true, 10));
      if v_code !~ '^[A-Z0-9]{10}$' then
        perform public._err('INVALID_INPUT', 'mpesaCode must be 10 letters or digits');
      end if;
      if v_code = any (v_codes) or exists (select 1 from public.payments where mpesa_code = v_code) then
        perform public._err('MPESA_CODE_USED', v_code);
      end if;
      v_codes := v_codes || v_code;
      v_noncash := v_noncash + v_amount;
    elsif v_method = 'CARD' then
      v_amount := public._j_int(e, 'amountCents', 1, 100000000);
      v_ref := public._j_text(e, 'cardRef', true, 32);
      if length(v_ref) < 4 then
        perform public._err('INVALID_INPUT', 'cardRef must be 4 to 32 characters');
      end if;
      v_noncash := v_noncash + v_amount;
    else
      perform public._err('INVALID_INPUT', 'payment method must be CASH, MPESA or CARD');
    end if;
  end loop;

  if v_noncash > v_total then
    perform public._err('PAYMENT_MISMATCH', 'M-Pesa and card payments exceed the total');
  end if;
  v_cash_due := v_total - v_noncash;
  if v_cash_count = 1 then
    if v_cash_due = 0 then
      perform public._err('PAYMENT_MISMATCH', 'nothing is left to pay in cash');
    end if;
    if v_tendered < v_cash_due then
      perform public._err('INSUFFICIENT_TENDER', 'cash due is ' || public._kes(v_cash_due));
    end if;
    v_change := v_tendered - v_cash_due;
  elsif v_cash_due <> 0 then
    perform public._err('PAYMENT_MISMATCH', 'payments do not add up to the total of ' || public._kes(v_total));
  end if;

  -- 7. Write the sale. Receipt numbers are sequential per register.
  update public.registers set next_receipt_no = next_receipt_no + 1
   where id = v_shift.register_id
   returning next_receipt_no - 1 into v_receipt;

  insert into public.sales (id, store_id, register_id, shift_id, cashier_id, idempotency_key, receipt_no,
                            item_count, list_total_cents, total_cents)
  values (v_sale_id, v_me.store_id, v_shift.register_id, v_shift.id, v_me.id, v_key, v_receipt,
          v_items, v_list_total, v_total);

  for e in select value from jsonb_array_elements(v_priced) loop
    v_line_id := gen_random_uuid();
    v_pid := (e ->> 'productId')::uuid;
    v_qty := (e ->> 'qty')::bigint;
    v_unit := (e ->> 'unitPriceCents')::bigint;
    insert into public.sale_lines (id, store_id, sale_id, shift_id, line_no, product_id, product_name, qty,
                                   list_price_cents, unit_price_cents, line_total_cents, price_overridden,
                                   override_approved_by, approval_id)
    values (v_line_id, v_me.store_id, v_sale_id, v_shift.id, (e ->> 'lineNo')::integer, v_pid, e ->> 'name', v_qty,
            (e ->> 'listPriceCents')::bigint, v_unit, v_unit * v_qty,
            v_unit <> (e ->> 'listPriceCents')::bigint,
            (e ->> 'overrideBy')::uuid, (e ->> 'overrideApprovalId')::uuid);

    v_avg := coalesce((select avg_cost_cents from public.product_costs where product_id = v_pid), 0);
    insert into public.sale_line_costs (sale_line_id, store_id, sale_id, product_id, unit_cost_cents, cost_total_cents)
    values (v_line_id, v_me.store_id, v_sale_id, v_pid, v_avg, round(v_avg * v_qty)::bigint);

    insert into public.stock_movements (store_id, product_id, qty_delta, type, reason_code, ref_type, ref_id, actor_id)
    values (v_me.store_id, v_pid, -v_qty, 'SALE', 'SALE', 'sale_line', v_line_id, v_me.id);
  end loop;

  begin
    for e in select value from jsonb_array_elements(v_pays) loop
      v_seq := v_seq + 1;
      v_method := e ->> 'method';
      if v_method = 'CASH' then
        insert into public.payments (store_id, sale_id, shift_id, seq, method, amount_cents, tendered_cents, change_cents)
        values (v_me.store_id, v_sale_id, v_shift.id, v_seq, 'CASH', v_cash_due, v_cash_due + v_change, v_change);
      elsif v_method = 'MPESA' then
        insert into public.payments (store_id, sale_id, shift_id, seq, method, amount_cents, mpesa_code)
        values (v_me.store_id, v_sale_id, v_shift.id, v_seq, 'MPESA', (e ->> 'amountCents')::bigint,
                upper(btrim(e ->> 'mpesaCode')));
      else
        insert into public.payments (store_id, sale_id, shift_id, seq, method, amount_cents, card_ref)
        values (v_me.store_id, v_sale_id, v_shift.id, v_seq, 'CARD', (e ->> 'amountCents')::bigint,
                btrim(e ->> 'cardRef'));
      end if;
    end loop;
  exception when unique_violation then
    perform public._err('MPESA_CODE_USED');
  end;

  -- Alerts: negative stock, price overrides.
  for r in select sl.product_id, sl.on_hand, pr.name
             from public.stock_levels sl join public.products pr on pr.id = sl.product_id
            where sl.product_id = any (v_ids) and sl.on_hand < 0 loop
    perform public._raise_alert(v_me.store_id, 'NEGATIVE_STOCK', 'LOW',
      r.name || ' sold below zero (' || r.on_hand || ')', v_shift.id, v_me.id, r.product_id,
      jsonb_build_object('productId', r.product_id, 'onHand', r.on_hand, 'saleId', v_sale_id), null);
  end loop;

  if v_override_count > 0 then
    perform public._raise_alert(v_me.store_id, 'PRICE_OVERRIDE', 'MEDIUM',
      v_me.display_name || ' sold ' || v_override_count || ' line(s) at an overridden price on receipt '
        || public._receipt_label(v_shift.register_id, v_receipt),
      v_shift.id, v_me.id, v_sale_id,
      jsonb_build_object('saleId', v_sale_id, 'lines', v_override_count,
                         'discountCents', v_list_total - v_total), null);
    select count(*) into v_shift_overrides from public.sale_lines where shift_id = v_shift.id and price_overridden;
    if v_shift_overrides > v_set.override_batch_threshold then
      perform public._raise_alert(v_me.store_id, 'PRICE_OVERRIDE', 'MEDIUM',
        v_me.display_name || ' has more than ' || v_set.override_batch_threshold || ' price overrides this shift',
        v_shift.id, v_me.id, v_shift.id, jsonb_build_object('batch', true, 'count', v_shift_overrides),
        'PRICE_OVERRIDE_BATCH:' || v_shift.id);
    end if;
  end if;

  -- 8. Audit and owner notification inside the same transaction.
  v_receipt_json := public._receipt_for(v_sale_id);
  perform public._audit(v_me.store_id, 'complete_sale', 'sale', v_sale_id::text, null,
    jsonb_build_object('receiptLabel', v_receipt_json ->> 'receiptLabel', 'totalCents', v_total,
                       'listTotalCents', v_list_total, 'lineCount', v_n, 'overrides', v_override_count,
                       'payments', v_receipt_json -> 'payments'));
  perform public._notify_owner(v_me.store_id, 'sale', jsonb_build_object(
    'saleId', v_sale_id, 'receiptLabel', v_receipt_json ->> 'receiptLabel', 'totalCents', v_total,
    'cashier', v_me.display_name,
    'methods', (select jsonb_agg(distinct x ->> 'method') from jsonb_array_elements(v_receipt_json -> 'payments') x),
    'at', now()));

  -- 9. Receipt data for printing.
  return v_receipt_json || jsonb_build_object('replayed', false);
end;
$$;

-- Reprinting is logged; a reprint never opens the drawer.
create or replace function public.reprint_receipt(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_sale public.sales;
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_sale from public.sales where id = public._j_uuid(p, 'saleId') and store_id = v_me.store_id;
  if not found
     or (not public.is_owner()
         and not exists (select 1 from public.shifts s where s.id = v_sale.shift_id and s.cashier_id = v_me.id)) then
    perform public._err('NOT_FOUND', 'sale not found');
  end if;
  perform public._audit(v_me.store_id, 'reprint_receipt', 'sale', v_sale.id::text, null, null);
  return public._receipt_for(v_sale.id) || jsonb_build_object('openDrawer', false, 'reprint', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-CO-8 cart audit (lines removed / carts cancelled before payment)
-- ---------------------------------------------------------------------------
create or replace function public.log_cart_event(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_set public.store_settings;
  v_event uuid;
  v_kind text;
  v_pid uuid;
  v_qty bigint;
  v_lines jsonb;
  v_norm jsonb := '[]'::jsonb;
  v_price bigint;
  e jsonb;
  v_line_events integer;
  v_cancels integer;
begin
  perform public._obj(p);
  v_me := public._me();
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  v_event := public._j_uuid(p, 'eventKey');
  if exists (select 1 from public.cart_events where event_key = v_event) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  v_kind := public._j_text(p, 'kind', true, 20);
  if v_kind not in ('LINE_REMOVED', 'QTY_REDUCED', 'CART_CANCELLED') then
    perform public._err('INVALID_INPUT', 'kind must be LINE_REMOVED, QTY_REDUCED or CART_CANCELLED');
  end if;

  if v_kind = 'CART_CANCELLED' then
    v_lines := p -> 'lines';
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) > 200 then
      perform public._err('INVALID_INPUT', 'lines must be an array of at most 200 items');
    end if;
    v_qty := 0;
    for e in select value from jsonb_array_elements(v_lines) loop
      if jsonb_typeof(e) <> 'object' then
        perform public._err('INVALID_INPUT', 'each line must be an object');
      end if;
      v_pid := public._j_uuid(e, 'productId');
      if not exists (select 1 from public.products where id = v_pid and store_id = v_me.store_id) then
        perform public._err('INVALID_INPUT', 'unknown product in cancelled cart');
      end if;
      v_norm := v_norm || jsonb_build_array(jsonb_build_object('productId', v_pid, 'qty', public._j_int(e, 'qty', 1, 999)));
      v_qty := v_qty + (e ->> 'qty')::bigint;
    end loop;
    v_pid := null;
  else
    v_pid := public._j_uuid(p, 'productId');
    v_qty := public._j_int(p, 'qty', 1, 999);
    select price_cents into v_price from public.products where id = v_pid and store_id = v_me.store_id;
    if not found then
      perform public._err('INVALID_INPUT', 'unknown product');
    end if;
    v_norm := null;
  end if;

  insert into public.cart_events (event_key, store_id, shift_id, register_id, cashier_id, cart_key, kind, product_id,
                                  qty, unit_price_cents, lines)
  values (v_event, v_me.store_id, v_shift.id, v_shift.register_id, v_me.id, public._j_uuid(p, 'cartKey'), v_kind,
          v_pid, v_qty, v_price, v_norm)
  on conflict (event_key) do nothing;

  select count(*) filter (where kind in ('LINE_REMOVED', 'QTY_REDUCED')),
         count(*) filter (where kind = 'CART_CANCELLED')
    into v_line_events, v_cancels
    from public.cart_events where shift_id = v_shift.id;
  select * into v_set from public.store_settings where store_id = v_me.store_id;

  if v_line_events > v_set.cart_line_removal_threshold then
    perform public._raise_alert(v_me.store_id, 'CART_DELETIONS', 'MEDIUM',
      v_me.display_name || ' removed more than ' || v_set.cart_line_removal_threshold || ' scanned lines this shift',
      v_shift.id, v_me.id, v_shift.id, jsonb_build_object('lineEvents', v_line_events),
      'CART_DELETIONS:LINES:' || v_shift.id);
  end if;
  if v_cancels > v_set.cart_cancel_threshold then
    perform public._raise_alert(v_me.store_id, 'CART_DELETIONS', 'MEDIUM',
      v_me.display_name || ' cancelled more than ' || v_set.cart_cancel_threshold || ' carts this shift',
      v_shift.id, v_me.id, v_shift.id, jsonb_build_object('cancelledCarts', v_cancels),
      'CART_DELETIONS:CARTS:' || v_shift.id);
  end if;

  perform public._audit(v_me.store_id, 'log_cart_event', 'cart', p ->> 'cartKey', null,
    jsonb_build_object('kind', v_kind, 'productId', v_pid, 'qty', v_qty, 'lines', v_norm));
  perform public._notify_owner(v_me.store_id, 'cart_event', jsonb_build_object(
    'kind', v_kind, 'cashier', v_me.display_name, 'qty', v_qty, 'at', now()));
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-VR-2 approvals: request -> (PIN at till | owner dashboard) -> token
-- ---------------------------------------------------------------------------
create or replace function public.request_approval(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_action text;
  v_note text;
  v_reason text;
  v_target uuid;
  v_payload jsonb;
  v_summary text;
  v_prod public.products;
  v_price bigint;
  v_sale public.sales;
  v_amount bigint;
  v_id uuid := gen_random_uuid();
  v_expires timestamptz := now() + interval '10 minutes';
  v_reg public.registers;
begin
  perform public._obj(p);
  v_me := public._me();
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  select * into v_reg from public.registers where id = v_shift.register_id;
  v_action := public._j_text(p, 'action', true, 20);
  v_note := public._j_text(p, 'note', false, 500);

  if v_action = 'PRICE_OVERRIDE' then
    v_reason := public._reason(p, public._reversal_reasons(), v_note);
    select * into v_prod from public.products
     where id = public._j_uuid(p, 'productId') and store_id = v_me.store_id and active;
    if not found then
      perform public._err('PRODUCT_UNAVAILABLE');
    end if;
    v_price := public._j_int(p, 'priceCents', 0, 100000000);
    if v_price = v_prod.price_cents then
      perform public._err('INVALID_INPUT', 'the new price equals the current price');
    end if;
    v_target := v_prod.id;
    v_payload := jsonb_build_object('productId', v_prod.id, 'priceCents', v_price);
    v_summary := 'Price override: ' || v_prod.name || ' from ' || public._kes(v_prod.price_cents)
                 || ' to ' || public._kes(v_price);

  elsif v_action in ('VOID', 'REFUND') then
    v_reason := public._reason(p, public._reversal_reasons(), v_note);
    select * into v_sale from public.sales where id = public._j_uuid(p, 'saleId') and store_id = v_me.store_id;
    if not found then
      perform public._err('NOT_FOUND', 'sale not found');
    end if;
    v_payload := public._reversal_payload(v_sale, v_action, p -> 'lines',
                                          public._j_text(p, 'refundMethod', true, 10), v_reason, v_shift);
    v_target := v_sale.id;
    v_summary := initcap(v_action) || ' of receipt ' || public._receipt_label(v_sale.register_id, v_sale.receipt_no)
                 || ': ' || public._kes((v_payload ->> 'amountCents')::bigint) || ' back by '
                 || (v_payload ->> 'refundMethod');

  elsif v_action = 'NO_SALE' then
    v_reason := public._reason(p, public._cash_reasons(), v_note);
    v_target := v_shift.id;
    v_payload := jsonb_build_object('reasonCode', v_reason);
    v_summary := 'Open the drawer without a sale on ' || v_reg.code;

  elsif v_action = 'PAID_OUT' then
    v_reason := public._reason(p, public._cash_reasons(), v_note);
    v_amount := public._j_int(p, 'amountCents', 1, 100000000);
    v_target := v_shift.id;
    v_payload := jsonb_build_object('amountCents', v_amount, 'reasonCode', v_reason);
    v_summary := 'Pay out ' || public._kes(v_amount) || ' from ' || v_reg.code;

  else
    perform public._err('INVALID_INPUT', 'action must be PRICE_OVERRIDE, VOID, REFUND, NO_SALE or PAID_OUT');
  end if;

  v_summary := v_summary || ' (' || v_reason || coalesce(': ' || v_note, '') || ')';

  insert into public.approval_requests (id, store_id, action, requested_by, shift_id, register_id, target_id,
                                        payload, summary, reason_code, note, expires_at)
  values (v_id, v_me.store_id, v_action, v_me.id, v_shift.id, v_shift.register_id, v_target,
          v_payload, v_summary, v_reason, v_note, v_expires);

  perform public._audit(v_me.store_id, 'request_approval', 'approval_request', v_id::text, null,
    jsonb_build_object('action', v_action, 'targetId', v_target, 'payload', v_payload, 'summary', v_summary));
  perform public._notify_owner(v_me.store_id, 'approval_request', jsonb_build_object(
    'requestId', v_id, 'action', v_action, 'summary', v_summary, 'cashier', v_me.display_name,
    'registerCode', v_reg.code, 'at', now()));

  return jsonb_build_object('requestId', v_id, 'action', v_action, 'summary', v_summary, 'expiresAt', v_expires);
end;
$$;

-- Owner types their PIN on the till. PIN failures are recorded and returned
-- as {ok:false}, not raised, so the failed attempt is not rolled back.
create or replace function public.approve_with_pin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_req public.approval_requests;
  v_pin text;
  v_owner uuid;
  v_locked timestamptz;
  v_fails integer;
  v_ttl integer;
  v_approval uuid := gen_random_uuid();
  v_expires timestamptz;
  v_reg_code text;
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_req from public.approval_requests where id = public._j_uuid(p, 'requestId') for update;
  if not found or v_req.requested_by <> v_me.id then
    perform public._err('NOT_FOUND', 'approval request not found');
  end if;
  if exists (select 1 from public.approvals where request_id = v_req.id)
     or exists (select 1 from public.approval_rejections where request_id = v_req.id) then
    perform public._err('APPROVAL_ALREADY_DECIDED');
  end if;
  if v_req.expires_at <= now() then
    perform public._err('APPROVAL_EXPIRED', 'the request expired; ask again');
  end if;

  v_locked := public._pin_locked_until('OWNER_APPROVAL', v_req.register_id, v_me.id);
  if v_locked is not null then
    return jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'lockedUntil', v_locked);
  end if;

  v_pin := case when jsonb_typeof(p -> 'pin') = 'string' then p ->> 'pin' end;
  if v_pin ~ '^[0-9]{6}$' then
    select id into v_owner from public.profiles
     where store_id = v_me.store_id and role = 'OWNER' and active and pin_hash is not null
       and pin_hash = extensions.crypt(v_pin, pin_hash)
     order by id
     limit 1;
  end if;

  if v_owner is null then
    insert into public.pin_attempts (store_id, register_id, kind, actor_id, success)
    values (v_me.store_id, v_req.register_id, 'OWNER_APPROVAL', v_me.id, false);
    v_fails := public._pin_recent_failures('OWNER_APPROVAL', v_req.register_id, v_me.id);
    perform public._audit(v_me.store_id, 'approve_with_pin', 'approval_request', v_req.id::text, null,
      jsonb_build_object('ok', false, 'failures', v_fails));
    if v_fails >= 5 then
      v_locked := now() + interval '15 minutes';
      insert into public.pin_lockouts (store_id, register_id, actor_id, kind, locked_until)
      values (v_me.store_id, v_req.register_id, v_me.id, 'OWNER_APPROVAL', v_locked);
      select code into v_reg_code from public.registers where id = v_req.register_id;
      perform public._raise_alert(v_me.store_id, 'PIN_LOCKOUT', 'HIGH',
        '5 wrong owner PINs on ' || v_reg_code || ' (cashier: ' || v_me.display_name || '); approvals locked 15 minutes',
        v_req.shift_id, v_me.id, v_req.register_id,
        jsonb_build_object('registerId', v_req.register_id, 'lockedUntil', v_locked), null);
      return jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'lockedUntil', v_locked);
    end if;
    return jsonb_build_object('ok', false, 'error', 'BAD_PIN', 'attemptsLeft', 5 - v_fails);
  end if;

  if v_owner = v_me.id then
    perform public._err('SELF_APPROVAL', 'you cannot approve your own request');
  end if;

  insert into public.pin_attempts (store_id, register_id, kind, actor_id, matched_profile_id, success)
  values (v_me.store_id, v_req.register_id, 'OWNER_APPROVAL', v_me.id, v_owner, true);

  select approval_ttl_seconds into v_ttl from public.store_settings where store_id = v_me.store_id;
  v_expires := now() + make_interval(secs => v_ttl);
  insert into public.approvals (id, store_id, request_id, action, target_id, payload, requested_by, approved_by,
                                channel, expires_at)
  values (v_approval, v_me.store_id, v_req.id, v_req.action, v_req.target_id, v_req.payload, v_req.requested_by,
          v_owner, 'TILL_PIN', v_expires);

  perform public._audit(v_me.store_id, 'approve_with_pin', 'approval', v_approval::text, null,
    jsonb_build_object('ok', true, 'requestId', v_req.id, 'approvedBy', v_owner, 'action', v_req.action));
  perform public._notify_owner(v_me.store_id, 'approval', jsonb_build_object(
    'requestId', v_req.id, 'approvalId', v_approval, 'channel', 'TILL_PIN', 'summary', v_req.summary, 'at', now()));

  return jsonb_build_object('ok', true, 'approvalId', v_approval, 'expiresAt', v_expires,
                            'approvedBy', (select display_name from public.profiles where id = v_owner));
end;
$$;

-- The till polls this after asking; the token is only revealed to the requester.
create or replace function public.my_approval(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_req public.approval_requests;
  v_ap public.approvals;
  v_rej public.approval_rejections;
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_req from public.approval_requests where id = public._j_uuid(p, 'requestId');
  if not found or v_req.requested_by <> v_me.id then
    perform public._err('NOT_FOUND', 'approval request not found');
  end if;
  select * into v_ap from public.approvals where request_id = v_req.id;
  if found then
    if v_ap.consumed_at is not null then
      return jsonb_build_object('status', 'USED');
    elsif v_ap.expires_at <= now() then
      return jsonb_build_object('status', 'EXPIRED');
    end if;
    return jsonb_build_object('status', 'APPROVED', 'approvalId', v_ap.id, 'expiresAt', v_ap.expires_at,
                              'approvedBy', (select display_name from public.profiles where id = v_ap.approved_by));
  end if;
  select * into v_rej from public.approval_rejections where request_id = v_req.id;
  if found then
    return jsonb_build_object('status', 'REJECTED', 'note', v_rej.note);
  end if;
  if v_req.expires_at <= now() then
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  return jsonb_build_object('status', 'PENDING', 'expiresAt', v_req.expires_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-VR-1..5 voids and refunds
-- ---------------------------------------------------------------------------
create or replace function public.lookup_sale_for_reversal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_label text;
  v_code text;
  v_no bigint;
  v_sale public.sales;
  v_window integer;
  v_has_rev boolean;
begin
  perform public._obj(p);
  v_me := public._me();
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  v_label := upper(public._j_text(p, 'receipt', true, 30));
  if v_label !~ '^[A-Z0-9]{1,6}-[0-9]{1,12}$' then
    perform public._err('INVALID_INPUT', 'receipt must look like T1-000123');
  end if;
  v_code := split_part(v_label, '-', 1);
  v_no := split_part(v_label, '-', 2)::bigint;
  select s.* into v_sale from public.sales s join public.registers r on r.id = s.register_id
   where s.store_id = v_me.store_id and r.code = v_code and s.receipt_no = v_no;
  if not found then
    perform public._err('NOT_FOUND', 'no sale with receipt ' || v_label);
  end if;
  select refund_window_days into v_window from public.store_settings where store_id = v_me.store_id;
  v_has_rev := exists (select 1 from public.sale_reversals where original_sale_id = v_sale.id);

  perform public._audit(v_me.store_id, 'lookup_sale_for_reversal', 'sale', v_sale.id::text, null, null);

  return jsonb_build_object(
    'saleId', v_sale.id,
    'receiptLabel', public._receipt_label(v_sale.register_id, v_sale.receipt_no),
    'createdAt', v_sale.created_at,
    'cashierName', (select display_name from public.profiles where id = v_sale.cashier_id),
    'totalCents', v_sale.total_cents,
    'sameShift', v_sale.shift_id = v_shift.id,
    'hasReversals', v_has_rev,
    'canVoid', v_sale.shift_id = v_shift.id and not v_has_rev,
    'withinRefundWindow', v_sale.created_at >= now() - make_interval(days => v_window),
    'lines', (select jsonb_agg(jsonb_build_object(
                       'saleLineId', l.id, 'name', l.product_name, 'qty', l.qty,
                       'unitPriceCents', l.unit_price_cents, 'lineTotalCents', l.line_total_cents,
                       'reversedQty', coalesce((select sum(rl.qty) from public.sale_reversal_lines rl where rl.sale_line_id = l.id), 0))
                     order by l.line_no)
                from public.sale_lines l where l.sale_id = v_sale.id),
    'payments', (select jsonb_agg(jsonb_build_object('method', pm.method, 'amountCents', pm.amount_cents) order by pm.seq)
                   from public.payments pm where pm.sale_id = v_sale.id));
end;
$$;

create or replace function public.reverse_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_set public.store_settings;
  v_sale public.sales;
  v_kind text;
  v_method text;
  v_ref text;
  v_note text;
  v_reason text;
  v_payload jsonb;
  v_approval uuid;
  v_approver uuid;
  v_rev_id uuid := gen_random_uuid();
  v_rl_id uuid;
  e jsonb;
  v_sl public.sale_lines;
  v_restock boolean;
  v_count integer;
  v_rev_total bigint;
  v_sales_total bigint;
  v_out_lines jsonb := '[]'::jsonb;
  v_label text;
begin
  perform public._obj(p);
  v_me := public._me();
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  select * into v_set from public.store_settings where store_id = v_me.store_id;

  -- Lock the original sale so two refunds of it cannot run at once.
  select * into v_sale from public.sales
   where id = public._j_uuid(p, 'saleId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'sale not found');
  end if;

  v_kind := public._j_text(p, 'kind', true, 10);
  v_method := public._j_text(p, 'refundMethod', true, 10);
  v_note := public._j_text(p, 'note', false, 500);
  v_reason := public._reason(p, public._reversal_reasons(), v_note);
  v_payload := public._reversal_payload(v_sale, v_kind, p -> 'lines', v_method, v_reason, v_shift);

  v_ref := public._j_text(p, 'refundRef', false, 32);
  if v_method = 'CASH' then
    if v_ref is not null then
      perform public._err('INVALID_INPUT', 'refundRef is only for M-Pesa or card refunds');
    end if;
  elsif v_method = 'MPESA' then
    v_ref := upper(coalesce(v_ref, ''));
    if v_ref !~ '^[A-Z0-9]{10}$' then
      perform public._err('INVALID_INPUT', 'refundRef must be the 10-character M-Pesa reversal code');
    end if;
    if exists (select 1 from public.sale_reversals where refund_method = 'MPESA' and refund_ref = v_ref) then
      perform public._err('MPESA_REF_USED', v_ref);
    end if;
  elsif v_ref is null or length(v_ref) < 4 then
    perform public._err('INVALID_INPUT', 'refundRef must be the 4 to 32 character card terminal reference');
  end if;

  -- FR-VR-2 / FR-VR-6: an owner approval token, unless the caller is an
  -- MFA-verified owner acting for themselves.
  v_approval := public._j_uuid(p, 'approvalId', false);
  if v_approval is null then
    if not public.is_owner() then
      perform public._err('APPROVAL_REQUIRED', 'a ' || lower(v_kind) || ' needs owner approval');
    end if;
    v_approver := v_me.id;
  else
    v_approver := public._consume_approval(v_approval, v_kind, v_sale.id, v_payload, v_me.id, v_shift.id);
  end if;

  perform 1 from public.stock_levels
   where product_id in (select l.product_id from public.sale_lines l where l.sale_id = v_sale.id)
   order by product_id for update;

  insert into public.sale_reversals (id, store_id, original_sale_id, kind, shift_id, register_id, requested_by,
                                     approved_by, approval_id, reason_code, note, refund_method, refund_ref,
                                     amount_cents)
  values (v_rev_id, v_me.store_id, v_sale.id, v_kind, v_shift.id, v_shift.register_id, v_me.id, v_approver,
          v_approval, v_reason, v_note, v_method, v_ref, (v_payload ->> 'amountCents')::bigint);

  -- FR-VR-4: reversing stock movement; damaged returns are written off.
  v_restock := v_reason <> 'DAMAGED';
  for e in select value from jsonb_array_elements(v_payload -> 'lines') loop
    select * into v_sl from public.sale_lines where id = (e ->> 'saleLineId')::uuid;
    v_rl_id := gen_random_uuid();
    insert into public.sale_reversal_lines (id, store_id, reversal_id, sale_line_id, product_id, qty, amount_cents, restocked)
    values (v_rl_id, v_me.store_id, v_rev_id, v_sl.id, v_sl.product_id, (e ->> 'qty')::integer,
            v_sl.unit_price_cents * (e ->> 'qty')::bigint, v_restock);
    insert into public.stock_movements (store_id, product_id, qty_delta, type, reason_code, ref_type, ref_id, actor_id)
    values (v_me.store_id, v_sl.product_id, (e ->> 'qty')::integer, v_kind, v_reason, 'sale_reversal_line', v_rl_id, v_me.id);
    if not v_restock then
      insert into public.stock_movements (store_id, product_id, qty_delta, type, reason_code, ref_type, ref_id, actor_id)
      values (v_me.store_id, v_sl.product_id, -(e ->> 'qty')::integer, 'DAMAGED', 'DAMAGED_RETURN',
              'sale_reversal_line', v_rl_id, v_me.id);
    end if;
    v_out_lines := v_out_lines || jsonb_build_array(jsonb_build_object(
      'name', v_sl.product_name, 'qty', (e ->> 'qty')::integer,
      'amountCents', v_sl.unit_price_cents * (e ->> 'qty')::bigint));
  end loop;

  -- HIGH_VOID_RATE: more than N reversals, or more than X% of shift sales value.
  select count(*), coalesce(sum(amount_cents), 0) into v_count, v_rev_total
    from public.sale_reversals where shift_id = v_shift.id;
  select coalesce(sum(total_cents), 0) into v_sales_total from public.sales where shift_id = v_shift.id;
  if v_count > v_set.void_count_threshold or v_rev_total * 10000 > v_set.void_rate_bps::bigint * v_sales_total then
    perform public._raise_alert(v_me.store_id, 'HIGH_VOID_RATE', 'HIGH',
      v_me.display_name || ' has ' || v_count || ' voids/refunds worth ' || public._kes(v_rev_total)
        || ' against ' || public._kes(v_sales_total) || ' of sales this shift',
      v_shift.id, v_me.id, v_shift.id,
      jsonb_build_object('count', v_count, 'reversedCents', v_rev_total, 'salesCents', v_sales_total),
      'HIGH_VOID_RATE:' || v_shift.id);
  end if;

  v_label := public._receipt_label(v_sale.register_id, v_sale.receipt_no);
  perform public._audit(v_me.store_id, 'reverse_sale', 'sale_reversal', v_rev_id::text, null,
    v_payload || jsonb_build_object('approvedBy', v_approver, 'refundRef', v_ref, 'note', v_note));
  perform public._notify_owner(v_me.store_id, 'reversal', jsonb_build_object(
    'reversalId', v_rev_id, 'kind', v_kind, 'receiptLabel', v_label, 'amountCents', v_payload -> 'amountCents',
    'refundMethod', v_method, 'cashier', v_me.display_name, 'at', now()));

  return jsonb_build_object(
    'reversalId', v_rev_id, 'kind', v_kind, 'receiptLabel', v_label,
    'amountCents', (v_payload ->> 'amountCents')::bigint, 'refundMethod', v_method, 'refundRef', v_ref,
    'reasonCode', v_reason, 'lines', v_out_lines, 'openDrawer', v_method = 'CASH',
    'cashierName', v_me.display_name, 'storeName', (select name from public.stores where id = v_me.store_id),
    'createdAt', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-SH-2 cash drops, paid-ins, paid-outs, no-sale
-- ---------------------------------------------------------------------------
create or replace function public.record_cash_movement(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_kind text;
  v_amount bigint;
  v_note text;
  v_reason text;
  v_approval uuid;
  v_approver uuid;
  v_id uuid := gen_random_uuid();
  v_code text;
begin
  perform public._obj(p);
  v_me := public._me();
  v_shift := public._own_open_shift(v_me, public._j_uuid(p, 'shiftId'));
  v_kind := public._j_text(p, 'kind', true, 20);
  if v_kind not in ('DROP', 'PAID_IN', 'PAID_OUT', 'NO_SALE') then
    perform public._err('INVALID_INPUT', 'kind must be DROP, PAID_IN, PAID_OUT or NO_SALE');
  end if;
  v_note := public._j_text(p, 'note', false, 500);
  v_reason := public._reason(p, public._cash_reasons(), v_note);
  if v_kind = 'NO_SALE' then
    if coalesce(public._j_int(p, 'amountCents', 0, 0, false), 0) <> 0 then
      perform public._err('INVALID_INPUT', 'a no-sale has no amount');
    end if;
    v_amount := 0;
  else
    v_amount := public._j_int(p, 'amountCents', 1, 100000000);
  end if;

  v_approval := public._j_uuid(p, 'approvalId', false);
  if v_kind in ('PAID_OUT', 'NO_SALE') then
    if v_approval is null then
      if not public.is_owner() then
        perform public._err('APPROVAL_REQUIRED', lower(replace(v_kind, '_', ' ')) || ' needs owner approval');
      end if;
      v_approver := v_me.id;
    else
      v_approver := public._consume_approval(v_approval, v_kind, v_shift.id,
        case v_kind when 'PAID_OUT' then jsonb_build_object('amountCents', v_amount, 'reasonCode', v_reason)
                    else jsonb_build_object('reasonCode', v_reason) end,
        v_me.id, v_shift.id);
    end if;
  elsif v_approval is not null then
    perform public._err('INVALID_INPUT', 'approvalId is only used for paid-outs and no-sales');
  end if;

  insert into public.cash_movements (id, store_id, shift_id, register_id, kind, amount_cents, reason_code, note,
                                     actor_id, approved_by, approval_id)
  values (v_id, v_me.store_id, v_shift.id, v_shift.register_id, v_kind, v_amount, v_reason, v_note,
          v_me.id, v_approver, v_approval);

  if v_kind = 'NO_SALE' then
    select code into v_code from public.registers where id = v_shift.register_id;
    perform public._raise_alert(v_me.store_id, 'NO_SALE_OPEN', 'MEDIUM',
      v_me.display_name || ' opened the ' || v_code || ' drawer without a sale (' || v_reason || ')',
      v_shift.id, v_me.id, v_id, jsonb_build_object('approvedBy', v_approver, 'note', v_note), null);
  end if;

  perform public._audit(v_me.store_id, 'record_cash_movement', 'cash_movement', v_id::text, null,
    jsonb_build_object('kind', v_kind, 'amountCents', v_amount, 'reasonCode', v_reason, 'note', v_note,
                       'approvedBy', v_approver));
  perform public._notify_owner(v_me.store_id, 'cash_movement', jsonb_build_object(
    'kind', v_kind, 'amountCents', v_amount, 'cashier', v_me.display_name, 'at', now()));

  return jsonb_build_object('movementId', v_id, 'kind', v_kind, 'amountCents', v_amount, 'openDrawer', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-SH-3..6 blind close count
-- ---------------------------------------------------------------------------
create or replace function public.commit_close_count(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_set public.store_settings;
  d jsonb;
  v_counted bigint;
  v_expected bigint;
  v_variance bigint;
  v_over boolean;
  v_status text;
  v_code text;
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_shift from public.shifts
   where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id
   for update;
  if not found or (v_shift.cashier_id <> v_me.id and not public.is_owner()) then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  if v_shift.status not in ('OPEN', 'PENDING_COUNT') then
    perform public._err('COUNT_ALREADY_COMMITTED');
  end if;
  -- An owner counts someone else's drawer only after force-closing it.
  if v_shift.cashier_id <> v_me.id and v_shift.status <> 'PENDING_COUNT' then
    perform public._err('FORBIDDEN', 'force-close the shift before counting another cashier''s drawer');
  end if;

  d := public._denoms(p -> 'denominations');
  v_counted := public._denom_cents(d);
  v_expected := public._expected_cash(v_shift.id);
  v_variance := v_counted - v_expected;
  select * into v_set from public.store_settings where store_id = v_me.store_id;
  v_over := abs(v_variance) > v_set.variance_threshold_cents;
  v_status := case when v_over then 'CLOSED_UNRECONCILED' else 'CLOSED' end;

  begin
    perform public._insert_cash_count(v_me.store_id, v_shift.id, 'CLOSING', v_me.id, d, v_expected, v_variance);
  exception when unique_violation then
    perform public._err('COUNT_ALREADY_COMMITTED');
  end;

  update public.shifts
     set status = v_status, closed_at = now(), closed_by = v_me.id,
         expected_cash_cents = v_expected, counted_cash_cents = v_counted, variance_cents = v_variance,
         variance_flagged = v_variance <> 0
   where id = v_shift.id;

  select code into v_code from public.registers where id = v_shift.register_id;
  if v_over then
    perform public._raise_alert(v_me.store_id, 'CASH_VARIANCE', 'HIGH',
      v_code || ' closed ' || public._kes(v_variance) || ' against expected cash ('
        || (select display_name from public.profiles where id = v_shift.cashier_id) || ')',
      v_shift.id, v_shift.cashier_id, v_shift.id,
      jsonb_build_object('expectedCents', v_expected, 'countedCents', v_counted, 'varianceCents', v_variance),
      'CASH_VARIANCE:' || v_shift.id || ':CLOSING');
  end if;

  perform public._audit(v_me.store_id, 'commit_close_count', 'shift', v_shift.id::text,
    jsonb_build_object('status', v_shift.status),
    jsonb_build_object('status', v_status, 'expectedCents', v_expected, 'countedCents', v_counted,
                       'varianceCents', v_variance, 'denominations', d));
  perform public._notify_owner(v_me.store_id, 'shift', jsonb_build_object(
    'kind', 'closed', 'shiftId', v_shift.id, 'registerCode', v_code, 'status', v_status,
    'varianceCents', v_variance, 'at', now()));

  -- The cashier learns their own result only now, after the count is committed.
  return jsonb_build_object('shiftId', v_shift.id, 'status', v_status, 'countedCents', v_counted,
                            'varianceCents', v_variance, 'flagged', v_variance <> 0, 'overThreshold', v_over);
end;
$$;

-- Never returns expected cash or variance to a cashier before their count.
create or replace function public.shift_status_for_cashier(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_owner boolean;
  v_out jsonb;
  v_count public.cash_counts;
begin
  perform public._obj(p);
  v_me := public._me();
  v_owner := public.is_owner();
  select * into v_shift from public.shifts where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id;
  if not found or (v_shift.cashier_id <> v_me.id and not v_owner) then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  select * into v_count from public.cash_counts where shift_id = v_shift.id and kind = 'CLOSING';

  v_out := jsonb_build_object(
    'shiftId', v_shift.id, 'status', v_shift.status, 'openedAt', v_shift.opened_at, 'closedAt', v_shift.closed_at,
    'registerCode', (select code from public.registers where id = v_shift.register_id),
    'countCommitted', v_count.id is not null);
  if v_count.id is not null then
    v_out := v_out || jsonb_build_object('countedCents', v_shift.counted_cash_cents,
                                         'varianceCents', v_shift.variance_cents,
                                         'flagged', v_shift.variance_flagged);
  end if;
  if v_owner then
    v_out := v_out || jsonb_build_object('expectedCents',
      coalesce(v_shift.expected_cash_cents, public._expected_cash(v_shift.id)));
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Till lock: unlock with the signed-in user's own PIN
-- ---------------------------------------------------------------------------
create or replace function public.verify_my_pin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_pin text;
  v_locked timestamptz;
  v_fails integer;
  v_ok boolean;
begin
  perform public._obj(p);
  v_me := public._me();
  if v_me.pin_hash is null then
    perform public._err('PIN_NOT_SET', 'ask the owner to set your PIN');
  end if;
  v_locked := public._pin_locked_until('TILL_UNLOCK', null, v_me.id);
  if v_locked is not null then
    return jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'lockedUntil', v_locked);
  end if;
  v_pin := case when jsonb_typeof(p -> 'pin') = 'string' then p ->> 'pin' end;
  v_ok := v_pin ~ '^[0-9]{6}$' and v_me.pin_hash = extensions.crypt(v_pin, v_me.pin_hash);
  v_ok := coalesce(v_ok, false);

  insert into public.pin_attempts (store_id, kind, actor_id, matched_profile_id, success)
  values (v_me.store_id, 'TILL_UNLOCK', v_me.id, case when v_ok then v_me.id end, v_ok);
  perform public._audit(v_me.store_id, 'verify_my_pin', 'profile', v_me.id::text, null, jsonb_build_object('ok', v_ok));
  if v_ok then
    return jsonb_build_object('ok', true);
  end if;

  v_fails := public._pin_recent_failures('TILL_UNLOCK', null, v_me.id);
  if v_fails >= 5 then
    v_locked := now() + interval '15 minutes';
    insert into public.pin_lockouts (store_id, actor_id, kind, locked_until)
    values (v_me.store_id, v_me.id, 'TILL_UNLOCK', v_locked);
    perform public._raise_alert(v_me.store_id, 'PIN_LOCKOUT', 'HIGH',
      '5 wrong unlock PINs for ' || v_me.display_name || '; till unlock locked 15 minutes',
      null, v_me.id, v_me.id, jsonb_build_object('kind', 'TILL_UNLOCK', 'lockedUntil', v_locked), null);
    return jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'lockedUntil', v_locked);
  end if;
  return jsonb_build_object('ok', false, 'error', 'BAD_PIN', 'attemptsLeft', 5 - v_fails);
end;
$$;
