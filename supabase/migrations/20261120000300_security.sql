-- =============================================================================
-- Monica's Shop POS — 3/6 row-level security and table privileges
--
-- * No API role (anon, authenticated, service_role) may INSERT, UPDATE,
--   DELETE or TRUNCATE any table. All writes go through SECURITY DEFINER RPCs.
-- * authenticated gets SELECT only where a cashier or owner needs to read,
--   and RLS limits the rows. Hidden columns use column-level grants.
-- * Owner-only reads require an MFA (aal2) session via public.is_owner().
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;

-- New tables and sequences are not exposed by default.
alter default privileges in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

-- Readable tables (RLS below narrows the rows).
grant select on
  public.stores, public.store_settings, public.registers, public.products,
  public.product_costs, public.product_price_history,
  public.cash_movements, public.sales, public.sale_lines, public.sale_line_costs, public.payments,
  public.sale_reversals, public.sale_reversal_lines, public.approval_requests, public.approvals,
  public.approval_rejections, public.stock_movements, public.stock_levels, public.stock_counts,
  public.stock_count_items, public.cart_events, public.alerts, public.alert_notifications,
  public.pin_attempts, public.pin_lockouts, public.audit_log
to authenticated;

-- Column-level grants: these columns are never selectable through the API.
--   profiles.pin_hash
--   shifts.expected_cash_cents / counted_cash_cents / variance_cents
--   cash_counts.expected_cents / variance_cents
--   stock_count_lines.system_qty
-- Owners read them through owner RPCs; cashiers see their own variance only
-- through shift_status_for_cashier() after their count has committed.
grant select (id, store_id, role, display_name, active, created_at, updated_at) on public.profiles to authenticated;
grant select (id, store_id, register_id, cashier_id, status, opened_at, opening_float_expected_cents,
              opening_float_counted_cents, forced_close_at, forced_close_by, forced_close_reason,
              closed_at, closed_by, variance_flagged, acknowledged_at, acknowledged_by, acknowledgement_note)
  on public.shifts to authenticated;
grant select (id, store_id, shift_id, kind, counted_by, n1000, n500, n200, n100, n50, c20, c10, c5, c1,
              counted_cents, created_at)
  on public.cash_counts to authenticated;
grant select (id, store_id, count_id, product_id, counted_qty, counted_by, created_at)
  on public.stock_count_lines to authenticated;

-- The secret key (service_role) is read-only, and cannot read PIN hashes.
grant select on all tables in schema public to service_role;
revoke select on public.profiles from service_role;
grant select (id, store_id, role, display_name, active, created_at, updated_at) on public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'stores', 'store_settings', 'profiles', 'registers', 'products', 'product_costs', 'product_price_history',
    'shifts', 'cash_counts', 'approval_requests', 'approvals', 'approval_rejections', 'cash_movements', 'sales',
    'sale_lines', 'sale_line_costs', 'payments', 'sale_reversals', 'sale_reversal_lines', 'stock_movements',
    'stock_levels', 'stock_counts', 'stock_count_items', 'stock_count_lines', 'cart_events', 'alerts',
    'alert_notifications', 'pin_attempts', 'pin_lockouts', 'audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- Owner-only tables: one SELECT policy, owner with MFA, same store.
  foreach t in array array[
    'store_settings', 'product_costs', 'product_price_history', 'sale_line_costs', 'approvals',
    'approval_rejections', 'stock_movements', 'stock_levels', 'cart_events', 'alerts',
    'alert_notifications', 'pin_attempts', 'pin_lockouts', 'audit_log'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_owner()) and store_id = (select public.app_store_id()))',
      t || '_owner_select', t);
  end loop;
end;
$$;

create policy stores_select on public.stores for select to authenticated
  using (id = (select public.app_store_id()));

create policy profiles_select on public.profiles for select to authenticated
  using (store_id = (select public.app_store_id()) and (id = (select auth.uid()) or (select public.is_owner())));

create policy registers_select on public.registers for select to authenticated
  using (store_id = (select public.app_store_id()));

create policy products_select on public.products for select to authenticated
  using (store_id = (select public.app_store_id()));

create policy shifts_select on public.shifts for select to authenticated
  using (store_id = (select public.app_store_id())
         and (cashier_id = (select auth.uid()) or (select public.is_owner())));

-- Rows tied to a shift: a cashier sees rows of their own shifts only.
create policy cash_counts_select on public.cash_counts for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or shift_id in (select s.id from public.shifts s where s.cashier_id = (select auth.uid()))));

create policy cash_movements_select on public.cash_movements for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or shift_id in (select s.id from public.shifts s where s.cashier_id = (select auth.uid()))));

create policy sales_select on public.sales for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or shift_id in (select s.id from public.shifts s where s.cashier_id = (select auth.uid()))));

create policy sale_lines_select on public.sale_lines for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or shift_id in (select s.id from public.shifts s where s.cashier_id = (select auth.uid()))));

create policy payments_select on public.payments for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or shift_id in (select s.id from public.shifts s where s.cashier_id = (select auth.uid()))));

create policy sale_reversals_select on public.sale_reversals for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner()) or requested_by = (select auth.uid())));

create policy sale_reversal_lines_select on public.sale_reversal_lines for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or reversal_id in (select r.id from public.sale_reversals r where r.requested_by = (select auth.uid()))));

create policy approval_requests_select on public.approval_requests for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner()) or requested_by = (select auth.uid())));

create policy stock_counts_select on public.stock_counts for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner()) or (assigned_to = (select auth.uid()) and status = 'OPEN')));

create policy stock_count_items_select on public.stock_count_items for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner())
              or count_id in (select c.id from public.stock_counts c
                              where c.assigned_to = (select auth.uid()) and c.status = 'OPEN')));

create policy stock_count_lines_select on public.stock_count_lines for select to authenticated
  using (store_id = (select public.app_store_id())
         and ((select public.is_owner()) or counted_by = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Realtime: only owners of a store may receive its private owner channel.
-- ---------------------------------------------------------------------------
create policy owners_receive_owner_channel on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and (select public.is_owner())
    and (select realtime.topic()) = 'store:' || (select public.app_store_id())::text || ':owner'
  );
