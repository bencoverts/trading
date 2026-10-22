import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../lib/logger.js';
import type { PriceEngine } from '../price/engine.js';
import type { TokenService } from '../auth/tokens.js';
import type { UserService } from '../services/users.js';
import type { AccountService } from '../auth/accounts.js';
import type { MarketService } from '../services/markets.js';
import { parseTradingHours, isMarketOpen } from '../domain/marketSchedule.js';
import { clientMessageSchema, type ServerMessage } from './protocol.js';
import { TIMEFRAME_LIST } from '../domain/constants.js';

interface ClientState {
  id: number;
  ws: WebSocket;
  userId: string | null;
  role: 'user' | 'admin' | null;
  subscriptions: Set<string>;
  /** market-level subscriptions (any timeframe) - ticks are per market */
  markets: Set<string>;
  pendingTicks: Map<string, { price: number; time: number; seq: number }>;
  pendingCandles: Map<string, { tf: string; t: number; o: number; h: number; l: number; c: number; seq: number }>;
  alive: boolean;
  budget: number;
  budgetWindow: number;
  closed: boolean;
}

export interface RealtimeServerOptions {
  server: HttpServer;
  config: Config;
  logger: Logger;
  engine: PriceEngine;
  tokens: TokenService;
  users: UserService;
  accounts: AccountService;
  markets: MarketService;
  path?: string;
}

/**
 * WebSocket fan-out.
 * - ticks/candles are coalesced per client and flushed at WS_TICK_MAX_PER_SEC
 * - candle_closed is sent immediately (never throttled, never dropped)
 * - protocol ping/pong heartbeat
 * - per-market sequence numbers with replay/resync on reconnect
 */
export class RealtimeServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly byUser = new Map<string, Set<ClientState>>();
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribers: Array<() => void> = [];
  private nextId = 1;
  private closing = false;
  private droppedConnections = 0;

  constructor(private readonly opts: RealtimeServerOptions) {
    this.wss = new WebSocketServer({
      server: opts.server,
      path: opts.path ?? '/ws',
      maxPayload: 8 * 1024,
      perMessageDeflate: false,
      verifyClient: (info, done) => {
        if (this.clients.size >= opts.config.WS_MAX_CONNECTIONS) return done(false, 503, 'Too many connections');
        done(this.originAllowed(info.req));
      },
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    const flushMs = Math.max(50, Math.floor(1000 / opts.config.WS_TICK_MAX_PER_SEC));
    this.flushTimer = setInterval(() => this.flush(), flushMs);
    this.flushTimer.unref?.();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.config.WS_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();

    this.unsubscribers.push(
      opts.engine.events.on('tick', (tick) => {
        for (const client of this.clients) {
          if (client.markets.has(tick.market)) {
            client.pendingTicks.set(tick.market, { price: tick.price, time: tick.time, seq: tick.seq });
          }
        }
      }),
      opts.engine.events.on('candle', ({ market, tf, candle, seq }) => {
        for (const client of this.clients) {
          if (client.subscriptions.has(this.key(market, tf))) {
            client.pendingCandles.set(`${market}|${tf}`, { tf, ...candle, seq });
          }
        }
      }),
      opts.engine.events.on('candle_closed', ({ market, tf, candle, seq }) => {
        const message: ServerMessage = { type: 'candle_closed', market, symbol: market, tf, candle, seq };
        for (const client of this.clients) {
          if (client.subscriptions.has(this.key(market, tf))) this.send(client, message);
        }
      }),
    );
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** Connections lost in the last 10 minutes (used by the admin alerts). */
  get recentDrops(): number {
    return this.droppedConnections;
  }

  /** Broadcast a market status change to every subscribed client. */
  broadcastMarketStatus(symbol: string): void {
    const row = this.opts.markets.row(symbol);
    if (!row) return;
    const state = isMarketOpen(parseTradingHours(row.trading_hours), Date.now());
    const status =
      row.deleted_at || row.active !== 1 ? 'inactive' : row.paused === 1 ? 'paused' : state.open ? 'active' : 'closed';
    const message: ServerMessage = {
      type: 'market_status',
      market: row.symbol,
      status,
      paused: row.paused === 1,
      open: state.open,
      reason: state.open ? null : (state.reason ?? null),
      serverTime: Date.now(),
    };
    for (const client of this.clients) {
      if (client.markets.has(row.symbol) || client.subscriptions.size === 0) this.send(client, message);
    }
  }

  sendToAll(message: ServerMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  /** Staff-only channel for new chat messages and finance alerts. */
  sendToStaff(message: ServerMessage): void {
    for (const client of this.clients) if (client.role === 'admin') this.send(client, message);
  }

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

  // ------------------------------------------------------------------ internal

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients
    if (this.opts.config.CORS_ORIGINS.includes('*') || this.opts.config.CORS_ORIGINS.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    let userId: string | null = null;
    let role: 'user' | 'admin' | null = null;
    const token = url.searchParams.get('token');
    if (token) {
      const payload = this.opts.tokens.verify(token);
      const user = payload ? this.opts.users.findById(payload.sub) : undefined;
      const session = payload ? this.opts.accounts.active(payload.sid) : undefined;
      if (payload && user && user.token_version === payload.v && !user.blocked_at && session) {
        userId = user.id;
        role = user.role;
      }
    }

    const client: ClientState = {
      id: this.nextId++,
      ws,
      userId,
      role,
      subscriptions: new Set(),
      markets: new Set(),
      pendingTicks: new Map(),
      pendingCandles: new Map(),
      alive: true,
      budget: 30,
      budgetWindow: Date.now(),
      closed: false,
    };
    this.clients.add(client);
    if (userId) this.addToUser(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data) => this.onMessage(client, data));
    ws.on('close', () => this.drop(client));
    ws.on('error', () => this.drop(client));

    this.send(client, {
      type: 'hello',
      serverTime: Date.now(),
      simulation: true,
      label: 'SIMULASI',
      markets: this.opts.engine.listConfigs().map((m) => {
        const row = this.opts.markets.row(m.symbol);
        const open = row ? isMarketOpen(parseTradingHours(row.trading_hours), Date.now()).open : true;
        return {
          symbol: m.symbol,
          name: m.name,
          lastSeq: this.opts.engine.lastSeq(m.symbol),
          paused: m.paused,
          open,
          priceDecimals: m.priceDecimals,
          status: row
            ? row.paused === 1
              ? 'paused'
              : row.active !== 1
                ? 'inactive'
                : open
                  ? 'active'
                  : 'closed'
            : 'unknown',
        };
      }),
      timeframes: TIMEFRAME_LIST,
      authenticated: Boolean(userId),
      userId,
      tickMaxPerSec: this.opts.config.WS_TICK_MAX_PER_SEC,
      heartbeatMs: this.opts.config.WS_HEARTBEAT_MS,
    });
  }

  private addToUser(client: ClientState): void {
    if (!client.userId) return;
    const set = this.byUser.get(client.userId) ?? new Set<ClientState>();
    set.add(client);
    this.byUser.set(client.userId, set);
  }

  private drop(client: ClientState): void {
    if (client.closed) return;
    client.closed = true;
    if (!this.closing) this.droppedConnections += 1;
    this.clients.delete(client);
    if (client.userId) {
      const set = this.byUser.get(client.userId);
      set?.delete(client);
      if (set && set.size === 0) this.byUser.delete(client.userId);
    }
  }

  private onMessage(client: ClientState, raw: unknown): void {
    if (this.closing) return;

    const now = Date.now();
    if (now - client.budgetWindow > 1000) {
      client.budgetWindow = now;
      client.budget = 30;
    }
    if (--client.budget < 0) {
      this.send(client, { type: 'error', code: 'RATE_LIMITED', message: 'Too many WebSocket messages' });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return this.send(client, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON' });
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      return this.send(client, {
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const msg = parsed.data;

    switch (msg.type) {
      case 'ping':
        return this.send(client, { type: 'pong', id: msg.id, serverTime: Date.now() });

      case 'subscribe': {
        const requested = msg.symbol ?? msg.market ?? '';
        const market = requested.toUpperCase();
        if (!this.opts.engine.has(market)) {
          return this.send(client, { type: 'error', code: 'MARKET_NOT_FOUND', message: `Unknown market: ${market}` });
        }
        if (!TIMEFRAME_LIST.includes(msg.timeframe as never)) {
          return this.send(client, {
            type: 'error',
            code: 'TIMEFRAME_NOT_SUPPORTED',
            message: `timeframe must be one of ${TIMEFRAME_LIST.join(', ')}`,
          });
        }
        if (client.subscriptions.size >= this.opts.config.WS_MAX_SUBSCRIPTIONS) {
          return this.send(client, {
            type: 'error',
            code: 'TOO_MANY_SUBSCRIPTIONS',
            message: 'Subscription limit reached',
          });
        }
        client.subscriptions.add(this.key(market, msg.timeframe));
        client.markets.add(market);
        this.send(client, {
          type: 'subscribed',
          market,
          symbol: market,
          timeframe: msg.timeframe,
          snapshot: {
            lastPrice: this.opts.engine.lastPrice(market),
            candle: this.opts.engine.currentCandle(market, msg.timeframe) ?? null,
          },
        });
        return;
      }

      case 'unsubscribe': {
        const market = (msg.symbol ?? msg.market ?? '').toUpperCase();
        if (!msg.timeframe) {
          for (const key of [...client.subscriptions]) {
            if (key.startsWith(`${market}|`)) client.subscriptions.delete(key);
          }
          client.markets.delete(market);
          return;
        }
        client.subscriptions.delete(this.key(market, msg.timeframe));
        if (![...client.subscriptions].some((k) => k.startsWith(`${market}|`))) client.markets.delete(market);
        return;
      }

      case 'auth': {
        const payload = this.opts.tokens.verify(msg.token);
        const user = payload ? this.opts.users.findById(payload.sub) : undefined;
        const session = payload ? this.opts.accounts.active(payload.sid) : undefined;
        if (!payload || !user || user.token_version !== payload.v || user.blocked_at || !session) {
          return this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid session' });
        }
        if (client.userId) this.byUser.get(client.userId)?.delete(client);
        client.userId = user.id;
        client.role = user.role;
        this.addToUser(client);
        this.send(client, {
          type: 'hello',
          serverTime: Date.now(),
          simulation: true,
          label: 'SIMULASI',
          markets: this.opts.engine.listConfigs().map((m) => ({
            symbol: m.symbol,
            name: m.name,
            lastSeq: this.opts.engine.lastSeq(m.symbol),
            paused: m.paused,
            open: true,
            priceDecimals: m.priceDecimals,
            status: m.paused ? 'paused' : 'active',
          })),
          timeframes: TIMEFRAME_LIST,
          authenticated: true,
          userId: client.userId,
          tickMaxPerSec: this.opts.config.WS_TICK_MAX_PER_SEC,
          heartbeatMs: this.opts.config.WS_HEARTBEAT_MS,
        });
        return;
      }

      case 'resume': {
        const market = (msg.symbol ?? msg.market ?? '').toUpperCase();
        if (!this.opts.engine.has(market)) {
          return this.send(client, { type: 'error', code: 'MARKET_NOT_FOUND', message: `Unknown market: ${market}` });
        }
        if (!this.opts.engine.canResume(market, msg.lastSeq)) {
          return this.send(client, {
            type: 'resync',
            market,
            symbol: market,
            reason: 'seq_too_old',
            seq: this.opts.engine.lastSeq(market),
          });
        }
        this.send(client, {
          type: 'replay',
          market,
          symbol: market,
          fromSeq: msg.lastSeq,
          seq: this.opts.engine.lastSeq(market),
          ticks: this.opts.engine.ticksSince(market, msg.lastSeq, 1_000).map((t) => ({
            price: t.price,
            time: t.time,
            seq: t.seq,
          })),
          candles: TIMEFRAME_LIST.flatMap((tf) => {
            const c = this.opts.engine.currentCandle(market, tf);
            return c ? [{ tf, ...c }] : [];
          }),
        });
        return;
      }
    }
  }

  private flush(): void {
    if (this.closing) return;
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      for (const [market, tick] of client.pendingTicks) {
        this.send(client, { type: 'tick', market, symbol: market, price: tick.price, time: tick.time, seq: tick.seq });
      }
      client.pendingTicks.clear();
      for (const [key, candle] of client.pendingCandles) {
        const market = key.split('|')[0];
        this.send(client, {
          type: 'candle',
          market,
          symbol: market,
          tf: candle.tf,
          t: candle.t,
          o: candle.o,
          h: candle.h,
          l: candle.l,
          c: candle.c,
          seq: candle.seq,
        });
      }
      client.pendingCandles.clear();
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.drop(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.drop(client);
      }
    }
  }

  private key(market: string, tf?: string): string {
    return tf ? `${market}|${tf}` : market;
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
