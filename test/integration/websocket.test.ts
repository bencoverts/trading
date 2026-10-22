import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp, type RegisteredUser } from '../helpers/runtime.js';
import { wait, WsTestClient } from '../helpers/ws.js';

describe('WebSocket /ws', () => {
  let app: TestApp;
  let user: RegisteredUser;
  let client: WsTestClient;
  let port: number;

  beforeEach(async () => {
    app = await createTestApp({ runtime: { attachRealtime: true } });
    user = await registerUser(app);
    port = await app.runtime.listen(0, '127.0.0.1');
    client = await WsTestClient.connect(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(user.token)}`);
  });

  afterEach(async () => {
    await client?.close();
    await app?.close();
  });

  const url = () => `ws://127.0.0.1:${port}/ws`;

  it('greets the client with server configuration', async () => {
    const hello = await client.waitFor((m) => m.type === 'hello');
    expect(hello).toMatchObject({
      symbol: 'ASIA50',
      authenticated: true,
      userId: user.userId,
      priceDecimals: 2,
      timeframes: ['5s', '15s', '30s', '1m', '5m'],
    });
    expect(typeof hello.serverTime).toBe('number');
    expect(hello.seq).toBe(0);
  });

  it('acknowledges subscriptions and streams ticks + candles', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' });
    const ack = await client.waitFor((m) => m.type === 'subscribed');
    expect(ack).toMatchObject({ symbol: 'ASIA50', timeframe: '5s' });

    const mark = client.mark();
    app.runtime.ctx.engine.ingest(6204.5, app.clock.now());

    const tick = await client.waitAfter(mark, (m) => m.type === 'tick');
    expect(tick).toMatchObject({ symbol: 'ASIA50', price: 6204.5, seq: 1 });
    expect(tick.time).toBe(app.clock.now());

    const candle = await client.waitAfter(mark, (m) => m.type === 'candle');
    expect(candle).toMatchObject({ symbol: 'ASIA50', tf: '5s', o: 6204.5, h: 6204.5, l: 6204.5, c: 6204.5 });
  });

  it('answers ping with pong and echoes the id', async () => {
    client.send({ type: 'ping', id: 'abc-1' });
    const pong = await client.waitFor((m) => m.type === 'pong');
    expect(pong.id).toBe('abc-1');
    expect(typeof pong.serverTime).toBe('number');
  });

  it('reports unsupported subscriptions as errors', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '7s' });
    const err = await client.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('TIMEFRAME_NOT_SUPPORTED');

    const mark = client.mark();
    client.send({ type: 'subscribe', symbol: 'BTCUSD', timeframe: '5s' });
    const err2 = await client.waitAfter(mark, (m) => m.type === 'error');
    expect(err2.code).toBe('SYMBOL_INACTIVE');
  });

  it('rejects invalid JSON and unknown message types', async () => {
    const ws = client as any;
    ws.send({ type: 'nonsense' });
    const err = await client.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('INVALID_MESSAGE');

    const mark = client.mark();
    client.send({ type: 'subscribe' });
    const err2 = await client.waitAfter(mark, (m) => m.type === 'error');
    expect(err2.code).toBe('INVALID_MESSAGE');
  });

  it('never drops candle_closed and delivers it outside the tick throttle', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' });
    await client.waitFor((m) => m.type === 'subscribed');
    const t0 = app.clock.now();

    const mark = client.mark();
    app.runtime.ctx.engine.ingest(6200, t0);
    app.runtime.ctx.engine.ingest(6210, t0 + 5_000);

    const closed = await client.waitAfter(mark, (m) => m.type === 'candle_closed');
    expect(closed.tf).toBe('5s');
    expect(closed.candle).toEqual({ t: t0, o: 6200, h: 6200, l: 6200, c: 6200 });
  });

  it('throttles ticks but always sends the newest price', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' });
    await client.waitFor((m) => m.type === 'subscribed');

    const mark = client.mark();
    const t0 = app.clock.now();
    for (let i = 0; i < 60; i++) app.runtime.ctx.engine.ingest(6200 + i, t0 + i * 10);
    await wait(400);

    const ticks = client.messages.slice(mark).filter((m) => m.type === 'tick');
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(30); // 60 ticks coalesced down to the 20/s budget
    expect(ticks[ticks.length - 1].price).toBe(6259);
    expect(ticks[ticks.length - 1].seq).toBe(60);
  });

  it('streams trade:opened, balance and trade:settled to the owner', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' });
    await client.waitFor((m) => m.type === 'subscribed');
    app.runtime.ctx.engine.ingest(6204.5, app.clock.now());

    const mark = client.mark();
    const created = await app.request
      .post('/api/trades')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', 'ws-flow-0001')
      .send({ symbol: 'ASIA50', direction: 'up', amount: 10, durationSec: 5 });
    expect(created.status).toBe(201);
    const tradeId = created.body.trade.id;

    const opened = await client.waitAfter(mark, (m) => m.type === 'trade:opened');
    expect(opened.trade.id).toBe(tradeId);
    expect(opened.trade.status).toBe('open');

    const balance = await client.waitAfter(mark, (m) => m.type === 'balance');
    expect(balance).toEqual({ type: 'balance', amount: 9_990, amountCents: 999_000, currency: 'USD' });

    const settleMark = client.mark();
    app.clock.advance(5_000);
    app.runtime.ctx.engine.ingest(6210, app.clock.now());
    await app.runtime.ctx.settlement.runOnce();

    const settled = await client.waitAfter(settleMark, (m) => m.type === 'trade:settled');
    expect(settled).toMatchObject({
      id: tradeId,
      result: 'win',
      payout: 18.5,
      closePrice: 6210,
    });
    expect(settled.trade.status).toBe('closed');

    const balances = client.messages.slice(settleMark).filter((m) => m.type === 'balance');
    expect(balances[balances.length - 1].amountCents).toBe(1_000_850);
  });

  it('resumes from a sequence number by replaying missed ticks', async () => {
    client.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' });
    await client.waitFor((m) => m.type === 'subscribed');
    const t0 = app.clock.now();
    app.runtime.ctx.engine.ingest(6200, t0);
    app.runtime.ctx.engine.ingest(6201, t0 + 100);
    app.runtime.ctx.engine.ingest(6202, t0 + 200);
    await client.waitFor((m) => m.type === 'tick' && m.seq === 3);

    const mark = client.mark();
    client.send({ type: 'resume', lastSeq: 1 });
    const replay = await client.waitAfter(mark, (m) => m.type === 'replay');
    expect(replay.fromSeq).toBe(1);
    expect(replay.ticks.map((t: any) => t.seq)).toEqual([2, 3]);
    expect(replay.ticks.map((t: any) => t.price)).toEqual([6201, 6202]);
    expect(replay.candles.some((c: any) => c.tf === '5s')).toBe(true);
  });

  it('asks for a resync when the sequence is too old', async () => {
    // shrink the buffer so old sequences are evicted
    const engine = app.runtime.ctx.engine;
    for (let i = 0; i < 20_100; i++) engine.ingest(6200 + (i % 10), app.clock.now() + i);
    const mark = client.mark();
    client.send({ type: 'resume', lastSeq: 1 });
    const resync = await client.waitAfter(mark, (m) => m.type === 'resync');
    expect(resync.reason).toBe('seq_too_old');
  });

  it('allows anonymous market data but not account messages', async () => {
    const anon = await WsTestClient.connect(url());
    try {
      const hello = await anon.waitFor((m) => m.type === 'hello');
      expect(hello.authenticated).toBe(false);
      expect(hello.userId).toBeNull();

      anon.send({ type: 'subscribe', symbol: 'ASIA50', timeframe: '1m' });
      await anon.waitFor((m) => m.type === 'subscribed');

      const mark = anon.mark();
      app.runtime.ctx.engine.ingest(6204.5, app.clock.now());
      await app.request
        .post('/api/trades')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ symbol: 'ASIA50', direction: 'up', amount: 5, durationSec: 5 });

      await anon.waitAfter(mark, (m) => m.type === 'tick');
      await wait(150);
      const accountMessages = anon.messages.filter((m) => m.type === 'trade:opened' || m.type === 'balance');
      expect(accountMessages).toHaveLength(0);
    } finally {
      await anon.close();
    }
  });

  it('authenticates an anonymous socket via the auth message', async () => {
    const anon = await WsTestClient.connect(url());
    try {
      await anon.waitFor((m) => m.type === 'hello' && m.authenticated === false);
      const mark = anon.mark();
      anon.send({ type: 'auth', token: user.token });
      const hello = await anon.waitAfter(mark, (m) => m.type === 'hello');
      expect(hello.authenticated).toBe(true);
      expect(hello.userId).toBe(user.userId);

      const balanceMark = anon.mark();
      await app.request.post('/api/account/reset').set('Authorization', `Bearer ${user.token}`);
      const balance = await anon.waitAfter(balanceMark, (m) => m.type === 'balance');
      expect(balance.amountCents).toBe(1_000_000);
    } finally {
      await anon.close();
    }
  });
});
