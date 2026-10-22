import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import pino from 'pino';
import { loadConfig, type Config } from '../../src/config.js';
import { createRuntime, type Runtime } from '../../src/bootstrap.js';
import { FakeClock } from '../../src/lib/clock.js';
import { Database } from '../../src/db/sqlite.js';
import type { StaffRole } from '../../src/auth/permissions.js';

export const TEST_ADMIN = { email: 'admin@test.local', username: 'testadmin', password: 'test-admin-password' };

/** Config built from an explicit env object (no reliance on the host .env). */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
    SQLITE_PATH: ':memory:',
    ADMIN_EMAIL: TEST_ADMIN.email,
    ADMIN_USERNAME: TEST_ADMIN.username,
    ADMIN_PASSWORD: TEST_ADMIN.password,
    ARGON2_MEMORY_KIB: '1024',
    ARGON2_TIME_COST: '1',
    RATE_AUTH_MAX: '1000',
    RATE_TRADE_MAX: '1000',
    RATE_GLOBAL_MAX: '100000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestContext {
  runtime: Runtime;
  /** raw supertest handle (no cookies, no CSRF) */
  api: () => request.SuperTest<request.Test>;
  /** cookie/CSRF-aware client */
  client: () => HttpClient;
  clock: FakeClock;
  db: Database;
  dbPath: string;
  config: Config;
  close: () => Promise<void>;
}

/**
 * Full app on a temporary database file with a fake clock, no timers started
 * and no listeners opened. Tests drive prices through `runtime.ctx.engine`.
 */
export async function createTestApp(
  opts: { env?: Record<string, string>; seed?: boolean; backfill?: boolean; demoData?: boolean } = {},
): Promise<TestContext> {
  const config = testConfig(opts.env);
  const clock = new FakeClock();
  const logger = pino({ level: 'silent' });
  const dbPath = mkdtempSync(path.join(os.tmpdir(), 'simtrade-')).concat(`/db-${(counter += 1)}.sqlite`);
  const db = new Database(dbPath);

  const runtime = await createRuntime({
    config: { ...config, SQLITE_PATH: dbPath },
    db,
    clock,
    logger,
    attachRealtime: false,
    startEngine: false,
    runSettlementLoop: false,
    startJobs: false,
    backfill: opts.backfill ?? false,
    seed: opts.seed ?? true,
    demoData: opts.demoData ?? false,
  });

  const api = () => request(runtime.app) as unknown as request.SuperTest<request.Test>;

  return {
    runtime,
    api,
    client: () => new HttpClient(runtime),
    clock,
    db,
    dbPath,
    config,
    close: async () => {
      await runtime.stop();
    },
  };
}

let counter = 0;

/** Opens a second connection to the same file (used for restart tests). */
export function reopen(ctx: TestContext): Database {
  return new Database(ctx.dbPath);
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string | null;
  /** when true, skips the CSRF header (used to prove CSRF is enforced) */
  noCsrf?: boolean;
  expect?: number;
}

/**
 * Minimal browser-like HTTP client: keeps cookies between requests and echoes
 * the CSRF cookie in the header exactly like the SPA does.
 */
export class HttpClient {
  readonly cookies = new Map<string, string>();
  constructor(private readonly runtime: Runtime) {}

  csrfToken(): string | undefined {
    return this.cookies.get(this.runtime.ctx.config.CSRF_COOKIE);
  }

  sessionCookie(): string | undefined {
    return this.cookies.get(this.runtime.ctx.config.COOKIE_NAME);
  }

  private capture(res: request.Response): void {
    const raw = res.headers['set-cookie'];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [String(raw)];
    for (const cookie of list) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: Method, url: string, opts: RequestOptions = {}): Promise<request.Response> {
    let req = request(this.runtime.app)[method](url) as request.Test;
    if (this.cookies.size) {
      req = req.set('Cookie', [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const csrf = this.csrfToken();
    if (csrf && !opts.noCsrf) req = req.set(this.runtime.ctx.config.CSRF_HEADER, csrf);
    for (const [key, value] of Object.entries(opts.headers ?? {})) req = req.set(key, value);
    if (opts.idempotencyKey !== null) {
      req = req.set(
        'Idempotency-Key',
        opts.idempotencyKey ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
    }
    if (opts.body !== undefined) req = req.send(opts.body as object);
    const res = await req;
    this.capture(res);
    if (opts.expect !== undefined && res.status !== opts.expect) {
      throw new Error(
        `expected ${opts.expect} for ${method.toUpperCase()} ${url}, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return res;
  }

  get(url: string, opts: RequestOptions = {}) {
    return this.request('get', url, opts);
  }
  post(url: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request('post', url, { ...opts, body });
  }
  patch(url: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request('patch', url, { ...opts, body });
  }
  put(url: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request('put', url, { ...opts, body });
  }
  delete(url: string, opts: RequestOptions = {}) {
    return this.request('delete', url, opts);
  }
}

export interface TestUser {
  userId: string;
  email: string;
  username: string;
  password: string;
  client: HttpClient;
}

export async function registerUser(
  ctx: TestContext,
  suffix = Math.random().toString(36).slice(2, 8),
): Promise<TestUser> {
  const client = ctx.client();
  await client.get('/api/v1/config');
  const username = `user_${suffix}`;
  const email = `${username}@example.com`;
  const password = 'password-12345';
  const res = await client.post('/api/v1/auth/register', {
    email,
    username,
    password,
    acceptTerms: true,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { userId: res.body.user.id as string, email, username, password, client };
}

export async function login(ctx: TestContext, identifier: string, password: string): Promise<HttpClient> {
  const client = ctx.client();
  await client.get('/api/v1/config');
  const res = await client.post('/api/v1/auth/login', { identifier, password });
  if (res.status !== 200) throw new Error(`login failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

export async function loginAdmin(ctx: TestContext): Promise<HttpClient> {
  return login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
}

/** Creates a user with a staff role through the service layer (no admin needed). */
export async function createStaffUser(
  ctx: TestContext,
  role: StaffRole,
  suffix = Math.random().toString(36).slice(2, 8),
): Promise<TestUser> {
  const user = await registerUser(ctx, suffix);
  ctx.runtime.ctx.users.setStaffRole(user.userId, role, { userId: user.userId, role: 'admin' });
  // role change bumps token_version: re-login so the session carries the new version
  const client = await login(ctx, user.email, user.password);
  return { ...user, client };
}

/** Advances the fake clock and records one tick per market at the current price. */
export function tick(ctx: TestContext, advanceMs = 250): void {
  ctx.clock.advance(advanceMs);
  for (const symbol of ctx.runtime.ctx.engine.symbols) {
    const price = ctx.runtime.ctx.engine.lastPrice(symbol) ?? 100;
    ctx.runtime.ctx.engine.ingest(symbol, price, ctx.clock.now());
  }
}

/** Pushes one explicit price at the current (fake) clock time. */
export function pushPrice(ctx: TestContext, symbol: string, price: number): void {
  ctx.runtime.ctx.engine.ingest(symbol, price, ctx.clock.now());
}

/** Seeds an initial tick so `entryPrice` exists without a running engine. */
export function seedPrice(ctx: TestContext, symbol: string, price: number): void {
  ctx.runtime.ctx.engine.setPrice(symbol, price);
  ctx.runtime.ctx.engine.ingest(symbol, price, ctx.clock.now());
}
