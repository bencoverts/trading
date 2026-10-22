import http from 'node:http';
import type { Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { createDb, dbConfigFromConfig, type Db } from './db/index.js';
import { resolveMigrationsDir, runMigrations } from './db/migrate.js';
import { createLogger, type Logger } from './lib/logger.js';
import { systemClock, type Clock } from './lib/clock.js';
import { createPasswordHasher } from './auth/passwords.js';
import { createTokenService } from './auth/tokens.js';
import { PriceEngine } from './price/engine.js';
import { SimulatedPriceFeed } from './price/simulated.js';
import { generateBackfill } from './price/backfill.js';
import type { PriceSource } from './price/types.js';
import { SettingsService } from './services/settings.js';
import { UserService } from './services/users.js';
import { TradeService } from './services/trades.js';
import { CandleRecorder } from './services/candleRecorder.js';
import { SettlementLoop } from './services/settlementLoop.js';
import { createApp } from './http/app.js';
import type { AppContext } from './app/context.js';
import { RealtimeServer } from './ws/server.js';

export interface RuntimeOptions {
  config?: Config;
  db?: Db;
  clock?: Clock;
  logger?: Logger;
  priceSource?: PriceSource;
  /** start producing ticks (default true) */
  startEngine?: boolean;
  /** open the /ws endpoint (default true) */
  attachRealtime?: boolean;
  /** bind a TCP port (default false - tests use supertest) */
  listen?: boolean;
  /** synthesise chart history when the database has no candles (default true) */
  backfill?: boolean;
  /** start the periodic settlement loop (default true) */
  runSettlementLoop?: boolean;
  port?: number;
  host?: string;
}

export interface Runtime {
  ctx: AppContext;
  app: Express;
  server: http.Server;
  start(): Promise<void>;
  stop(): Promise<void>;
  listen(port?: number, host?: string): Promise<number>;
}

/**
 * Assembles the process: database + migrations, price engine, services,
 * HTTP app, WebSocket fan-out and lifecycle.
 *
 * Everything is injectable so integration tests can use an in-memory SQLite
 * database, a fake clock and manual ticks with no timers or sockets.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const clock = options.clock ?? systemClock;
  const db = options.db ?? createDb(dbConfigFromConfig(config));

  // 1. schema
  const migrationsDir = await resolveMigrationsDir(db.driver);
  const applied = await runMigrations(db, migrationsDir);
  if (applied.length > 0) logger.info({ applied }, 'migrations applied');

  // 2. runtime business settings (persisted overrides on top of env defaults)
  const settings = new SettingsService(db, SettingsService.defaultsFromConfig(config));
  await settings.load();

  // 3. price source is replaceable through the adapter interface
  const feed: PriceSource =
    options.priceSource ??
    new SimulatedPriceFeed({
      initialPrice: config.INITIAL_PRICE,
      tickSize: config.TICK_SIZE,
      volatility: settings.get().volatility,
      mood: settings.get().mood,
      autoMood: config.FEED_MOOD_AUTO,
    });
  const engine = new PriceEngine({
    symbol: config.SYMBOL,
    source: feed,
    timeframes: config.TIMEFRAMES,
    decimals: config.PRICE_DECIMALS,
    intervalMs: config.TICK_INTERVAL_MS,
    jitter: config.TICK_JITTER,
    bufferSize: config.TICK_BUFFER_SIZE,
  });

  const recorder = new CandleRecorder({ db, engine, logger, config });

  // 4. services
  const hasher = createPasswordHasher({ memoryCost: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_TIME_COST });
  const tokens = createTokenService(config.JWT_SECRET, config.JWT_TTL_SEC);
  const users = new UserService({ db, config, hasher });
  const trades = new TradeService({ db, config, clock, price: engine, settings, logger });

  const settlement = new SettlementLoop({
    trades,
    clock,
    logger,
    intervalMs: config.NODE_ENV === 'test' ? config.TEST_SETTLE_INTERVAL_MS : 250,
    firstDelayMs: 1_000,
  });

  const ctx: AppContext = {
    config,
    db,
    logger,
    clock,
    engine,
    settings,
    users,
    trades,
    tokens,
    recorder,
    settlement,
    realtime: null,
  };

  const app = createApp(ctx);
  const server = http.createServer(app);

  let realtime: RealtimeServer | null = null;
  if (options.attachRealtime !== false) {
    realtime = new RealtimeServer({ server, config, logger, engine, tokens });
    ctx.realtime = realtime;

    trades.events.on('opened', ({ trade, balanceCents }) => {
      realtime?.sendToUser(trade.userId, { type: 'trade:opened', trade: { ...trade } });
      realtime?.sendToUser(trade.userId, {
        type: 'balance',
        amount: balanceCents / 100,
        amountCents: balanceCents,
        currency: config.CURRENCY,
      });
    });
    trades.events.on('settled', ({ trade, balanceCents }) => {
      if (!trade.result || trade.closePrice === null) return;
      realtime?.sendToUser(trade.userId, {
        type: 'trade:settled',
        id: trade.id,
        result: trade.result,
        payout: trade.payout ?? 0,
        closePrice: trade.closePrice,
        trade: { ...trade },
      });
      realtime?.sendToUser(trade.userId, {
        type: 'balance',
        amount: balanceCents / 100,
        amountCents: balanceCents,
        currency: config.CURRENCY,
      });
    });
  }

  const housekeeping = setInterval(() => {
    void recorder
      .prune(clock.now())
      .then((r) => {
        if (r.candles > 0) logger.debug(r, 'retention prune');
      })
      .catch((err) => logger.warn({ err }, 'retention prune failed'));
  }, config.HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref?.();

  let started = false;
  let listened = false;

  const runtime: Runtime = {
    ctx,
    app,
    server,
    async start() {
      if (started) return;
      started = true;

      // 5. chart history: restore from DB, or synthesise on a fresh database
      const hasHistory = await recorder.hasAnyCandles();
      let resumePrice: number | null = null;
      if (hasHistory) {
        const history = await recorder.loadHistory();
        const last5s = history['5s']?.[history['5s'].length - 1];
        resumePrice = last5s ? last5s.c : null;
      } else if (options.backfill !== false) {
        const backfill = generateBackfill({
          symbol: config.SYMBOL,
          timeframes: config.TIMEFRAMES,
          minutes: 240,
          stepMs: 1_000,
          endPrice: config.INITIAL_PRICE,
          tickSize: config.TICK_SIZE,
          now: () => clock.now(),
        });
        for (const [tf, candles] of Object.entries(backfill.byTimeframe)) {
          await recorder.saveCandles(tf, candles);
          engine.seedHistory(tf, candles);
        }
        logger.info(
          { candles: Object.fromEntries(Object.entries(backfill.byTimeframe).map(([k, v]) => [k, v.length])) },
          'chart history backfilled',
        );
      } else {
        await recorder.loadHistory();
      }

      // continue the simulated price from where it stopped (no jump on restart)
      if (resumePrice !== null && typeof feed.setPrice === 'function') {
        feed.setPrice(resumePrice);
        logger.info({ resumePrice }, 'price source resumed from last close');
      }

      if (options.startEngine !== false) await engine.start();
      recorder.start();
      if (options.runSettlementLoop !== false) settlement.start();
      await ensureAdmin(users, config, logger);

      if (options.listen) {
        await runtime.listen(options.port, options.host);
      }
    },

    async listen(port = config.PORT, host = config.HOST) {
      if (listened) return port;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      listened = true;
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      logger.info(
        {
          port: actualPort,
          host,
          ws: `ws://${host}:${actualPort}/ws`,
          allowlist: config.CORS_ORIGINS,
          db: db.driver,
          env: config.NODE_ENV,
        },
        'http server listening',
      );
      return actualPort;
    },

    async stop() {
      clearInterval(housekeeping);
      await settlement.stop();
      await recorder.stop();
      await engine.stop();
      if (realtime) {
        await realtime.close();
        realtime = null;
        ctx.realtime = null;
      }
      if (listened) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        listened = false;
      }
      await db.close();
      started = false;
    },
  };

  return runtime;
}

/** Optional admin bootstrap from ADMIN_EMAIL / ADMIN_PASSWORD (never hardcoded). */
export async function ensureAdmin(users: UserService, config: Config, logger: Logger): Promise<void> {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  const normalized = config.ADMIN_EMAIL.toLowerCase();
  const existing = await users.findByEmail(normalized);
  if (existing) {
    if (existing.role !== 'admin') {
      await users.promoteToAdmin(existing.id);
      logger.info({ email: normalized }, 'existing user promoted to admin');
    }
    return;
  }
  const created = await users.register({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD });
  await users.promoteToAdmin(created.id);
  logger.info({ email: normalized }, 'admin user created from environment');
}

