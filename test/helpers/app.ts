import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import pino from 'pino';
import { loadConfig, type Config } from '../../src/config.js';
import { createRuntime, type Runtime } from '../../src/bootstrap.js';
import { FakeClock } from '../../src/lib/clock.js';
import { Database } from '../../src/db/sqlite.js';

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
    // the suite shares one app instance, so only the rate-limit test opts in
    RATE_AUTH_MAX: '1000',
    RATE_TRADE_MAX: '1000',
    RATE_GLOBAL_MAX: '100000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestContext {
  runtime: Runtime;
  api: () => request.SuperTest<request.Test>;
  clock: FakeClock;
  db: Database;
  dbPath: string;
  config: Config;
  close: () => Promise<void>;
}

/**
 * Full app on an in-memory database with a fake clock, no timers started and
 * no listeners opened. Tests drive prices through `runtime.ctx.engine.ingest`.
 */
export async function createTestApp(opts: { env?: Record<string, string>; seed?: boolean; backfill?: boolean } = {}): Promise<TestContext> {
  const config = testConfig(opts.env);
  const clock = new FakeClock();
  const logger = pino({ level: 'silent' });
  // a real file (not :memory:) so tests can reopen the same database
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
    backfill: opts.backfill ?? false,
    seed: opts.seed ?? true,
  });

  const api = () => request(runtime.app) as unknown as request.SuperTest<request.Test>;

  return {
    runtime,
    api,
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

export async function registerUser(
  api: request.SuperTest<request.Test>,
  suffix = Math.random().toString(36).slice(2, 8),
): Promise<{ cookies: string[]; userId: string; email: string; username: string; password: string }> {
  const username = `user_${suffix}`;
  const email = `${username}@example.com`;
  const password = 'password-12345';
  const res = await api.post('/api/v1/auth/register').send({ email, username, password }).expect(201);
  const cookies = cookiesFrom(res);
  return { cookies, userId: res.body.user.id as string, email, username, password };
}

export async function login(
  api: request.SuperTest<request.Test>,
  identifier: string,
  password: string,
): Promise<string[]> {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password }).expect(200);
  return cookiesFrom(res);
}

export async function loginAdmin(api: request.SuperTest<request.Test>): Promise<string[]> {
  return login(api, TEST_ADMIN.email, TEST_ADMIN.password);
}

export function cookiesFrom(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.map((c) => c.split(';')[0]) : [String(raw).split(';')[0]];
}

export function withCookies(req: request.Test, cookies: string[]): request.Test {
  return cookies.length ? req.set('Cookie', cookies.join('; ')) : req;
}
