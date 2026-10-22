import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../lib/logger.js';
import type { PriceEngine } from '../price/engine.js';
import type { TokenService } from '../auth/tokens.js';
import { clientMessageSchema, type ServerMessage } from './protocol.js';

interface Pending {
  tick?: { price: number; time: number; seq: number };
  candles: Map<string, { t: number; o: number; h: number; l: number; c: number; seq: number }>;
}

interface ClientState {
  id: number;
  ws: WebSocket;
  userId: string | null;
  role: 'user' | 'admin' | null;
  subscriptions: Set<string>; // "symbol|timeframe"
  pending: Pending;
  alive: boolean;
  msgBudget: number;
  msgWindowStart: number;
  closed: boolean;
}

export interface RealtimeServerOptions {
  server: HttpServer;
  config: Config;
  logger: Logger;
  engine: PriceEngine;
  tokens: TokenService;
  path?: string;
}

/**
 * WebSocket fan-out for market data and account events.
 *
 * - ticks are throttled per client (WS_TICK_MAX_PER_SEC) and coalesced: a slow
 *   client receives the latest price, never a growing queue
 * - candle updates are coalesced the same way
 * - candle_closed is sent immediately and is never dropped
 * - each tick carries a monotonically increasing seq; clients can resume
 * - heartbeat via protocol ping/pong on a fixed interval
 */
export class RealtimeServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly byUser = new Map<string, Set<ClientState>>();
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribers: Array<() => void> = [];
  private nextClientId = 1;
  private closing = false;

  constructor(private readonly opts: RealtimeServerOptions) {
    this.wss = new WebSocketServer({
      server: opts.server,
      path: opts.path ?? '/ws',
      maxPayload: 8 * 1024,
      perMessageDeflate: false,
      verifyClient: (info, done) => {
        if (this.clients.size >= opts.config.WS_MAX_CONNECTIONS) {
          done(false, 503, 'Too many connections');
          return;
        }
        done(this.isOriginAllowed(info.req));
      },
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    const flushMs = Math.max(50, Math.floor(1000 / opts.config.WS_TICK_MAX_PER_SEC));
    this.flushTimer = setInterval(() => this.flushPending(), flushMs);
    this.flushTimer.unref?.();

    this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.config.WS_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();

    this.unsubscribers.push(
      opts.engine.events.on('tick', (tick) => {
        for (const client of this.clients) {
          if (this.isSubscribed(client, tick.symbol)) {
            client.pending.tick = { price: tick.price, time: tick.time, seq: tick.seq };
          }
        }
      }),
      opts.engine.events.on('candle', ({ tf, candle }) => {
        const seq = opts.engine.lastSeq;
        for (const client of this.clients) {
          if (this.isSubscribed(client, opts.engine.symbol, tf)) {
            client.pending.candles.set(tf, { ...candle, seq });
          }
        }
      }),
      opts.engine.events.on('candle_closed', ({ tf, candle }) => {
        const message: ServerMessage = {
          type: 'candle_closed',
          symbol: opts.engine.symbol,
          tf,
          candle,
          seq: opts.engine.lastSeq,
        };
        for (const client of this.clients) {
          if (this.isSubscribed(client, opts.engine.symbol, tf)) {
            // never throttled, never coalesced
            this.send(client, message);
          }
        }
      }),
    );
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** Sends an account/trade message to every socket of one user. */
  sendToUser(userId: string, message: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const client of set) this.send(client, message);
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    this.unsubscribers.forEach((off) => off());
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ---------------------------------------------------------------- internals

  private isOriginAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // Non-browser clients (CLI, tests, servers) send no Origin header.
    if (!origin) return true;
    try {
      const originHost = new URL(origin).host;
      if (this.opts.config.CORS_ORIGINS.includes('*') || this.opts.config.CORS_ORIGINS.includes(origin)) return true;
      // same-origin (covers reverse proxies / preview domains)
      return originHost === req.headers.host;
    } catch {
      return false;
    }
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    let userId: string | null = null;
    let role: 'user' | 'admin' | null = null;
    const token = url.searchParams.get('token');
    if (token) {
      const payload = this.opts.tokens.verify(token);
      if (payload) {
        userId = payload.sub;
        role = payload.role;
      }
    }

    const client: ClientState = {
      id: this.nextClientId++,
      ws,
      userId,
      role,
      subscriptions: new Set(),
      pending: { candles: new Map() },
      alive: true,
      msgBudget: 30,
      msgWindowStart: Date.now(),
      closed: false,
    };
    this.clients.add(client);
    if (userId) this.registerUser(client);

    this.opts.logger.debug({ clientId: client.id, userId }, 'ws connected');

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data) => this.handleMessage(client, data));
    ws.on('close', () => this.dropClient(client));
    ws.on('error', (err) => {
      this.opts.logger.debug({ err, clientId: client.id }, 'ws error');
      this.dropClient(client);
    });

    this.send(client, {
      type: 'hello',
      serverTime: Date.now(),
      seq: this.opts.engine.lastSeq,
      symbol: this.opts.engine.symbol,
      symbolName: this.opts.config.SYMBOL_NAME,
      timeframes: this.opts.engine.timeframes,
      priceDecimals: this.opts.config.PRICE_DECIMALS,
      authenticated: Boolean(userId),
      userId,
      tickIntervalMs: this.opts.config.TICK_INTERVAL_MS,
      heartbeatMs: this.opts.config.WS_HEARTBEAT_MS,
    });
  }

  private registerUser(client: ClientState): void {
    if (!client.userId) return;
    const set = this.byUser.get(client.userId) ?? new Set<ClientState>();
    set.add(client);
    this.byUser.set(client.userId, set);
  }

  private dropClient(client: ClientState): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    if (client.userId) {
      const set = this.byUser.get(client.userId);
      set?.delete(client);
      if (set && set.size === 0) this.byUser.delete(client.userId);
    }
  }

  private handleMessage(client: ClientState, raw: unknown): void {
    if (this.closing) return;

    // simple per-connection message budget (30 messages/second, burst 30)
    const now = Date.now();
    if (now - client.msgWindowStart > 1000) {
      client.msgWindowStart = now;
      client.msgBudget = 30;
    }
    if (--client.msgBudget < 0) {
      this.send(client, { type: 'error', code: 'RATE_LIMITED', message: 'Too many WebSocket messages' });
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(String(raw));
    } catch {
      this.send(client, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.send(client, {
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    const msg = parsed.data;

    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong', id: msg.id, serverTime: Date.now(), seq: this.opts.engine.lastSeq });
        return;

      case 'subscribe': {
        if (msg.symbol !== this.opts.engine.symbol) {
          this.send(client, {
            type: 'error',
            code: 'SYMBOL_INACTIVE',
            message: `Only "${this.opts.engine.symbol}" is available`,
          });
          return;
        }
        if (!this.opts.engine.timeframes.includes(msg.timeframe)) {
          this.send(client, {
            type: 'error',
            code: 'TIMEFRAME_NOT_SUPPORTED',
            message: `timeframe must be one of ${this.opts.engine.timeframes.join(', ')}`,
          });
          return;
        }
        if (client.subscriptions.size >= this.opts.config.WS_MAX_SUBSCRIPTIONS) {
          this.send(client, { type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS', message: 'Subscription limit reached' });
          return;
        }
        client.subscriptions.add(this.subKey(msg.symbol, msg.timeframe));
        this.send(client, { type: 'subscribed', symbol: msg.symbol, timeframe: msg.timeframe, seq: this.opts.engine.lastSeq });
        return;
      }

      case 'unsubscribe':
        client.subscriptions.delete(this.subKey(msg.symbol, msg.timeframe));
        return;

      case 'auth': {
        const payload = this.opts.tokens.verify(msg.token);
        if (!payload) {
          this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid token' });
          return;
        }
        if (client.userId && client.userId !== payload.sub) {
          const old = this.byUser.get(client.userId);
          old?.delete(client);
          if (old && old.size === 0) this.byUser.delete(client.userId);
        }
        client.userId = payload.sub;
        client.role = payload.role;
        this.registerUser(client);
        this.send(client, {
          type: 'hello',
          serverTime: Date.now(),
          seq: this.opts.engine.lastSeq,
          symbol: this.opts.engine.symbol,
          symbolName: this.opts.config.SYMBOL_NAME,
          timeframes: this.opts.engine.timeframes,
          priceDecimals: this.opts.config.PRICE_DECIMALS,
          authenticated: true,
          userId: client.userId,
          tickIntervalMs: this.opts.config.TICK_INTERVAL_MS,
          heartbeatMs: this.opts.config.WS_HEARTBEAT_MS,
        });
        return;
      }

      case 'resume': {
        const from = msg.lastSeq;
        if (!this.opts.engine.canResumeFrom(from)) {
          this.send(client, { type: 'resync', reason: 'seq_too_old', seq: this.opts.engine.lastSeq });
          return;
        }
        const ticks = this.opts.engine.getTicksSinceSeq(from, 1_000).map((t) => ({
          type: 'tick' as const,
          symbol: t.symbol,
          price: t.price,
          time: t.time,
          seq: t.seq,
        }));
        const candles = [] as Array<{
          type: 'candle';
          symbol: string;
          tf: string;
          t: number;
          o: number;
          h: number;
          l: number;
          c: number;
          seq: number;
        }>;
        for (const tf of this.opts.engine.timeframes) {
          const cur = this.opts.engine.getCurrentCandle(tf);
          if (cur) {
            candles.push({ type: 'candle', symbol: this.opts.engine.symbol, tf, ...cur, seq: this.opts.engine.lastSeq });
          }
        }
        this.send(client, {
          type: 'replay',
          fromSeq: from,
          seq: this.opts.engine.lastSeq,
          ticks,
          candles,
        });
        return;
      }
    }
  }

  private flushPending(): void {
    if (this.closing) return;
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      // back-pressure: skip if kernel/ws buffer is already large
      if (client.ws.bufferedAmount > this.opts.config.WS_MAX_BUFFERED_BYTES) {
        client.pending.tick = undefined;
        client.pending.candles.clear();
        continue;
      }
      const pending = client.pending;
      if (pending.tick) {
        this.send(client, {
          type: 'tick',
          symbol: this.opts.engine.symbol,
          price: pending.tick.price,
          time: pending.tick.time,
          seq: pending.tick.seq,
        });
        pending.tick = undefined;
      }
      if (pending.candles.size > 0) {
        for (const [tf, candle] of pending.candles) {
          this.send(client, { type: 'candle', symbol: this.opts.engine.symbol, tf, ...candle });
        }
        pending.candles.clear();
      }
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.dropClient(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.dropClient(client);
      }
    }
  }

  private isSubscribed(client: ClientState, symbol: string, tf?: string): boolean {
    if (client.subscriptions.size === 0) return false;
    if (tf) return client.subscriptions.has(this.subKey(symbol, tf));
    const prefix = `${symbol}|`;
    for (const s of client.subscriptions) if (s.startsWith(prefix)) return true;
    return false;
  }

  private subKey(symbol: string, tf: string): string {
    return `${symbol}|${tf}`;
  }

  private send(client: ClientState, message: ServerMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(message));
    } catch (err) {
      this.opts.logger.debug({ err, clientId: client.id }, 'ws send failed');
    }
  }
}
