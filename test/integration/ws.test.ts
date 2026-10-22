import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createTestApp, registerUser, seedPrice, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let url: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  ctx = await createTestApp();
  seedPrice(ctx, 'ASIA_COMPOSITE', 6_000);
  seedPrice(ctx, 'DOGE', 0.42);
  seedPrice(ctx, 'CRYPTO_COMPOSITE', 41_000);

  // attach the realtime server and listen on an ephemeral port
  const { RealtimeServer } = await import('../../src/ws/server.js');
  const server = ctx.runtime.server;
  const realtime = new RealtimeServer({
    server,
    config: ctx.config,
    logger: ctx.runtime.ctx.logger,
    engine: ctx.runtime.ctx.engine,
    tokens: ctx.runtime.ctx.tokens,
    users: ctx.runtime.ctx.users,
    accounts: ctx.runtime.ctx.accounts,
    markets: ctx.runtime.ctx.markets,
  });
  ctx.runtime.ctx.realtime = realtime;
  await ctx.runtime.listen(0, '127.0.0.1');
  const address = server.address() as AddressInfo;
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await ctx.runtime.stop();
});

/**
 * Buffers every incoming frame so a fast `hello` is never missed between
 * `open` and the first `waitFor` call (a real client always has a listener).
 */
class TestSocket {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly waiters: Array<{
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.predicate(message)) {
          this.waiters.splice(i, 1);
          waiter.resolve(message);
          return; // consumed by a waiter, do not buffer it
        }
      }
      this.messages.push(message);
    });
  }

  static connect(query = ''): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url}${query}`);
      sockets.push(socket);
      const wrapped = new TestSocket(socket);
      socket.once('open', () => resolve(wrapped));
      socket.once('error', reject);
    });
  }

  send(payload: unknown): void {
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 3_000): Promise<Record<string, unknown>> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [existing] = this.messages.splice(index, 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for message'));
      }, timeoutMs);
      const wrappedResolve = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push({ predicate, resolve: wrappedResolve });
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('websocket protocol', () => {
  it('sends hello with markets and the simulation label', async () => {
    const socket = await TestSocket.connect();
    const hello = await socket.waitFor((m) => m.type === 'hello');
    expect(hello.label).toBe('SIMULASI');
    expect(Array.isArray(hello.markets)).toBe(true);
    expect((hello.markets as Array<{ symbol: string }>).map((m) => m.symbol)).toContain('DOGE');
    expect(hello.timeframes).toContain('1m');
    expect(hello.authenticated).toBe(false);
  }, 15_000);

  it('acknowledges subscribe and streams ticks with a sequence number', async () => {
    const socket = await TestSocket.connect();
    await socket.waitFor((m) => m.type === 'hello');
    socket.send({ type: 'subscribe', symbol: 'DOGE', timeframe: '1m' });
    const subscribed = await socket.waitFor((m) => m.type === 'subscribed');
    expect(subscribed.symbol).toBe('DOGE');
    expect(subscribed.timeframe).toBe('1m');

    const tickPromise = socket.waitFor((m) => m.type === 'tick');
    ctx.runtime.ctx.engine.ingest('DOGE', 0.43, ctx.clock.now());
    const tick = await tickPromise;
    expect(tick.symbol).toBe('DOGE');
    expect(tick.price).toBe(0.43);
    expect(tick.seq).toBeTypeOf('number');
  }, 15_000);

  it('rejects unknown symbols and bad payloads without crashing', async () => {
    const socket = await TestSocket.connect();
    await socket.waitFor((m) => m.type === 'hello');
    socket.send({ type: 'subscribe', symbol: 'NOPE', timeframe: '1m' });
    const error = await socket.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('MARKET_NOT_FOUND');
    socket.send('not json');
    const parseError = await socket.waitFor((m) => m.type === 'error');
    expect(parseError.code).toBe('INVALID_JSON');
  }, 15_000);

  it('answers ping with pong', async () => {
    const socket = await TestSocket.connect();
    await socket.waitFor((m) => m.type === 'hello');
    socket.send({ type: 'ping', id: 42 });
    const pong = await socket.waitFor((m) => m.type === 'pong');
    expect(pong.id).toBe(42);
    expect(pong.serverTime).toBeTypeOf('number');
  }, 15_000);

  it('authenticates with a session token and receives private trade events', async () => {
    const user = await registerUser(ctx);
    const token = user.client.sessionCookie();
    expect(token).toBeTruthy();
    const socket = await TestSocket.connect(`?token=${token}`);
    const hello = await socket.waitFor((m) => m.type === 'hello');
    expect(hello.authenticated).toBe(true);
    expect(hello.userId).toBe(user.userId);

    const opened = socket.waitFor((m) => m.type === 'trade:opened', 5_000);
    const res = await user.client.post('/api/v1/trades', {
      market: 'DOGE',
      direction: 'up',
      currency: 'USD',
      amount: 2,
      durationSec: 60,
    });
    expect(res.status).toBe(201);
    const event = await opened;
    expect((event.trade as { market: string }).market).toBe('DOGE');
  }, 20_000);

  it('replays missed ticks after a reconnect', async () => {
    const socket = await TestSocket.connect();
    await socket.waitFor((m) => m.type === 'hello');
    socket.send({ type: 'subscribe', symbol: 'ASIA_COMPOSITE', timeframe: '5s' });
    await socket.waitFor((m) => m.type === 'subscribed');
    const seq = ctx.runtime.ctx.engine.lastSeq('ASIA_COMPOSITE');
    ctx.clock.advance(1_000);
    ctx.runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_050, ctx.clock.now());
    socket.send({ type: 'resume', symbol: 'ASIA_COMPOSITE', lastSeq: seq });
    const replay = await socket.waitFor((m) => m.type === 'replay');
    expect((replay.ticks as unknown[]).length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('disconnects a token whose session was revoked', async () => {
    const user = await registerUser(ctx);
    const token = user.client.sessionCookie();
    const socket = await TestSocket.connect(`?token=${token}`);
    const hello = await socket.waitFor((m) => m.type === 'hello');
    expect(hello.authenticated).toBe(true);
    ctx.runtime.ctx.accounts.revokeAll(user.userId, 'test_revoke');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await TestSocket.connect(`?token=${token}`);
    const anonymous = await fresh.waitFor((m) => m.type === 'hello');
    expect(anonymous.authenticated).toBe(false);
  }, 20_000);
});
