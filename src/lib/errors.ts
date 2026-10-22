export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'USERNAME_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_BLOCKED'
  | 'EMAIL_NOT_VERIFIED'
  | 'INSUFFICIENT_FUNDS'
  | 'TRADE_LIMIT_REACHED'
  | 'DURATION_NOT_ALLOWED'
  | 'AMOUNT_NOT_ALLOWED'
  | 'MARKET_PAUSED'
  | 'MARKET_CLOSED'
  | 'MARKET_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'SESSION_REVOKED'
  | 'CSRF_FAILED'
  | 'CSRF_INVALID'
  | 'ORIGIN_INVALID'
  | 'ACCOUNT_LOCKED'
  | 'INVALID_TOTP'
  | 'TOTP_REQUIRED'
  | 'MARKET_OUTSIDE_HOURS'
  | 'EXPOSURE_LIMIT'
  | 'CURRENCY_LOCKED'
  | 'CONVERSION_INVALID'
  | 'COOLDOWN'
  | 'UPLOAD_INVALID'
  | 'MARKET_HAS_OPEN_TRADES'
  | 'MARKET_SYMBOL_TAKEN'
  | 'TERMS_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'TOTP_ENABLED'
  | 'ALREADY_VERIFIED'
  | 'JOB_NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_TOKEN'
  | 'NOT_AVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown, code: ErrorCode = 'VALIDATION_ERROR') {
    return new AppError(code, 400, message, details);
  }
  static unauthorized(message = 'Authentication required', code: ErrorCode = 'UNAUTHORIZED') {
    return new AppError(code, 401, message);
  }
  static forbidden(message = 'Not allowed') {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Not found', code: ErrorCode = 'NOT_FOUND') {
    return new AppError(code, 404, message);
  }
  static conflict(message: string, code: ErrorCode = 'CONFLICT') {
    return new AppError(code, 409, message);
  }
  static unprocessable(code: ErrorCode, message: string, details?: unknown) {
    return new AppError(code, 422, message, details);
  }
  static notAvailable(feature: string) {
    return new AppError('NOT_AVAILABLE', 501, `${feature} is not available in this build`, { simulationOnly: true });
  }
}
