import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp, type RegisteredUser } from '../helpers/runtime.js';

const INITIAL = 1_000_000; // cents

describe('HTTP trade flow: open -> settle', () => {
  let app: TestApp;
  let user: RegisteredUser;

  beforeEach(async () => {
    app = await createTestApp();
    user = await registerUser(app);
    app.runtime.ctx.engine.ingest(6204.5, app.clock.now());
  });

  afterEach(async () => {
    await app.close();
  });

  const api = {
    get: (url: string) => app.request.get(url).set('Authorization', `Bearer ${user.token}`),
    post: (url: string) => app.request.post(url).set('Authorization', `Bearer ${user.token}`),
  };

  async function openTrade(body: Record<string, unknown> = {}, key?: string) {
    const req = api.post('/api/trades').send({
      symbol: 'ASIA50',
      direction: 'up',
      amount: 10,
      durationSec: 5,
      ...body,
    });
    if (key) req.set('Idempotency-Key', key);
    return req;
  }

  it('registers with the demo starting balance and exposes /api/me', async () => {
    const me = await api.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ balance: 10_000, balanceCents: INITIAL, currency: 'USD' });
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.limits).toMatchObject({ allowedDurations: [5, 15, 30, 60], payoutRate: 0.85, openTrades: 0 });
  });

  it('opens a BUY trade, holds the stake and settles it as a win', async () => {
    const create = await openTrade({ amount: 10 }, 'flow-win-0001');
    expect(create.status).toBe(201);
    expect(create.body.trade).toMatchObject({
      symbol: 'ASIA50',
      direction: 'up',
      amount: 10,
      amountCents: 1_000,
      status: 'open',
      entryPrice: 6204.5,
      durationSec: 5,
      payoutRate: 0.85,
      result: null,
    });
    const tradeId = create.body.trade.id;

    const during = await api.get('/api/me');
    expect(during.body.account.balanceCents).toBe(INITIAL - 1_000);

    const openList = await api.get('/api/trades?status=open');
    expect(openList.body.trades).toHaveLength(1);
    expect(openList.body.trades[0].id).toBe(tradeId);

    // five seconds later the server closes at a higher price
    app.clock.advance(5_000);
    app.runtime.ctx.engine.ingest(6210.75, app.clock.now());
    const settledCount = await app.runtime.ctx.settlement.runOnce();
    expect(settledCount).toBe(1);

    const detail = await api.get(`/api/trades/${tradeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.trade).toMatchObject({
      status: 'closed',
      result: 'win',
      closePrice: 6210.75,
      payoutCents: 1_850,
      payout: 18.5,
      profit: 8.5,
    });

    const after = await api.get('/api/me');
    expect(after.body.account.balanceCents).toBe(INITIAL - 1_000 + 1_850);

    const closed = await api.get('/api/trades?status=closed&limit=10');
    expect(closed.body.trades.map((t: any) => t.id)).toEqual([tradeId]);
    const all = await api.get('/api/trades?status=all');
    expect(all.body.trades).toHaveLength(1);
  });

  it('settles a losing trade with zero payout', async () => {
    const create = await openTrade({ direction: 'down', amount: 25 });
    app.clock.advance(5_000);
    app.runtime.ctx.engine.ingest(6210, app.clock.now()); // price rose, SELL loses
    await app.runtime.ctx.settlement.runOnce();

    const detail = await api.get(`/api/trades/${create.body.trade.id}`);
    expect(detail.body.trade.result).toBe('lose');
    expect(detail.body.trade.payoutCents).toBe(0);
    const me = await api.get('/api/me');
    expect(me.body.account.balanceCents).toBe(INITIAL - 2_500);
  });

  it('refunds a draw', async () => {
    const create = await openTrade({ amount: 30 });
    app.clock.advance(5_000);
    app.runtime.ctx.engine.ingest(6204.5, app.clock.now());
    await app.runtime.ctx.settlement.runOnce();

    const detail = await api.get(`/api/trades/${create.body.trade.id}`);
    expect(detail.body.trade.result).toBe('draw');
    expect(detail.body.trade.payoutCents).toBe(3_000);
    const me = await api.get('/api/me');
    expect(me.body.account.balanceCents).toBe(INITIAL);
  });

  it('does not create a second trade for a repeated Idempotency-Key', async () => {
    const first = await openTrade({ amount: 10 }, 'flow-idem-0001');
    const second = await openTrade({ amount: 10 }, 'flow-idem-0001');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.trade.id).toBe(first.body.trade.id);

    const me = await api.get('/api/me');
    expect(me.body.account.balanceCents).toBe(INITIAL - 1_000);
    const open = await api.get('/api/trades?status=open');
    expect(open.body.trades).toHaveLength(1);
  });

  it('rejects reuse of an Idempotency-Key with a different payload', async () => {
    await openTrade({ amount: 10 }, 'flow-idem-0002');
    const conflict = await openTrade({ amount: 20 }, 'flow-idem-0002');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a stake larger than the balance without holding anything', async () => {
    const res = await openTrade({ amount: 10_001 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR'); // above max stake first
    const me = await api.get('/api/me');
    expect(me.body.account.balanceCents).toBe(INITIAL);
  });

  it('validates the request body', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amount: 0 }, 'VALIDATION_ERROR'],
      [{ amount: -5 }, 'VALIDATION_ERROR'],
      [{ amount: 10.555 }, 'VALIDATION_ERROR'],
      [{ amount: '10' }, 'VALIDATION_ERROR'],
      [{ direction: 'sideways' }, 'VALIDATION_ERROR'],
      [{ durationSec: 7 }, 'DURATION_NOT_ALLOWED'],
      [{ durationSec: 0 }, 'VALIDATION_ERROR'],
      [{ symbol: 'BTCUSD' }, 'SYMBOL_INACTIVE'],
    ];
    for (const [patch, code] of cases) {
      const res = await openTrade(patch);
      expect(res.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code, JSON.stringify(patch)).toBe(code);
    }
    expect((await api.get('/api/me')).body.account.balanceCents).toBe(INITIAL);
  });

  it('rejects an invalid Idempotency-Key header', async () => {
    const res = await openTrade({}, 'short');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const res = await app.request.post('/api/trades').send({ symbol: 'ASIA50', direction: 'up', amount: 1, durationSec: 5 });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect((await app.request.get('/api/me')).status).toBe(401);
    expect((await app.request.get('/api/trades')).status).toBe(401);
  });

  it('does not leak another user\'s trades', async () => {
    const other = await registerUser(app, 'someone-else@example.com');
    const create = await openTrade();
    const res = await app.request.get(`/api/trades/${create.body.trade.id}`).set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('resets the demo balance and voids open trades', async () => {
    await openTrade({ amount: 10 });
    app.clock.advance(1_000);
    const reset = await api.post('/api/account/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.account.balanceCents).toBe(INITIAL);
    expect(reset.body.voidedTrades).toBe(1);

    const trades = await api.get('/api/trades?status=closed');
    expect(trades.body.trades).toHaveLength(1);
    expect(trades.body.trades[0]).toMatchObject({ status: 'closed', result: 'draw', payoutCents: 1_000 });

    const me = await api.get('/api/me');
    expect(me.body.account.balanceCents).toBe(INITIAL);
  });

  it('rejects malformed JSON and oversized payloads', async () => {
    const malformed = await api.post('/api/trades')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');

    const huge = await api.post('/api/trades')
      .send({ symbol: 'ASIA50', direction: 'up', amount: 1, durationSec: 5, junk: 'x'.repeat(40_000) });
    expect(huge.status).toBe(413);
  });
});
