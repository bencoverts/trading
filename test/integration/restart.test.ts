import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createRuntime } from '../../src/bootstrap.js';
import { FakeClock } from '../../src/lib/clock.js';
import { testConfig } from '../helpers/config.js';

describe('server restart', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('settles trades that expired while the server was down and keeps the balance consistent', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'trading-restart-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const config = testConfig({ SQLITE_PATH: dbPath, LOG_LEVEL: 'silent' });
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 12, 0, 0));

    // ---- first process ---------------------------------------------------
    const rt1 = await createRuntime({
      config,
      clock,
      attachRealtime: false,
      startEngine: false,
      backfill: false,
      runSettlementLoop: false,
    });
    await rt1.start();
    const api1 = supertest(rt1.app);
    const reg = await api1.post('/api/auth/register').send({ email: 'restart@example.com', password: 'password123' });
    expect(reg.status).toBe(201);
    const token = reg.body.token as string;

    rt1.ctx.engine.ingest(6200, clock.now());
    const create = await api1
      .post('/api/trades')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'ASIA50', direction: 'up', amount: 100, durationSec: 5 });
    expect(create.status).toBe(201);
    const tradeId = create.body.trade.id;

    const beforeStop = await api1.get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(beforeStop.body.account.balanceCents).toBe(990_000); // 10,000 - 100 held
    await rt1.stop();

    // ---- "downtime": expiry passes with no process running ----------------
    clock.advance(30_000);

    // ---- second process on the same database ------------------------------
    const rt2 = await createRuntime({
      config,
      clock,
      attachRealtime: false,
      startEngine: false,
      backfill: false,
      runSettlementLoop: false,
    });
    await rt2.start();
    try {
      const api2 = supertest(rt2.app);
      const open = await api2.get('/api/trades?status=open').set('Authorization', `Bearer ${token}`);
      expect(open.body.trades).toHaveLength(1);
      expect(open.body.trades[0].id).toBe(tradeId);

      const settledCount = await rt2.ctx.settlement.runOnce();
      expect(settledCount).toBe(1);

      const detail = await api2.get(`/api/trades/${tradeId}`).set('Authorization', `Bearer ${token}`);
      expect(detail.body.trade.status).toBe('closed');
      // the price at expiry is unknown after downtime -> safest outcome is a full refund
      expect(detail.body.trade.result).toBe('draw');
      expect(detail.body.trade.payoutCents).toBe(10_000);

      const after = await api2.get('/api/me').set('Authorization', `Bearer ${token}`);
      expect(after.body.account.balanceCents).toBe(1_000_000);

      // migrations are idempotent across restarts
      const migrations = await rt2.ctx.db.all<{ name: string }>(`SELECT name FROM schema_migrations`);
      expect(migrations).toHaveLength(1);

      // the balance audit trail recorded both the hold and the settlement
      const audit = await rt2.ctx.db.all<{ action: string }>(
        `SELECT action FROM audit_log ORDER BY created_at ASC, id ASC`,
      );
      const actions = audit.map((a) => a.action);
      expect(actions).toContain('trade_opened');
      expect(actions).toContain('trade_settled');
    } finally {
      await rt2.stop();
    }
  });

  it('persists candles so chart history survives a restart', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'trading-candles-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const config = testConfig({ SQLITE_PATH: dbPath, LOG_LEVEL: 'silent' });
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 12, 0, 0));

    const rt1 = await createRuntime({ config, clock, attachRealtime: false, startEngine: false, backfill: true });
    await rt1.start();
    // a full 5s bucket then a new one -> the first candle is closed and persisted
    rt1.ctx.engine.ingest(6200, clock.now());
    rt1.ctx.engine.ingest(6210, clock.now() + 1_000);
    rt1.ctx.engine.ingest(6195, clock.now() + 5_000);
    await new Promise((r) => setTimeout(r, 100));
    await rt1.stop();

    const rt2 = await createRuntime({ config, clock, attachRealtime: false, startEngine: false, backfill: false });
    await rt2.start();
    try {
      const res = await supertest(rt2.app).get('/api/candles?tf=5s&limit=100&includeCurrent=false');
      expect(res.status).toBe(200);
      expect(res.body.candles.length).toBeGreaterThanOrEqual(1);
      // the bucket that was completed before shutdown is preserved
      const closedBucket = res.body.candles.find((c: any) => c.t === clock.now());
      expect(closedBucket).toEqual({ t: clock.now(), o: 6200, h: 6210, l: 6200, c: 6210 });
      // the last partial bucket is flushed on shutdown as well (documented behaviour)
      const partial = res.body.candles.find((c: any) => c.t === clock.now() + 5_000);
      expect(partial).toMatchObject({ o: 6195, c: 6195 });
    } finally {
      await rt2.stop();
    }
  });
});
