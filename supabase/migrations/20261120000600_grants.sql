-- =============================================================================
-- Monica's Shop POS — 6/6 function privileges
--
-- Nothing in public is executable by an API role unless granted below.
-- Internal helpers (names starting with "_"), trigger functions and
-- bootstrap_store() stay callable only by the database owner.
-- =============================================================================

revoke all on all functions in schema public from public, anon, authenticated, service_role;

-- Used inside RLS policies, so the querying role must be able to execute them.
grant execute on function
  public.app_role(),
  public.app_store_id(),
  public.is_owner()
to authenticated;

-- Till (cashier and owner)
grant execute on function
  public.my_context(),
  public.open_shift(jsonb),
  public.complete_sale(jsonb),
  public.reprint_receipt(jsonb),
  public.log_cart_event(jsonb),
  public.request_approval(jsonb),
  public.approve_with_pin(jsonb),
  public.my_approval(jsonb),
  public.lookup_sale_for_reversal(jsonb),
  public.reverse_sale(jsonb),
  public.record_cash_movement(jsonb),
  public.commit_close_count(jsonb),
  public.shift_status_for_cashier(jsonb),
  public.verify_my_pin(jsonb),
  public.my_stock_count(),
  public.record_count_line(jsonb)
to authenticated;

-- Owner (each checks OWNER + MFA itself)
grant execute on function
  public.approve_request(jsonb),
  public.reject_request(jsonb),
  public.owner_force_close_shift(jsonb),
  public.owner_recount_shift(jsonb),
  public.owner_acknowledge_shift(jsonb),
  public.owner_cash_adjustment(jsonb),
  public.owner_acknowledge_alert(jsonb),
  public.owner_upsert_product(jsonb),
  public.receive_stock(jsonb),
  public.adjust_stock(jsonb),
  public.open_stock_count(jsonb),
  public.post_stock_count(jsonb),
  public.cancel_stock_count(jsonb),
  public.owner_stock_counts(),
  public.owner_stock_count_detail(jsonb),
  public.owner_update_settings(jsonb),
  public.owner_settings(),
  public.owner_upsert_register(jsonb),
  public.owner_staff(),
  public.owner_unassigned_users(),
  public.owner_assign_staff(jsonb),
  public.owner_update_staff(jsonb),
  public.owner_set_pin(jsonb),
  public.owner_products(),
  public.owner_registers(),
  public.owner_alerts(jsonb),
  public.owner_audit_log(jsonb),
  public.owner_shift_detail(jsonb),
  public.owner_dashboard_today(jsonb)
to authenticated;

-- Scheduled jobs (Worker cron with the secret key)
grant execute on function
  public.cron_stale_shifts(),
  public.cron_integrity_checks(),
  public.cron_pending_notifications(),
  public.cron_record_notification(jsonb)
to service_role;
