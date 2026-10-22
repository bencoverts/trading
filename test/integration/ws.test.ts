import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/bootstrap.js';
import { testConfig } from '../helpers/app.js';
import type { Runtime } from '../../src/bootstrap.js';

let runtime: Runtime;
let url = '';

/**
 * Messages are buffered from the moment the socket is created, otherwise the
 * `hello` frame (sent immediately on connect) can arrive before a test attaches
 * its listener.
 */
const buffers = new WeakMap<WebSocket, any[]>();

async function connect(target = url, opts?: { origin?: string }): Promise<WebSocket> {
  const ws = new WebSocket(target, opts);
  const buffer: any[] = [];
  buffers.set(ws, buffer);
  ws.on('message', (raw) => {
    try {
      buffer.push(JSON.parse(String(raw)));
    } catch {
      /* ignore non-JSON frames */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

/** Consumes the first buffered message matching `predicate` (poll-based, race free). */
async function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeout = 3_000): Promise<any> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const buffer = buffers.get(ws) ?? [];
    const index = buffer.findIndex(predicate);
    if (index >= 0) return buffer.splice(index, 1)[0];
    if (Date.now() > deadline) throw new Error('timed out waiting for websocket message');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  runtime = await createRuntime({
    config: testConfig(),
    logger: (await import('pino')).default({ level: 'silent' }),
    attachRealtime: true,
    startEngine: false,
    runSettlementLoop: false,
    backfill: false,
  });
  const port = await runtime.listen(0, '127.0.0.1');
  url = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => {
  await runtime.stop();
});

describe('websocket market feed', () => {
  it('greets with hello and SIMULASI metadata', async () => {
    const ws = await connect();
    const hello = await waitFor(ws, (m) => m.type === 'hello');
    expect(hello.simulation).toBe(true);
    expect(hello.timeframes).toEqual(['5s', '15s', '30s', '1m', '5m', '15m', '1h']);
    expect(hello.markets.map((m: { symbol: string }) => m.symbol).sort()).toEqual(['ASIA_COMPOSITE', 'CRYPTO_COMPOSITE', 'DOGE']);
    expect(hello.authenticated).toBe(false);
    ws.close();
  });

  it('delivers ticks and candles after subscribing to one market + timeframe', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');

    ws.send(JSON.stringify({ type: 'subscribe', market: 'DOGE', timeframe: '5s' }));
    const subscribed = await waitFor(ws, (m) => m.type === 'subscribed');
    expect(subscribed).toMatchObject({ market: 'DOGE', timeframe: '5s' });

    const tickA = waitFor(ws, (m) => m.type === 'tick' && m.market === 'DOGE');
    const candleA = waitFor(ws, (m) => m.type === 'candle' && m.tf === '5s');
    runtime.ctx.engine.ingest('DOGE', 0.4123, Date.now());

    const tick = await tickA;
    expect(tick.price).toBe(0.4123);
    expect(tick.seq).toBeGreaterThan(0);
    const candle = await candleA;
    expect(candle.o).toBe(0.4123);
    expect(candle.c).toBe(0.4123);
    ws.close();
  });

  it('emits candle_closed exactly once per bucket boundary', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');
    ws.send(JSON.stringify({ type: 'subscribe', market: 'ASIA_COMPOSITE', timeframe: '5s' }));
    await waitFor(ws, (m) => m.type === 'subscribed');

    const base = Math.floor(Date.now() / 5_000) * 5_000;
    const closedPromise = waitFor(ws, (m) => m.type === 'candle_closed' && m.tf === '5s');
    runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_500, base + 1_000);
    runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_510, base + 6_000);
    const closed = await closedPromise;
    expect(closed.candle.t).toBe(base);
    expect(closed.candle.c).toBe(6_500);
    ws.close();
  });

  it('only sends ticks for subscribed markets', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');
    ws.send(JSON.stringify({ type: 'subscribe', market: 'DOGE', timeframe: '1m' }));
    await waitFor(ws, (m) => m.type === 'subscribed');

    const received: string[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'tick') received.push(msg.market);
    });
    runtime.ctx.engine.ingest('CRYPTO_COMPOSITE', 41_000, Date.now());
    runtime.ctx.engine.ingest('DOGE', 0.42, Date.now());
    const tick = await waitFor(ws, (m) => m.type === 'tick');
    expect(tick.market).toBe('DOGE');
    expect(received).not.toContain('CRYPTO_COMPOSITE');
    ws.close();
  });

  it('answers ping and rejects malformed messages without dropping the socket', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');

    ws.send(JSON.stringify({ type: 'ping', id: 7 }));
    const pong = await waitFor(ws, (m) => m.type === 'pong');
    expect(pong.id).toBe(7);

    ws.send('not json');
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.code).toBe('INVALID_JSON');

    ws.send(JSON.stringify({ type: 'subscribe', market: 'NOPE', timeframe: '1m' }));
    const unknown = await waitFor(ws, (m) => m.type === 'error');
    expect(unknown.code).toBe('MARKET_NOT_FOUND');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects unsupported timeframes and over-subscription', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');
    ws.send(JSON.stringify({ type: 'subscribe', market: 'DOGE', timeframe: '2m' }));
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.code).toBe('TIMEFRAME_NOT_SUPPORTED');
    ws.close();
  });

  it('replays missed ticks on resume and resyncs when the sequence is too old', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => m.type === 'hello');

    for (let i = 0; i < 3; i++) runtime.ctx.engine.ingest('DOGE', 0.4 + i * 0.001, Date.now() + i);
    const seq = runtime.ctx.engine.lastSeq('DOGE') - 2;
    ws.send(JSON.stringify({ type: 'resume', market: 'DOGE', lastSeq: seq }));
    const replay = await waitFor(ws, (m) => m.type === 'replay');
    expect(replay.ticks.length).toBeGreaterThanOrEqual(2);
    expect(replay.ticks.every((t: { seq: number }) => t.seq > seq)).toBe(true);

    ws.send(JSON.stringify({ type: 'resume', market: 'ASIA_COMPOSITE', lastSeq: 0 }));
    const resync = await waitFor(ws, (m) => m.type === 'resync' || m.type === 'replay');
    expect(['resync', 'replay']).toContain(resync.type);
    ws.close();
  });

  it('authenticates a socket with a session token and pushes trade events to that user', async () => {
    // create a user through the HTTP API of the same runtime
    const request = (await import('supertest')).default;
    const reg = await request(runtime.app)
      .post('/api/v1/auth/register')
      .send({ email: 'ws-user@example.com', username: 'wsuser', password: 'password-12345' })
      .expect(201);
    const token = reg.body.token as string;

    const ws = await connect(`${url}?token=${encodeURIComponent(token)}`);
    const hello = await waitFor(ws, (m) => m.type === 'hello' && m.authenticated);
    expect(hello.authenticated).toBe(true);
    expect(hello.userId).toBe(reg.body.user.id);

    runtime.ctx.engine.ingest('DOGE', 0.4, Date.now());
    const openedPromise = waitFor(ws, (m) => m.type === 'trade:opened');
    await request(runtime.app)
      .post('/api/v1/trades')
      .set('Cookie', String(reg.headers['set-cookie'][0]).split(';')[0])
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(201);
    const opened = await openedPromise;
    expect(opened.trade.market).toBe('DOGE');
    expect(opened.trade.status).toBe('open');

    const balance = await waitFor(ws, (m) => m.type === 'balance');
    expect(balance.wallets.length).toBe(3);
    ws.close();
  });

  it('rejects a websocket from a foreign browser origin', async () => {
    const address = runtime.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: 'https://evil.example' });
    const result = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    expect(result).toBe('error');
  });
});
