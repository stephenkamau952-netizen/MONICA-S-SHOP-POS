// Stable error codes raised by the database RPCs (message = code) and by the
// Worker. The HTTP status is what the Worker returns; the text is for the UI.

export const ERRORS = {
  NOT_AUTHENTICATED: { status: 401, message: 'Please sign in again.' },
  FORBIDDEN: { status: 403, message: 'You are not allowed to do that.' },
  MFA_REQUIRED: { status: 403, message: 'Owner actions need your authenticator code. Sign in again with MFA.' },
  INVALID_INPUT: { status: 400, message: 'Some details are missing or wrong.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  SHIFT_NOT_OPEN: { status: 409, message: 'There is no open shift for you on this till.' },
  SHIFT_ALREADY_OPEN: { status: 409, message: 'You already have a shift open.' },
  REGISTER_BUSY: { status: 409, message: 'This till already has an open shift.' },
  COUNT_ALREADY_COMMITTED: { status: 409, message: 'The count for this shift was already committed.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'This sale key belongs to another user.' },
  PRODUCT_UNAVAILABLE: { status: 409, message: 'A product is unknown or no longer sold.' },
  INSUFFICIENT_STOCK: { status: 409, message: 'Not enough stock.' },
  PAYMENT_MISMATCH: { status: 422, message: 'Payments do not add up to the total.' },
  INSUFFICIENT_TENDER: { status: 422, message: 'Cash tendered is less than the amount due.' },
  MPESA_CODE_USED: { status: 409, message: 'That M-Pesa code has already been used.' },
  MPESA_REF_USED: { status: 409, message: 'That M-Pesa reversal code has already been used.' },
  APPROVAL_REQUIRED: { status: 403, message: 'This needs owner approval.' },
  APPROVAL_INVALID: { status: 403, message: 'That approval does not match this action.' },
  APPROVAL_MISMATCH: { status: 403, message: 'The details changed after the owner approved. Ask again.' },
  APPROVAL_USED: { status: 409, message: 'That approval was already used.' },
  APPROVAL_EXPIRED: { status: 410, message: 'The approval expired. Ask again.' },
  APPROVAL_ALREADY_DECIDED: { status: 409, message: 'This request was already approved or rejected.' },
  SELF_APPROVAL: { status: 403, message: 'You cannot approve your own request.' },
  BAD_PIN: { status: 401, message: 'Wrong PIN.' },
  PIN_LOCKED: { status: 423, message: 'Too many wrong PINs. Locked for 15 minutes.' },
  PIN_NOT_SET: { status: 409, message: 'No PIN is set. Ask the owner to set one.' },
  WEAK_PIN: { status: 422, message: 'Choose a less predictable 6-digit PIN.' },
  PIN_IN_USE: { status: 409, message: 'Another owner already uses that PIN.' },
  VOID_NOT_ALLOWED: { status: 409, message: 'This sale cannot be voided. Use a refund.' },
  REFUND_WINDOW_EXPIRED: { status: 409, message: 'The refund window for this sale has passed.' },
  REFUND_EXCEEDS_SALE: { status: 409, message: 'That is more than is left to refund.' },
  DUPLICATE_PRODUCT: { status: 409, message: 'That SKU or barcode is already used.' },
  LEDGER_IMMUTABLE: { status: 409, message: 'Ledger records cannot be changed or deleted.' },
  CANNOT_CHANGE_SELF: { status: 409, message: 'Another owner must change your own role or status.' },
  LAST_OWNER: { status: 409, message: 'The shop must keep at least one active owner.' },
  COUNT_NOT_OPEN: { status: 409, message: 'This stock count is not open.' },
  STOCK_COUNT_ALREADY_OPEN: { status: 409, message: 'Another stock count is already open.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Wait a moment.' },
  UPSTREAM_ERROR: { status: 502, message: 'The database could not be reached. Check the connection.' },
  INTERNAL: { status: 500, message: 'Something went wrong.' },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, code);
}

/** Shape of every error body returned by the Worker. */
export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
  detail?: string;
  [extra: string]: unknown;
}
