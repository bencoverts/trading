/**
 * Thin fetch wrapper.
 * - same-origin cookies (httpOnly session) + CSRF header read from the CSRF cookie
 * - Idempotency-Key is generated for every POST so a double click can never
 *   create two trades (the server requires it for /trades)
 */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const CSRF_COOKIE = 'sim_csrf';
const CSRF_HEADER = 'x-csrf-token';

export function readCookie(name) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split('='))
    .find(([key]) => key === name)?.[1];
}

export function csrfToken() {
  return readCookie(CSRF_COOKIE) ?? '';
}

export function idempotencyKey(prefix = 'web') {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export async function api(path, { method = 'GET', body, headers = {}, idempotency, signal } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  if (method !== 'GET' && method !== 'HEAD') opts.headers[CSRF_HEADER] = csrfToken();
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body;
    else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  if (method === 'POST')
    opts.headers['Idempotency-Key'] = idempotency ?? idempotencyKey(path.includes('trades') ? 'trade' : 'req');

  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Koneksi ke server gagal. Coba lagi.');
  }

  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_ERROR',
      err.message ?? `Permintaan gagal (${res.status})`,
      err.details,
    );
  }
  return payload;
}

export const get = (path, opts) => api(path, opts);
export const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body });
export const patch = (path, body, opts = {}) => api(path, { ...opts, method: 'PATCH', body });
export const put = (path, body, opts = {}) => api(path, { ...opts, method: 'PUT', body });
export const del = (path, opts = {}) => api(path, { ...opts, method: 'DELETE' });
