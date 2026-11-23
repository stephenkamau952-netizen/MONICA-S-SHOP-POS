-- =============================================================================
-- Monica's Shop POS — 5/6 owner RPCs, dashboard, scheduled jobs, bootstrap
--
-- Owner RPCs call public._require_owner(): active OWNER profile + aal2 (MFA).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Approvals from the dashboard
-- ---------------------------------------------------------------------------
create or replace function public.approve_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_req public.approval_requests;
  v_ttl integer;
  v_id uuid := gen_random_uuid();
  v_expires timestamptz;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_req from public.approval_requests
   where id = public._j_uuid(p, 'requestId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'approval request not found');
  end if;
  if v_req.requested_by = v_me.id then
    perform public._err('SELF_APPROVAL', 'you cannot approve your own request');
  end if;
  if exists (select 1 from public.approvals where request_id = v_req.id)
     or exists (select 1 from public.approval_rejections where request_id = v_req.id) then
    perform public._err('APPROVAL_ALREADY_DECIDED');
  end if;
  if v_req.expires_at <= now() then
    perform public._err('APPROVAL_EXPIRED', 'the request expired');
  end if;
  select approval_ttl_seconds into v_ttl from public.store_settings where store_id = v_me.store_id;
  v_expires := now() + make_interval(secs => v_ttl);
  insert into public.approvals (id, store_id, request_id, action, target_id, payload, requested_by, approved_by,
                                channel, expires_at)
  values (v_id, v_me.store_id, v_req.id, v_req.action, v_req.target_id, v_req.payload, v_req.requested_by,
          v_me.id, 'DASHBOARD', v_expires);
  perform public._audit(v_me.store_id, 'approve_request', 'approval', v_id::text, null,
    jsonb_build_object('requestId', v_req.id, 'action', v_req.action, 'summary', v_req.summary));
  perform public._notify_owner(v_me.store_id, 'approval', jsonb_build_object(
    'requestId', v_req.id, 'approvalId', v_id, 'channel', 'DASHBOARD', 'summary', v_req.summary, 'at', now()));
  return jsonb_build_object('approvalId', v_id, 'expiresAt', v_expires);
end;
$$;

create or replace function public.reject_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_req public.approval_requests;
  v_note text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_req from public.approval_requests
   where id = public._j_uuid(p, 'requestId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'approval request not found');
  end if;
  if exists (select 1 from public.approvals where request_id = v_req.id)
     or exists (select 1 from public.approval_rejections where request_id = v_req.id) then
    perform public._err('APPROVAL_ALREADY_DECIDED');
  end if;
  v_note := public._j_text(p, 'note', false, 500);
  insert into public.approval_rejections (request_id, store_id, rejected_by, note)
  values (v_req.id, v_me.store_id, v_me.id, v_note);
  perform public._audit(v_me.store_id, 'reject_request', 'approval_request', v_req.id::text, null,
    jsonb_build_object('note', v_note, 'summary', v_req.summary));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Shift supervision
-- ---------------------------------------------------------------------------
create or replace function public.owner_force_close_shift(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_reason text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_shift from public.shifts
   where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  if v_shift.status <> 'OPEN' then
    perform public._err('SHIFT_NOT_OPEN');
  end if;
  v_reason := public._j_text(p, 'reason', true, 500);
  update public.shifts
     set status = 'PENDING_COUNT', forced_close_at = now(), forced_close_by = v_me.id, forced_close_reason = v_reason
   where id = v_shift.id;
  perform public._audit(v_me.store_id, 'owner_force_close_shift', 'shift', v_shift.id::text,
    jsonb_build_object('status', 'OPEN'), jsonb_build_object('status', 'PENDING_COUNT', 'reason', v_reason));
  perform public._notify_owner(v_me.store_id, 'shift', jsonb_build_object(
    'kind', 'force_closed', 'shiftId', v_shift.id, 'at', now()));
  return jsonb_build_object('shiftId', v_shift.id, 'status', 'PENDING_COUNT');
end;
$$;

-- FR-SH-4: only the owner starts a recount; it is a second cash_counts row
-- and both counts stay visible.
create or replace function public.owner_recount_shift(p jsonb)
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
  v_variance bigint;
  v_over boolean;
  v_status text;
  v_count_id uuid;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_shift from public.shifts
   where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  if v_shift.status not in ('CLOSED', 'CLOSED_UNRECONCILED') then
    perform public._err('INVALID_INPUT', 'only a closed shift can be recounted');
  end if;
  d := public._denoms(p -> 'denominations');
  v_counted := public._denom_cents(d);
  v_variance := v_counted - v_shift.expected_cash_cents;
  select * into v_set from public.store_settings where store_id = v_me.store_id;
  v_over := abs(v_variance) > v_set.variance_threshold_cents;
  v_status := case
                when v_over then 'CLOSED_UNRECONCILED'
                when v_shift.status = 'CLOSED_UNRECONCILED' then 'CLOSED'
                else v_shift.status
              end;
  v_count_id := public._insert_cash_count(v_me.store_id, v_shift.id, 'RECOUNT', v_me.id, d,
                                          v_shift.expected_cash_cents, v_variance);
  update public.shifts
     set counted_cash_cents = v_counted, variance_cents = v_variance, variance_flagged = v_variance <> 0,
         status = v_status
   where id = v_shift.id;
  if v_over then
    perform public._raise_alert(v_me.store_id, 'CASH_VARIANCE', 'HIGH',
      'Recount still ' || public._kes(v_variance) || ' against expected cash',
      v_shift.id, v_shift.cashier_id, v_shift.id,
      jsonb_build_object('expectedCents', v_shift.expected_cash_cents, 'countedCents', v_counted,
                         'varianceCents', v_variance, 'recount', true),
      'CASH_VARIANCE:' || v_shift.id || ':RECOUNT:' || v_count_id);
  end if;
  perform public._audit(v_me.store_id, 'owner_recount_shift', 'shift', v_shift.id::text,
    jsonb_build_object('countedCents', v_shift.counted_cash_cents, 'varianceCents', v_shift.variance_cents,
                       'status', v_shift.status),
    jsonb_build_object('countedCents', v_counted, 'varianceCents', v_variance, 'status', v_status, 'denominations', d));
  return jsonb_build_object('shiftId', v_shift.id, 'status', v_status, 'countedCents', v_counted,
                            'expectedCents', v_shift.expected_cash_cents, 'varianceCents', v_variance);
end;
$$;

create or replace function public.owner_acknowledge_shift(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_note text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_shift from public.shifts
   where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  if not (v_shift.status = 'CLOSED_UNRECONCILED'
          or (v_shift.status = 'CLOSED' and v_shift.variance_flagged and v_shift.acknowledged_at is null)) then
    perform public._err('INVALID_INPUT', 'this shift has nothing to acknowledge');
  end if;
  v_note := public._j_text(p, 'note', true, 500);
  if length(v_note) < 3 then
    perform public._err('INVALID_INPUT', 'write a short note explaining the variance');
  end if;
  update public.shifts
     set status = 'CLOSED', acknowledged_at = now(), acknowledged_by = v_me.id, acknowledgement_note = v_note
   where id = v_shift.id;
  update public.alerts
     set acknowledged_at = now(), acknowledged_by = v_me.id, ack_note = v_note
   where shift_id = v_shift.id and type = 'CASH_VARIANCE' and acknowledged_at is null;
  perform public._audit(v_me.store_id, 'owner_acknowledge_shift', 'shift', v_shift.id::text,
    jsonb_build_object('status', v_shift.status), jsonb_build_object('status', 'CLOSED', 'note', v_note));
  return jsonb_build_object('shiftId', v_shift.id, 'status', 'CLOSED');
end;
$$;

-- Correcting entry instead of editing a count (positive = more cash expected).
create or replace function public.owner_cash_adjustment(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
  v_amount bigint;
  v_note text;
  v_reason text;
  v_id uuid := gen_random_uuid();
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_shift from public.shifts where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id;
  if not found then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  v_amount := public._j_int(p, 'amountCents', -100000000, 100000000);
  if v_amount = 0 then
    perform public._err('INVALID_INPUT', 'amountCents cannot be zero');
  end if;
  v_note := public._j_text(p, 'note', true, 500);
  v_reason := public._reason(p, public._cash_reasons(), v_note);
  insert into public.cash_movements (id, store_id, shift_id, register_id, kind, amount_cents, reason_code, note,
                                     actor_id, approved_by)
  values (v_id, v_me.store_id, v_shift.id, v_shift.register_id, 'ADJUSTMENT', v_amount, v_reason, v_note,
          v_me.id, v_me.id);
  perform public._audit(v_me.store_id, 'owner_cash_adjustment', 'cash_movement', v_id::text, null,
    jsonb_build_object('shiftId', v_shift.id, 'amountCents', v_amount, 'reasonCode', v_reason, 'note', v_note));
  return jsonb_build_object('movementId', v_id);
end;
$$;

create or replace function public.owner_acknowledge_alert(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_alert public.alerts;
  v_note text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_alert from public.alerts
   where id = public._j_uuid(p, 'alertId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'alert not found');
  end if;
  if v_alert.acknowledged_at is not null then
    perform public._err('INVALID_INPUT', 'alert already acknowledged');
  end if;
  v_note := public._j_text(p, 'note', false, 500);
  update public.alerts set acknowledged_at = now(), acknowledged_by = v_me.id, ack_note = v_note
   where id = v_alert.id;
  perform public._audit(v_me.store_id, 'owner_acknowledge_alert', 'alert', v_alert.id::text, null,
    jsonb_build_object('note', v_note));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue and inventory
-- ---------------------------------------------------------------------------
create or replace function public.owner_upsert_product(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_id uuid;
  v_old public.products;
  v_new public.products;
  v_sku text;
  v_barcode text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  v_id := public._j_uuid(p, 'id', false);
  v_sku := public._j_text(p, 'sku', true, 40);
  if v_sku !~ '^[A-Za-z0-9._-]{1,40}$' then
    perform public._err('INVALID_INPUT', 'sku may use letters, digits, dot, dash and underscore');
  end if;
  v_barcode := public._j_text(p, 'barcode', false, 64);
  if v_barcode is not null and v_barcode !~ '^[0-9A-Za-z-]{4,64}$' then
    perform public._err('INVALID_INPUT', 'barcode must be 4 to 64 letters, digits or dashes');
  end if;

  begin
    if v_id is null then
      insert into public.products (store_id, sku, barcode, name, price_cents, reorder_level, active)
      values (v_me.store_id, v_sku, v_barcode, public._j_text(p, 'name', true, 120),
              public._j_int(p, 'priceCents', 0, 100000000), coalesce(public._j_int(p, 'reorderLevel', 0, 1000000, false), 0),
              public._j_bool(p, 'active', true))
      returning * into v_new;
      insert into public.product_costs (product_id, store_id, avg_cost_cents) values (v_new.id, v_me.store_id, 0);
    else
      select * into v_old from public.products where id = v_id and store_id = v_me.store_id for update;
      if not found then
        perform public._err('NOT_FOUND', 'product not found');
      end if;
      update public.products
         set sku = v_sku, barcode = v_barcode, name = public._j_text(p, 'name', true, 120),
             price_cents = public._j_int(p, 'priceCents', 0, 100000000),
             reorder_level = coalesce(public._j_int(p, 'reorderLevel', 0, 1000000, false), v_old.reorder_level),
             active = public._j_bool(p, 'active', v_old.active)
       where id = v_id
       returning * into v_new;
    end if;
  exception when unique_violation then
    perform public._err('DUPLICATE_PRODUCT', 'that SKU or barcode is already used by another product');
  end;

  perform public._audit(v_me.store_id, 'owner_upsert_product', 'product', v_new.id::text,
    case when v_old.id is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  return to_jsonb(v_new);
end;
$$;

-- FR-IN-3 receiving updates weighted-average cost.
create or replace function public.receive_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_prod public.products;
  v_qty bigint;
  v_unit bigint;
  v_supplier text;
  v_note text;
  v_on_hand integer;
  v_avg numeric;
  v_base bigint;
  v_new_avg numeric;
  v_id uuid := gen_random_uuid();
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_prod from public.products
   where id = public._j_uuid(p, 'productId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'product not found');
  end if;
  v_qty := public._j_int(p, 'qty', 1, 1000000);
  v_unit := public._j_int(p, 'unitCostCents', 0, 100000000);
  v_supplier := public._j_text(p, 'supplier', true, 120);
  v_note := public._j_text(p, 'note', false, 500);

  perform 1 from public.stock_levels where product_id = v_prod.id for update;
  v_on_hand := coalesce((select on_hand from public.stock_levels where product_id = v_prod.id), 0);
  select avg_cost_cents into v_avg from public.product_costs where product_id = v_prod.id for update;
  v_avg := coalesce(v_avg, 0);
  v_base := greatest(v_on_hand, 0);
  v_new_avg := round((v_base * v_avg + v_qty * v_unit) / (v_base + v_qty), 4);

  insert into public.product_costs as pc (product_id, store_id, avg_cost_cents, updated_at)
  values (v_prod.id, v_me.store_id, v_new_avg, now())
  on conflict (product_id) do update set avg_cost_cents = excluded.avg_cost_cents, updated_at = now();

  insert into public.stock_movements (id, store_id, product_id, qty_delta, type, reason_code, ref_type, actor_id,
                                      unit_cost_cents, supplier, note)
  values (v_id, v_me.store_id, v_prod.id, v_qty, 'RECEIVE', 'DELIVERY', 'delivery', v_me.id, v_unit, v_supplier, v_note);

  perform public._audit(v_me.store_id, 'receive_stock', 'stock_movement', v_id::text,
    jsonb_build_object('onHand', v_on_hand, 'avgCostCents', v_avg),
    jsonb_build_object('productId', v_prod.id, 'qty', v_qty, 'unitCostCents', v_unit, 'supplier', v_supplier,
                       'onHand', v_on_hand + v_qty, 'avgCostCents', v_new_avg));
  perform public._notify_owner(v_me.store_id, 'stock', jsonb_build_object('kind', 'receive', 'productId', v_prod.id, 'at', now()));
  return jsonb_build_object('movementId', v_id, 'productId', v_prod.id, 'onHand', v_on_hand + v_qty,
                            'avgCostCents', v_new_avg);
end;
$$;

create or replace function public.adjust_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_prod public.products;
  v_delta bigint;
  v_note text;
  v_reason text;
  v_type text;
  v_on_hand integer;
  v_allow boolean;
  v_id uuid := gen_random_uuid();
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_prod from public.products
   where id = public._j_uuid(p, 'productId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'product not found');
  end if;
  v_delta := public._j_int(p, 'qtyDelta', -1000000, 1000000);
  if v_delta = 0 then
    perform public._err('INVALID_INPUT', 'qtyDelta cannot be zero');
  end if;
  v_note := public._j_text(p, 'note', false, 500);
  v_reason := public._reason(p, public._stock_reasons(), v_note);
  if v_reason in ('LOST', 'THEFT', 'EXPIRED', 'DAMAGED') and v_delta > 0 then
    perform public._err('INVALID_INPUT', v_reason || ' must reduce stock (negative qtyDelta)');
  end if;
  if v_reason = 'FOUND' and v_delta < 0 then
    perform public._err('INVALID_INPUT', 'FOUND must add stock (positive qtyDelta)');
  end if;
  v_type := case when v_reason = 'DAMAGED' then 'DAMAGED' else 'ADJUST' end;

  perform 1 from public.stock_levels where product_id = v_prod.id for update;
  v_on_hand := coalesce((select on_hand from public.stock_levels where product_id = v_prod.id), 0);
  select allow_negative_stock into v_allow from public.store_settings where store_id = v_me.store_id;
  if v_on_hand + v_delta < 0 and not v_allow then
    perform public._err('INSUFFICIENT_STOCK', v_prod.name || ': ' || greatest(v_on_hand, 0) || ' in stock');
  end if;

  insert into public.stock_movements (id, store_id, product_id, qty_delta, type, reason_code, ref_type, actor_id, note)
  values (v_id, v_me.store_id, v_prod.id, v_delta, v_type, v_reason, 'adjustment', v_me.id, v_note);

  perform public._audit(v_me.store_id, 'adjust_stock', 'stock_movement', v_id::text,
    jsonb_build_object('onHand', v_on_hand),
    jsonb_build_object('productId', v_prod.id, 'qtyDelta', v_delta, 'reasonCode', v_reason, 'note', v_note,
                       'onHand', v_on_hand + v_delta));
  return jsonb_build_object('movementId', v_id, 'productId', v_prod.id, 'onHand', v_on_hand + v_delta);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-IN-4 blind stock counts
-- ---------------------------------------------------------------------------
create or replace function public.open_stock_count(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_assignee uuid;
  v_ids jsonb := p -> 'productIds';
  v_all boolean;
  v_id uuid := gen_random_uuid();
  v_n integer;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  v_assignee := public._j_uuid(p, 'assignedTo', false);
  if v_assignee is not null
     and not exists (select 1 from public.profiles where id = v_assignee and store_id = v_me.store_id and active) then
    perform public._err('NOT_FOUND', 'staff member not found');
  end if;
  v_all := public._j_bool(p, 'allProducts', false);
  if not v_all and (v_ids is null or jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) not between 1 and 5000) then
    perform public._err('INVALID_INPUT', 'choose 1 to 5000 products, or allProducts');
  end if;

  begin
    insert into public.stock_counts (id, store_id, assigned_to, note, opened_by)
    values (v_id, v_me.store_id, v_assignee, public._j_text(p, 'note', false, 500), v_me.id);
  exception when unique_violation then
    perform public._err('STOCK_COUNT_ALREADY_OPEN');
  end;

  if v_all then
    insert into public.stock_count_items (count_id, product_id, store_id)
    select v_id, id, v_me.store_id from public.products where store_id = v_me.store_id and active;
  else
    if exists (select 1 from jsonb_array_elements(v_ids) x
                where jsonb_typeof(x) <> 'string'
                   or (x #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
      perform public._err('INVALID_INPUT', 'productIds must be UUIDs');
    end if;
    insert into public.stock_count_items (count_id, product_id, store_id)
    select distinct v_id, pr.id, v_me.store_id
      from jsonb_array_elements_text(v_ids) x
      join public.products pr on pr.id = x::uuid and pr.store_id = v_me.store_id;
  end if;
  select count(*) into v_n from public.stock_count_items where count_id = v_id;
  if v_n = 0 then
    perform public._err('INVALID_INPUT', 'no matching products to count');
  end if;

  perform public._audit(v_me.store_id, 'open_stock_count', 'stock_count', v_id::text, null,
    jsonb_build_object('items', v_n, 'assignedTo', v_assignee));
  return jsonb_build_object('countId', v_id, 'items', v_n);
end;
$$;

-- What a counter sees: names and barcodes, never system quantities.
create or replace function public.my_stock_count()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_count public.stock_counts;
begin
  v_me := public._me();
  select * into v_count from public.stock_counts
   where store_id = v_me.store_id and status = 'OPEN'
     and (assigned_to = v_me.id or public.is_owner())
   limit 1;
  if not found then
    return jsonb_build_object('count', null);
  end if;
  return jsonb_build_object(
    'count', jsonb_build_object('id', v_count.id, 'note', v_count.note, 'openedAt', v_count.opened_at),
    'items', (select jsonb_agg(jsonb_build_object(
                       'productId', pr.id, 'name', pr.name, 'sku', pr.sku, 'barcode', pr.barcode,
                       'countedQty', (select l.counted_qty from public.stock_count_lines l
                                       where l.count_id = v_count.id and l.product_id = pr.id
                                         and l.counted_by = v_me.id
                                       order by l.created_at desc limit 1))
                     order by pr.name)
                from public.stock_count_items i join public.products pr on pr.id = i.product_id
               where i.count_id = v_count.id));
end;
$$;

create or replace function public.record_count_line(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_count public.stock_counts;
  v_pid uuid;
  v_qty bigint;
  v_sys integer;
  v_id uuid := gen_random_uuid();
begin
  perform public._obj(p);
  v_me := public._me();
  select * into v_count from public.stock_counts
   where id = public._j_uuid(p, 'countId') and store_id = v_me.store_id
   for share;
  if not found or (v_count.assigned_to is distinct from v_me.id and not public.is_owner()) then
    perform public._err('NOT_FOUND', 'stock count not found');
  end if;
  if v_count.status <> 'OPEN' then
    perform public._err('COUNT_NOT_OPEN');
  end if;
  v_pid := public._j_uuid(p, 'productId');
  if not exists (select 1 from public.stock_count_items where count_id = v_count.id and product_id = v_pid) then
    perform public._err('INVALID_INPUT', 'that product is not part of this count');
  end if;
  v_qty := public._j_int(p, 'countedQty', 0, 1000000);
  v_sys := coalesce((select on_hand from public.stock_levels where product_id = v_pid), 0);
  insert into public.stock_count_lines (id, store_id, count_id, product_id, counted_qty, system_qty, counted_by)
  values (v_id, v_me.store_id, v_count.id, v_pid, v_qty, v_sys, v_me.id);
  perform public._audit(v_me.store_id, 'record_count_line', 'stock_count', v_count.id::text, null,
    jsonb_build_object('productId', v_pid, 'countedQty', v_qty));
  return jsonb_build_object('ok', true, 'lineId', v_id);
end;
$$;

-- On posting, each counted product's latest line is compared with the system
-- quantity at the moment it was counted; differences post as COUNT_VARIANCE.
create or replace function public.post_stock_count(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_count public.stock_counts;
  r record;
  v_report jsonb := '[]'::jsonb;
  v_value numeric := 0;
  v_avg numeric;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_count from public.stock_counts
   where id = public._j_uuid(p, 'countId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'stock count not found');
  end if;
  if v_count.status <> 'OPEN' then
    perform public._err('COUNT_NOT_OPEN');
  end if;

  perform 1 from public.stock_levels
   where product_id in (select product_id from public.stock_count_items where count_id = v_count.id)
   order by product_id for update;

  for r in
    select distinct on (l.product_id) l.product_id, l.counted_qty, l.system_qty, pr.name
      from public.stock_count_lines l join public.products pr on pr.id = l.product_id
     where l.count_id = v_count.id
     order by l.product_id, l.created_at desc, l.id desc
  loop
    v_avg := coalesce((select avg_cost_cents from public.product_costs where product_id = r.product_id), 0);
    if r.counted_qty <> r.system_qty then
      insert into public.stock_movements (store_id, product_id, qty_delta, type, reason_code, ref_type, ref_id, actor_id)
      values (v_me.store_id, r.product_id, r.counted_qty - r.system_qty, 'COUNT_VARIANCE', 'STOCK_COUNT',
              'stock_count', v_count.id, v_me.id);
    end if;
    v_value := v_value + (r.counted_qty - r.system_qty) * v_avg;
    v_report := v_report || jsonb_build_array(jsonb_build_object(
      'productId', r.product_id, 'name', r.name, 'systemQty', r.system_qty, 'countedQty', r.counted_qty,
      'diff', r.counted_qty - r.system_qty, 'valueCents', round((r.counted_qty - r.system_qty) * v_avg)::bigint));
  end loop;

  update public.stock_counts set status = 'POSTED', closed_by = v_me.id, closed_at = now() where id = v_count.id;
  perform public._audit(v_me.store_id, 'post_stock_count', 'stock_count', v_count.id::text, null,
    jsonb_build_object('lines', v_report, 'valueCents', round(v_value)::bigint));
  return jsonb_build_object('countId', v_count.id, 'lines', v_report, 'varianceValueCents', round(v_value)::bigint,
    'uncounted', (select count(*) from public.stock_count_items i
                   where i.count_id = v_count.id
                     and not exists (select 1 from public.stock_count_lines l
                                      where l.count_id = i.count_id and l.product_id = i.product_id)));
end;
$$;

create or replace function public.cancel_stock_count(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_count public.stock_counts;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_count from public.stock_counts
   where id = public._j_uuid(p, 'countId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'stock count not found');
  end if;
  if v_count.status <> 'OPEN' then
    perform public._err('COUNT_NOT_OPEN');
  end if;
  update public.stock_counts set status = 'CANCELLED', closed_by = v_me.id, closed_at = now() where id = v_count.id;
  perform public._audit(v_me.store_id, 'cancel_stock_count', 'stock_count', v_count.id::text, null, null);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.owner_stock_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'status', c.status, 'note', c.note, 'openedAt', c.opened_at, 'closedAt', c.closed_at,
             'assignedTo', c.assigned_to, 'assignedName', (select display_name from public.profiles where id = c.assigned_to),
             'items', (select count(*) from public.stock_count_items i where i.count_id = c.id),
             'counted', (select count(distinct l.product_id) from public.stock_count_lines l where l.count_id = c.id))
           order by c.opened_at desc)
      from (select * from public.stock_counts where store_id = v_me.store_id order by opened_at desc limit 50) c), '[]'::jsonb);
end;
$$;

create or replace function public.owner_stock_count_detail(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_count public.stock_counts;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_count from public.stock_counts where id = public._j_uuid(p, 'countId') and store_id = v_me.store_id;
  if not found then
    perform public._err('NOT_FOUND', 'stock count not found');
  end if;
  return jsonb_build_object(
    'id', v_count.id, 'status', v_count.status, 'note', v_count.note,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                       'productId', pr.id, 'name', pr.name, 'sku', pr.sku,
                       'onHandNow', coalesce(sl.on_hand, 0),
                       'countedQty', lastl.counted_qty, 'systemQtyAtCount', lastl.system_qty,
                       'diff', lastl.counted_qty - lastl.system_qty,
                       'countedBy', (select display_name from public.profiles where id = lastl.counted_by))
                     order by pr.name), '[]'::jsonb)
                from public.stock_count_items i
                join public.products pr on pr.id = i.product_id
                left join public.stock_levels sl on sl.product_id = pr.id
                left join lateral (select l.* from public.stock_count_lines l
                                    where l.count_id = i.count_id and l.product_id = i.product_id
                                    order by l.created_at desc, l.id desc limit 1) lastl on true
               where i.count_id = v_count.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings, registers, staff
-- ---------------------------------------------------------------------------
create or replace function public.owner_update_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_old public.store_settings;
  v_new public.store_settings;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_old from public.store_settings where store_id = v_me.store_id for update;
  update public.store_settings set
    variance_threshold_cents    = coalesce(public._j_int(p, 'varianceThresholdCents', 0, 100000000, false), variance_threshold_cents),
    stale_shift_hours           = coalesce(public._j_int(p, 'staleShiftHours', 1, 72, false), stale_shift_hours),
    allow_negative_stock        = public._j_bool(p, 'allowNegativeStock', allow_negative_stock),
    refund_window_days          = coalesce(public._j_int(p, 'refundWindowDays', 0, 365, false), refund_window_days),
    void_count_threshold        = coalesce(public._j_int(p, 'voidCountThreshold', 0, 1000, false), void_count_threshold),
    void_rate_bps               = coalesce(public._j_int(p, 'voidRateBps', 0, 10000, false), void_rate_bps),
    override_batch_threshold    = coalesce(public._j_int(p, 'overrideBatchThreshold', 0, 1000, false), override_batch_threshold),
    cart_line_removal_threshold = coalesce(public._j_int(p, 'cartLineRemovalThreshold', 0, 1000, false), cart_line_removal_threshold),
    cart_cancel_threshold       = coalesce(public._j_int(p, 'cartCancelThreshold', 0, 1000, false), cart_cancel_threshold),
    till_idle_lock_seconds      = coalesce(public._j_int(p, 'tillIdleLockSeconds', 30, 3600, false), till_idle_lock_seconds),
    approval_ttl_seconds        = coalesce(public._j_int(p, 'approvalTtlSeconds', 30, 600, false), approval_ttl_seconds),
    updated_at = now(), updated_by = v_me.id
  where store_id = v_me.store_id
  returning * into v_new;
  perform public._audit(v_me.store_id, 'owner_update_settings', 'store_settings', v_me.store_id::text,
                        to_jsonb(v_old), to_jsonb(v_new));
  return public.owner_settings();
end;
$$;

create or replace function public.owner_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
  s public.store_settings;
begin
  select * into s from public.store_settings where store_id = v_me.store_id;
  return jsonb_build_object(
    'varianceThresholdCents', s.variance_threshold_cents, 'staleShiftHours', s.stale_shift_hours,
    'allowNegativeStock', s.allow_negative_stock, 'refundWindowDays', s.refund_window_days,
    'voidCountThreshold', s.void_count_threshold, 'voidRateBps', s.void_rate_bps,
    'overrideBatchThreshold', s.override_batch_threshold, 'cartLineRemovalThreshold', s.cart_line_removal_threshold,
    'cartCancelThreshold', s.cart_cancel_threshold, 'tillIdleLockSeconds', s.till_idle_lock_seconds,
    'approvalTtlSeconds', s.approval_ttl_seconds, 'updatedAt', s.updated_at);
end;
$$;

create or replace function public.owner_upsert_register(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_id uuid;
  v_old public.registers;
  v_new public.registers;
  v_code text;
  v_active boolean;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  v_id := public._j_uuid(p, 'id', false);
  begin
    if v_id is null then
      v_code := upper(public._j_text(p, 'code', true, 6));
      if v_code !~ '^[A-Z0-9]{1,6}$' then
        perform public._err('INVALID_INPUT', 'code must be 1 to 6 letters or digits');
      end if;
      insert into public.registers (store_id, code, name, float_cents, active)
      values (v_me.store_id, v_code, public._j_text(p, 'name', true, 60),
              coalesce(public._j_int(p, 'floatCents', 0, 100000000, false), 0), public._j_bool(p, 'active', true))
      returning * into v_new;
    else
      select * into v_old from public.registers where id = v_id and store_id = v_me.store_id for update;
      if not found then
        perform public._err('NOT_FOUND', 'register not found');
      end if;
      v_active := public._j_bool(p, 'active', v_old.active);
      if not v_active and exists (select 1 from public.shifts where register_id = v_id and status in ('OPEN', 'PENDING_COUNT')) then
        perform public._err('REGISTER_BUSY', 'close the shift on this register first');
      end if;
      update public.registers
         set name = coalesce(public._j_text(p, 'name', false, 60), name),
             float_cents = coalesce(public._j_int(p, 'floatCents', 0, 100000000, false), float_cents),
             active = v_active
       where id = v_id
       returning * into v_new;
    end if;
  exception when unique_violation then
    perform public._err('INVALID_INPUT', 'that register code is already used');
  end;
  perform public._audit(v_me.store_id, 'owner_upsert_register', 'register', v_new.id::text,
    case when v_old.id is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  return to_jsonb(v_new);
end;
$$;

create or replace function public.owner_staff()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', pr.id, 'email', u.email, 'displayName', pr.display_name, 'role', pr.role,
             'active', pr.active, 'hasPin', pr.pin_hash is not null, 'createdAt', pr.created_at)
           order by pr.active desc, pr.role, pr.display_name)
      from public.profiles pr join auth.users u on u.id = pr.id
     where pr.store_id = v_me.store_id), '[]'::jsonb);
end;
$$;

-- Accounts are invited in Supabase Auth (public sign-up is disabled); the
-- owner then assigns each new account a role here.
create or replace function public.owner_unassigned_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('userId', u.id, 'email', u.email, 'createdAt', u.created_at)
                     order by u.created_at desc)
      from auth.users u
     where not exists (select 1 from public.profiles pr where pr.id = u.id)), '[]'::jsonb);
end;
$$;

create or replace function public.owner_assign_staff(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_uid uuid;
  v_role text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  v_uid := public._j_uuid(p, 'userId');
  if not exists (select 1 from auth.users where id = v_uid) then
    perform public._err('NOT_FOUND', 'user account not found');
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    perform public._err('INVALID_INPUT', 'that account already has a staff profile');
  end if;
  v_role := public._j_text(p, 'role', true, 10);
  if v_role not in ('OWNER', 'CASHIER') then
    perform public._err('INVALID_INPUT', 'role must be OWNER or CASHIER');
  end if;
  insert into public.profiles (id, store_id, role, display_name)
  values (v_uid, v_me.store_id, v_role, public._j_text(p, 'displayName', true, 60));
  perform public._audit(v_me.store_id, 'owner_assign_staff', 'profile', v_uid::text, null,
    jsonb_build_object('role', v_role, 'displayName', p ->> 'displayName'));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.owner_update_staff(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_old public.profiles;
  v_new public.profiles;
  v_role text;
  v_active boolean;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_old from public.profiles
   where id = public._j_uuid(p, 'userId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'staff member not found');
  end if;
  v_role := coalesce(public._j_text(p, 'role', false, 10), v_old.role);
  if v_role not in ('OWNER', 'CASHIER') then
    perform public._err('INVALID_INPUT', 'role must be OWNER or CASHIER');
  end if;
  v_active := public._j_bool(p, 'active', v_old.active);
  if v_old.id = v_me.id and (v_role <> v_old.role or not v_active) then
    perform public._err('CANNOT_CHANGE_SELF', 'another owner must change your role or deactivate you');
  end if;
  update public.profiles
     set role = v_role, active = v_active,
         display_name = coalesce(public._j_text(p, 'displayName', false, 60), display_name)
   where id = v_old.id
   returning * into v_new;
  if not exists (select 1 from public.profiles where store_id = v_me.store_id and role = 'OWNER' and active) then
    perform public._err('LAST_OWNER');
  end if;
  perform public._audit(v_me.store_id, 'owner_update_staff', 'profile', v_old.id::text,
    to_jsonb(v_old) - 'pin_hash', to_jsonb(v_new) - 'pin_hash');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.owner_set_pin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_target public.profiles;
  v_pin text;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_target from public.profiles
   where id = public._j_uuid(p, 'userId') and store_id = v_me.store_id
   for update;
  if not found then
    perform public._err('NOT_FOUND', 'staff member not found');
  end if;
  v_pin := case when jsonb_typeof(p -> 'pin') = 'string' then p ->> 'pin' end;
  if v_pin is null or v_pin !~ '^[0-9]{6}$' then
    perform public._err('INVALID_INPUT', 'a PIN is exactly 6 digits');
  end if;
  if v_pin ~ '^(.)\1{5}$' or v_pin in ('123456', '654321', '012345', '543210', '123123', '121212') then
    perform public._err('WEAK_PIN');
  end if;
  -- Owner PINs identify the approver, so no two owners may share one.
  if v_target.role = 'OWNER' and exists (
       select 1 from public.profiles
        where store_id = v_me.store_id and role = 'OWNER' and id <> v_target.id and pin_hash is not null
          and pin_hash = extensions.crypt(v_pin, pin_hash)) then
    perform public._err('PIN_IN_USE');
  end if;
  update public.profiles set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 10)) where id = v_target.id;
  perform public._audit(v_me.store_id, 'owner_set_pin', 'profile', v_target.id::text, null, jsonb_build_object('pinSet', true));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner reads
-- ---------------------------------------------------------------------------
create or replace function public.owner_products()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', pr.id, 'sku', pr.sku, 'barcode', pr.barcode, 'name', pr.name, 'priceCents', pr.price_cents,
             'reorderLevel', pr.reorder_level, 'active', pr.active, 'onHand', coalesce(sl.on_hand, 0),
             'avgCostCents', coalesce(pc.avg_cost_cents, 0), 'updatedAt', pr.updated_at)
           order by pr.name)
      from public.products pr
      left join public.stock_levels sl on sl.product_id = pr.id
      left join public.product_costs pc on pc.product_id = pr.id
     where pr.store_id = v_me.store_id), '[]'::jsonb);
end;
$$;

create or replace function public.owner_registers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
begin
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.code) from public.registers r where r.store_id = v_me.store_id),
                  '[]'::jsonb);
end;
$$;

create or replace function public.owner_alerts(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
  v_all boolean;
  v_limit bigint;
begin
  perform public._obj(coalesce(p, '{}'::jsonb));
  v_all := public._j_bool(coalesce(p, '{}'::jsonb), 'includeAcknowledged', false);
  v_limit := coalesce(public._j_int(coalesce(p, '{}'::jsonb), 'limit', 1, 500, false), 100);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'type', a.type, 'severity', a.severity, 'subject', a.subject, 'shiftId', a.shift_id,
             'userName', (select display_name from public.profiles where id = a.user_id), 'payload', a.payload,
             'createdAt', a.created_at, 'acknowledgedAt', a.acknowledged_at, 'ackNote', a.ack_note,
             'acknowledgedBy', (select display_name from public.profiles where id = a.acknowledged_by))
           order by a.created_at desc)
      from (select * from public.alerts
             where store_id = v_me.store_id and (v_all or acknowledged_at is null)
             order by case severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end, created_at desc
             limit v_limit) a), '[]'::jsonb);
end;
$$;

create or replace function public.owner_audit_log(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles := public._require_owner();
  v_before bigint;
  v_limit bigint;
begin
  perform public._obj(coalesce(p, '{}'::jsonb));
  v_before := public._j_int(coalesce(p, '{}'::jsonb), 'beforeId', 1, 999999999999999, false);
  v_limit := coalesce(public._j_int(coalesce(p, '{}'::jsonb), 'limit', 1, 500, false), 100);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id, 'action', l.action, 'targetType', l.target_type, 'targetId', l.target_id,
             'actor', (select display_name from public.profiles where id = l.actor_id),
             'before', l.before, 'after', l.after, 'createdAt', l.created_at, 'rowHash', l.row_hash)
           order by l.id desc)
      from (select * from public.audit_log
             where store_id = v_me.store_id and (v_before is null or id < v_before)
             order by id desc limit v_limit) l), '[]'::jsonb);
end;
$$;

create or replace function public.owner_shift_detail(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_shift public.shifts;
begin
  perform public._obj(p);
  v_me := public._require_owner();
  select * into v_shift from public.shifts where id = public._j_uuid(p, 'shiftId') and store_id = v_me.store_id;
  if not found then
    perform public._err('NOT_FOUND', 'shift not found');
  end if;
  return jsonb_build_object(
    'shift', to_jsonb(v_shift) || jsonb_build_object(
               'registerCode', (select code from public.registers where id = v_shift.register_id),
               'cashier', (select display_name from public.profiles where id = v_shift.cashier_id),
               'expectedNowCents', coalesce(v_shift.expected_cash_cents, public._expected_cash(v_shift.id))),
    'counts', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
                         'countedByName', (select display_name from public.profiles where id = c.counted_by))
                       order by c.created_at), '[]'::jsonb)
                 from public.cash_counts c where c.shift_id = v_shift.id),
    'cashMovements', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object(
                                'actorName', (select display_name from public.profiles where id = m.actor_id),
                                'approvedByName', (select display_name from public.profiles where id = m.approved_by))
                              order by m.created_at), '[]'::jsonb)
                        from public.cash_movements m where m.shift_id = v_shift.id),
    'paymentsByMethod', (select coalesce(jsonb_object_agg(method, total), '{}'::jsonb)
                           from (select method, sum(amount_cents) as total from public.payments
                                  where shift_id = v_shift.id group by method) t),
    'salesCount', (select count(*) from public.sales where shift_id = v_shift.id),
    'salesCents', (select coalesce(sum(total_cents), 0) from public.sales where shift_id = v_shift.id),
    'reversals', (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', r.id, 'kind', r.kind, 'amountCents', r.amount_cents, 'refundMethod', r.refund_method,
                           'reasonCode', r.reason_code, 'note', r.note, 'createdAt', r.created_at,
                           'approvedBy', (select display_name from public.profiles where id = r.approved_by),
                           'receiptLabel', public._receipt_label(s.register_id, s.receipt_no))
                         order by r.created_at), '[]'::jsonb)
                    from public.sale_reversals r join public.sales s on s.id = r.original_sale_id
                   where r.shift_id = v_shift.id),
    'cartEvents', (select coalesce(jsonb_agg(jsonb_build_object(
                            'kind', e.kind, 'qty', e.qty, 'createdAt', e.created_at,
                            'product', (select name from public.products where id = e.product_id))
                          order by e.created_at), '[]'::jsonb)
                     from public.cart_events e where e.shift_id = v_shift.id),
    'alerts', (select coalesce(jsonb_agg(jsonb_build_object('type', a.type, 'severity', a.severity, 'subject', a.subject,
                                                         'createdAt', a.created_at, 'acknowledgedAt', a.acknowledged_at)
                                       order by a.created_at), '[]'::jsonb)
                 from public.alerts a where a.shift_id = v_shift.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner dashboard. Every number is computed from the ledger on each call,
-- so the screen always matches the database.
-- ---------------------------------------------------------------------------
create or replace function public.owner_dashboard_today(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_store uuid;
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_gross bigint;
  v_count bigint;
  v_voids bigint;
  v_refunds bigint;
  v_net bigint;
  v_cogs_sold bigint;
  v_cogs_back bigint;
  v_cogs bigint;
  v_gp bigint;
  v_days numeric;
begin
  v_me := public._require_owner();
  p := coalesce(p, '{}'::jsonb);
  perform public._obj(p);
  v_store := v_me.store_id;
  select timezone into v_tz from public.stores where id = v_store;
  v_from := public._j_ts(p, 'from', false);
  v_to := public._j_ts(p, 'to', false);
  if v_from is null then
    v_from := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  end if;
  if v_to is null then
    v_to := v_from + interval '1 day';
  end if;
  if v_to <= v_from or v_to - v_from > interval '366 days' then
    perform public._err('INVALID_INPUT', 'the range must be between 1 second and 366 days');
  end if;
  v_days := greatest(extract(epoch from (v_to - v_from)) / 86400.0, 1);

  select coalesce(sum(total_cents), 0), count(*) into v_gross, v_count
    from public.sales where store_id = v_store and created_at >= v_from and created_at < v_to;
  select coalesce(sum(amount_cents) filter (where kind = 'VOID'), 0),
         coalesce(sum(amount_cents) filter (where kind = 'REFUND'), 0)
    into v_voids, v_refunds
    from public.sale_reversals where store_id = v_store and created_at >= v_from and created_at < v_to;
  v_net := v_gross - v_voids - v_refunds;

  select coalesce(sum(c.cost_total_cents), 0) into v_cogs_sold
    from public.sale_line_costs c join public.sales s on s.id = c.sale_id
   where s.store_id = v_store and s.created_at >= v_from and s.created_at < v_to;
  -- Restocked returns give their cost back; damaged returns stay a cost.
  select coalesce(round(sum(c.unit_cost_cents * rl.qty)), 0)::bigint into v_cogs_back
    from public.sale_reversal_lines rl
    join public.sale_reversals r on r.id = rl.reversal_id
    join public.sale_line_costs c on c.sale_line_id = rl.sale_line_id
   where r.store_id = v_store and r.created_at >= v_from and r.created_at < v_to and rl.restocked;
  v_cogs := v_cogs_sold - v_cogs_back;
  v_gp := v_net - v_cogs;

  return jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz, 'days', round(v_days, 2)),
    'generatedAt', now(),
    'grossSalesCents', v_gross,
    'salesCount', v_count,
    'avgBasketCents', case when v_count > 0 then round(v_gross::numeric / v_count)::bigint end,
    'voidsCents', v_voids,
    'refundsCents', v_refunds,
    'netSalesCents', v_net,
    'cogsCents', v_cogs,
    'grossProfitCents', v_gp,
    'grossMarginBps', case when v_net > 0 then round(v_gp * 10000.0 / v_net)::bigint end,

    'paymentMix', (
      with pay as (
        select pm.method, sum(pm.amount_cents) as amt
          from public.payments pm join public.sales s on s.id = pm.sale_id
         where s.store_id = v_store and s.created_at >= v_from and s.created_at < v_to
         group by pm.method
      ), ref as (
        select refund_method as method, sum(amount_cents) as amt
          from public.sale_reversals
         where store_id = v_store and created_at >= v_from and created_at < v_to
         group by refund_method
      )
      select jsonb_agg(jsonb_build_object('method', m.method,
                                          'amountCents', coalesce(pay.amt, 0) - coalesce(ref.amt, 0))
                       order by m.ord)
        from (values ('CASH', 1), ('MPESA', 2), ('CARD', 3)) as m (method, ord)
        left join pay on pay.method = m.method
        left join ref on ref.method = m.method),

    'drawers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'shiftId', s.id, 'registerCode', r.code, 'cashier', pr.display_name, 'status', s.status,
               'openedAt', s.opened_at, 'expectedCents', public._expected_cash(s.id))
             order by r.code), '[]'::jsonb)
        from public.shifts s
        join public.registers r on r.id = s.register_id
        join public.profiles pr on pr.id = s.cashier_id
       where s.store_id = v_store and s.status in ('OPEN', 'PENDING_COUNT')),

    'shifts', (
      select coalesce(jsonb_agg(x order by x ->> 'openedAt' desc), '[]'::jsonb)
        from (select jsonb_build_object(
                       'shiftId', s.id, 'registerCode', r.code, 'cashier', pr.display_name, 'status', s.status,
                       'openedAt', s.opened_at, 'closedAt', s.closed_at,
                       'forced', s.forced_close_at is not null,
                       'expectedCents', coalesce(s.expected_cash_cents, public._expected_cash(s.id)),
                       'countedCents', s.counted_cash_cents,
                       'varianceCents', s.variance_cents,
                       'netVarianceCents', s.variance_cents - coalesce((
                           select sum(m.amount_cents) from public.cash_movements m
                            where m.shift_id = s.id and m.kind = 'ADJUSTMENT' and m.created_at > s.closed_at), 0),
                       'flagged', s.variance_flagged,
                       'acknowledgedAt', s.acknowledged_at,
                       'acknowledgementNote', s.acknowledgement_note,
                       'recounts', (select count(*) from public.cash_counts c where c.shift_id = s.id and c.kind = 'RECOUNT'),
                       'unackedAlerts', (select count(*) from public.alerts a where a.shift_id = s.id and a.acknowledged_at is null)
                     ) as x
                from public.shifts s
                join public.registers r on r.id = s.register_id
                join public.profiles pr on pr.id = s.cashier_id
               where s.store_id = v_store
                 and (s.status in ('OPEN', 'PENDING_COUNT', 'CLOSED_UNRECONCILED')
                      or (s.opened_at < v_to and coalesce(s.closed_at, 'infinity'::timestamptz) >= v_from))
               order by s.opened_at desc
               limit 100) t),

    'exceptions', (
      with ev as (
        select requested_by as uid, case kind when 'VOID' then 'void' else 'refund' end as k,
               amount_cents as amt, created_at
          from public.sale_reversals
         where store_id = v_store and created_at >= v_from - interval '30 days' and created_at < v_to
        union all
        select sa.cashier_id, 'override', l.list_price_cents * l.qty - l.line_total_cents, sa.created_at
          from public.sale_lines l join public.sales sa on sa.id = l.sale_id
         where l.price_overridden and sa.store_id = v_store
           and sa.created_at >= v_from - interval '30 days' and sa.created_at < v_to
        union all
        select cashier_id, case kind when 'CART_CANCELLED' then 'cart_cancel' else 'line_removal' end, 0, created_at
          from public.cart_events
         where store_id = v_store and created_at >= v_from - interval '30 days' and created_at < v_to
        union all
        select actor_id, 'no_sale', 0, created_at
          from public.cash_movements
         where kind = 'NO_SALE' and store_id = v_store
           and created_at >= v_from - interval '30 days' and created_at < v_to
      ), agg as (
        select ev.uid,
               count(*) filter (where k = 'void' and created_at >= v_from) as voids,
               coalesce(sum(amt) filter (where k = 'void' and created_at >= v_from), 0) as void_cents,
               count(*) filter (where k = 'refund' and created_at >= v_from) as refunds,
               coalesce(sum(amt) filter (where k = 'refund' and created_at >= v_from), 0) as refund_cents,
               count(*) filter (where k = 'override' and created_at >= v_from) as overrides,
               coalesce(sum(amt) filter (where k = 'override' and created_at >= v_from), 0) as override_cents,
               count(*) filter (where k = 'line_removal' and created_at >= v_from) as line_removals,
               count(*) filter (where k = 'cart_cancel' and created_at >= v_from) as cart_cancels,
               count(*) filter (where k = 'no_sale' and created_at >= v_from) as no_sales,
               count(*) filter (where k = 'void' and created_at < v_from) / 30.0 as b_voids,
               count(*) filter (where k = 'refund' and created_at < v_from) / 30.0 as b_refunds,
               count(*) filter (where k = 'override' and created_at < v_from) / 30.0 as b_overrides,
               count(*) filter (where k = 'line_removal' and created_at < v_from) / 30.0 as b_line_removals,
               count(*) filter (where k = 'cart_cancel' and created_at < v_from) / 30.0 as b_cart_cancels,
               count(*) filter (where k = 'no_sale' and created_at < v_from) / 30.0 as b_no_sales
          from ev group by ev.uid
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'userId', a.uid, 'name', pr.display_name,
               'current', jsonb_build_object(
                  'voids', a.voids, 'voidCents', a.void_cents, 'refunds', a.refunds, 'refundCents', a.refund_cents,
                  'overrides', a.overrides, 'overrideCents', a.override_cents, 'lineRemovals', a.line_removals,
                  'cartCancels', a.cart_cancels, 'noSales', a.no_sales),
               'baselinePerDay', jsonb_build_object(
                  'voids', round(a.b_voids, 2), 'refunds', round(a.b_refunds, 2), 'overrides', round(a.b_overrides, 2),
                  'lineRemovals', round(a.b_line_removals, 2), 'cartCancels', round(a.b_cart_cancels, 2),
                  'noSales', round(a.b_no_sales, 2)))
             order by pr.display_name), '[]'::jsonb)
        from agg a join public.profiles pr on pr.id = a.uid),

    'lowStock', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'productId', pr.id, 'name', pr.name, 'sku', pr.sku, 'onHand', coalesce(sl.on_hand, 0),
               'reorderLevel', pr.reorder_level,
               'avgDailyUnits', round(coalesce(d.units, 0) / 30.0, 2),
               'daysOfCover', case when coalesce(d.units, 0) > 0
                                   then round(greatest(coalesce(sl.on_hand, 0), 0) / (d.units / 30.0), 1) end)
             order by coalesce(sl.on_hand, 0) - pr.reorder_level, pr.name), '[]'::jsonb)
        from public.products pr
        left join public.stock_levels sl on sl.product_id = pr.id
        left join lateral (select -sum(m.qty_delta) as units from public.stock_movements m
                            where m.product_id = pr.id and m.type = 'SALE'
                              and m.created_at >= now() - interval '30 days') d on true
       where pr.store_id = v_store and pr.active and coalesce(sl.on_hand, 0) <= pr.reorder_level),

    'recentSales', (
      select coalesce(jsonb_agg(x order by x ->> 'at' desc), '[]'::jsonb)
        from (select jsonb_build_object(
                       'saleId', s.id, 'receiptLabel', r.code || '-' || lpad(s.receipt_no::text, 6, '0'),
                       'totalCents', s.total_cents, 'cashier', pr.display_name, 'at', s.created_at,
                       'methods', (select jsonb_agg(distinct pm.method) from public.payments pm where pm.sale_id = s.id)) as x
                from public.sales s
                join public.registers r on r.id = s.register_id
                join public.profiles pr on pr.id = s.cashier_id
               where s.store_id = v_store
               order by s.created_at desc
               limit 20) t),

    'alerts', jsonb_build_object(
      'unacknowledged', (select jsonb_build_object(
                                  'HIGH', count(*) filter (where severity = 'HIGH'),
                                  'MEDIUM', count(*) filter (where severity = 'MEDIUM'),
                                  'LOW', count(*) filter (where severity = 'LOW'))
                           from public.alerts where store_id = v_store and acknowledged_at is null),
      'items', public.owner_alerts(jsonb_build_object('limit', 50))),

    'pendingApprovals', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'requestId', q.id, 'action', q.action, 'summary', q.summary, 'cashier', pr.display_name,
               'registerCode', r.code, 'createdAt', q.created_at, 'expiresAt', q.expires_at)
             order by q.created_at), '[]'::jsonb)
        from public.approval_requests q
        join public.profiles pr on pr.id = q.requested_by
        join public.registers r on r.id = q.register_id
       where q.store_id = v_store and q.expires_at > now()
         and not exists (select 1 from public.approvals a where a.request_id = q.id)
         and not exists (select 1 from public.approval_rejections j where j.request_id = q.id))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (Worker cron, secret key -> service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.cron_stale_shifts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select s.id, s.store_id, s.cashier_id, s.opened_at, rg.code, pr.display_name
      from public.shifts s
      join public.store_settings st on st.store_id = s.store_id
      join public.registers rg on rg.id = s.register_id
      join public.profiles pr on pr.id = s.cashier_id
     where s.status = 'OPEN' and s.opened_at < now() - make_interval(hours => st.stale_shift_hours)
  loop
    if public._raise_alert(r.store_id, 'STALE_SHIFT', 'MEDIUM',
         r.code || ' shift by ' || r.display_name || ' has been open since ' || to_char(r.opened_at, 'YYYY-MM-DD HH24:MI'),
         r.id, r.cashier_id, r.id, jsonb_build_object('openedAt', r.opened_at), 'STALE_SHIFT:' || r.id) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('staleAlerts', v_n);
end;
$$;

create or replace function public.cron_integrity_checks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  v_chain jsonb;
  v_stock jsonb;
  v_shift jsonb;
  r record;
begin
  -- 1. SUM(movements) per product must equal on_hand.
  for r in
    select pr.store_id,
           jsonb_agg(jsonb_build_object('productId', pr.id, 'name', pr.name,
                                        'onHand', coalesce(sl.on_hand, 0), 'movements', coalesce(m.total, 0))) as bad
      from public.products pr
      left join public.stock_levels sl on sl.product_id = pr.id
      left join (select product_id, sum(qty_delta) as total from public.stock_movements group by product_id) m
             on m.product_id = pr.id
     where coalesce(sl.on_hand, 0) <> coalesce(m.total, 0)
     group by pr.store_id
  loop
    perform public._raise_alert(r.store_id, 'INTEGRITY_STOCK', 'HIGH',
      jsonb_array_length(r.bad) || ' product(s) have stock that does not match their movements',
      null, null, null, jsonb_build_object('products', r.bad), 'INTEGRITY_STOCK:' || r.store_id || ':' || v_day);
  end loop;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_stock
    from (select pr.id as x from public.products pr
            left join public.stock_levels sl on sl.product_id = pr.id
            left join (select product_id, sum(qty_delta) as total from public.stock_movements group by product_id) m
                   on m.product_id = pr.id
           where coalesce(sl.on_hand, 0) <> coalesce(m.total, 0)) t;

  -- 2. Audit hash chain.
  v_chain := public._verify_audit_chain();
  if not (v_chain ->> 'ok')::boolean then
    for r in select id from public.stores loop
      perform public._raise_alert(r.id, 'INTEGRITY_AUDIT', 'HIGH',
        'The audit log hash chain is broken at row ' || (v_chain ->> 'brokenAtId'),
        null, null, null, v_chain, 'INTEGRITY_AUDIT:' || r.id || ':' || v_day);
    end loop;
  end if;

  -- 3. Closed shifts without a blind count, or unacknowledged over-threshold variance older than a day.
  for r in
    select s.store_id, jsonb_agg(s.id) as ids
      from public.shifts s
     where (s.status in ('CLOSED', 'CLOSED_UNRECONCILED')
            and not exists (select 1 from public.cash_counts c where c.shift_id = s.id and c.kind = 'CLOSING'))
        or (s.status = 'CLOSED_UNRECONCILED' and s.closed_at < now() - interval '24 hours')
     group by s.store_id
  loop
    perform public._raise_alert(r.store_id, 'INTEGRITY_SHIFT', 'HIGH',
      jsonb_array_length(r.ids) || ' closed shift(s) lack a blind count or an acknowledged variance',
      null, null, null, jsonb_build_object('shiftIds', r.ids), 'INTEGRITY_SHIFT:' || r.store_id || ':' || v_day);
  end loop;
  select coalesce(jsonb_agg(s.id), '[]'::jsonb) into v_shift
    from public.shifts s
   where (s.status in ('CLOSED', 'CLOSED_UNRECONCILED')
          and not exists (select 1 from public.cash_counts c where c.shift_id = s.id and c.kind = 'CLOSING'))
      or (s.status = 'CLOSED_UNRECONCILED' and s.closed_at < now() - interval '24 hours');

  return jsonb_build_object('stockMismatches', v_stock, 'auditChain', v_chain, 'shiftProblems', v_shift,
                            'checkedAt', now());
end;
$$;

create or replace function public.cron_pending_notifications()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'alertId', a.id, 'storeId', a.store_id, 'storeName', st.name, 'type', a.type,
           'severity', a.severity, 'subject', a.subject, 'createdAt', a.created_at)
         order by a.created_at), '[]'::jsonb)
    from public.alerts a join public.stores st on st.id = a.store_id
   where a.severity = 'HIGH' and a.acknowledged_at is null and a.created_at > now() - interval '3 days'
     and not exists (select 1 from public.alert_notifications n
                      where n.alert_id = a.id and n.status in ('SENT', 'SKIPPED'))
$$;

create or replace function public.cron_record_notification(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert public.alerts;
  v_status text;
begin
  perform public._obj(p);
  select * into v_alert from public.alerts where id = public._j_uuid(p, 'alertId');
  if not found then
    perform public._err('NOT_FOUND', 'alert not found');
  end if;
  v_status := public._j_text(p, 'status', true, 10);
  if v_status not in ('SENT', 'FAILED', 'SKIPPED') then
    perform public._err('INVALID_INPUT', 'status must be SENT, FAILED or SKIPPED');
  end if;
  insert into public.alert_notifications (store_id, alert_id, channel, status, detail)
  values (v_alert.store_id, v_alert.id, public._j_text(p, 'channel', true, 40), v_status,
          public._j_text(p, 'detail', false, 500));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- One-time bootstrap, run from the SQL editor only (no API role can call it).
--   select public.bootstrap_store('{"storeName":"Monica''s Shop","ownerEmail":"owner@example.com",
--     "ownerName":"Monica","ownerPin":"<6 digits>","registerCode":"T1","registerName":"Till 1",
--     "floatCents":500000}'::jsonb);
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_store(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store uuid := gen_random_uuid();
  v_uid uuid;
  v_pin text := p ->> 'ownerPin';
  v_reg uuid := gen_random_uuid();
begin
  perform public._obj(p);
  select id into v_uid from auth.users where lower(email) = lower(public._j_text(p, 'ownerEmail', true, 320));
  if v_uid is null then
    perform public._err('NOT_FOUND', 'create (invite) the owner in Supabase Auth first');
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    perform public._err('INVALID_INPUT', 'that account already has a staff profile');
  end if;
  if v_pin is null or v_pin !~ '^[0-9]{6}$' or v_pin ~ '^(.)\1{5}$'
     or v_pin in ('123456', '654321', '012345', '543210', '123123', '121212') then
    perform public._err('WEAK_PIN', 'ownerPin must be 6 digits and not trivial');
  end if;
  insert into public.stores (id, name) values (v_store, public._j_text(p, 'storeName', true, 120));
  insert into public.store_settings (store_id) values (v_store);
  insert into public.profiles (id, store_id, role, display_name, pin_hash)
  values (v_uid, v_store, 'OWNER', public._j_text(p, 'ownerName', true, 60),
          extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));
  insert into public.registers (id, store_id, code, name, float_cents)
  values (v_reg, v_store, upper(coalesce(public._j_text(p, 'registerCode', false, 6), 'T1')),
          coalesce(public._j_text(p, 'registerName', false, 60), 'Till 1'),
          coalesce(public._j_int(p, 'floatCents', 0, 100000000, false), 0));
  perform public._audit(v_store, 'bootstrap_store', 'store', v_store::text, null,
    jsonb_build_object('ownerId', v_uid, 'registerId', v_reg));
  return jsonb_build_object('storeId', v_store, 'ownerId', v_uid, 'registerId', v_reg);
end;
$$;
