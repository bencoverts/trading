export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'INSUFFICIENT_FUNDS'
  | 'TRADE_LIMIT_REACHED'
  | 'DURATION_NOT_ALLOWED'
  | 'SYMBOL_INACTIVE'
  | 'PRICE_UNAVAILABLE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown, code: ErrorCode = 'VALIDATION_ERROR') {
    return new AppError(code, 400, message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError('UNAUTHORIZED', 401, message);
  }
  static forbidden(message = 'Not allowed') {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Not found') {
    return new AppError('NOT_FOUND', 404, message);
  }
  static conflict(message: string, code: ErrorCode = 'CONFLICT') {
    return new AppError(code, 409, message);
  }
  static unprocessable(code: ErrorCode, message: string, details?: unknown) {
    return new AppError(code, 422, message, details);
  }
}
