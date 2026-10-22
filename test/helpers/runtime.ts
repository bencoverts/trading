import supertest, { type SuperTest, type Test } from 'supertest';
import { createRuntime, type Runtime, type RuntimeOptions } from '../../src/bootstrap.js';
import { FakeClock } from '../../src/lib/clock.js';
import { testConfig } from './config.js';
import type { Config } from '../../src/config.js';

export interface TestApp {
  runtime: Runtime;
  clock: FakeClock;
  config: Config;
  request: SuperTest<Test>;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { config?: Config; overrides?: Record<string, string>; runtime?: Partial<Omit<RuntimeOptions, 'config' | 'clock'>> } = {},
): Promise<TestApp> {
  const config = opts.config ?? testConfig(opts.overrides);
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 12, 0, 0));
  const runtime = await createRuntime({
    config,
    clock,
    attachRealtime: false,
    startEngine: false,
    backfill: false,
    runSettlementLoop: false,
    ...opts.runtime,
  });
  await runtime.start();
  const request = supertest(runtime.app) as unknown as SuperTest<Test>;
  return {
    runtime,
    clock,
    config,
    request,
    async close() {
      await runtime.stop();
    },
  };
}

export interface RegisteredUser {
  token: string;
  userId: string;
  email: string;
  password: string;
}

let counter = 0;

export async function registerUser(app: TestApp, email?: string, password = 'password123'): Promise<RegisteredUser> {
  counter += 1;
  const address = email ?? `trader${counter}@example.com`;
  const res = await app.request.post('/api/auth/register').send({ email: address, password });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, email: address, password };
}
