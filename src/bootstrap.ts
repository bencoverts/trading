import http from 'node:http';
import type { Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { Database } from './db/sqlite.js';
import { resolveMigrationsDir, runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { createLogger, type Logger } from './lib/logger.js';
import { systemClock, type Clock } from './lib/clock.js';
import { createPasswordHasher } from './auth/passwords.js';
import { createTokenService } from './auth/tokens.js';
import { PriceEngine } from './price/engine.js';
import { SettingsService } from './services/settings.js';
import { UserService } from './services/users.js';
import { WalletService } from './services/wallets.js';
import { MarketService } from './services/markets.js';
import { TradeService } from './services/trades.js';
import { MarketDataService } from './services/marketData.js';
import { SettlementLoop } from './services/settlement.js';
import { DevMailer, MemoryMailer, type Mailer } from './services/mailer.js';
import { PaymentService } from './payments/service.js';
import { createApp } from './http/app.js';
import type { AppContext } from './app/context.js';
import { RealtimeServer } from './ws/server.js';
import { toMajor } from './domain/money.js';

export interface RuntimeOptions {
  config?: Config;
  db?: Database;
  dbPath?: string;
  clock?: Clock;
  logger?: Logger;
  attachRealtime?: boolean;
  startEngine?: boolean;
  runSettlementLoop?: boolean;
  seed?: boolean;
  backfill?: boolean;
  mailer?: Mailer;
  listen?: boolean;
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
 * Assembles the whole app. Everything is injectable so tests can use an
 * in-memory SQLite database, a fake clock and manual ticks (no timers, no I/O).
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const clock = options.clock ?? systemClock;
  const db = options.db ?? new Database(options.dbPath ?? config.SQLITE_PATH);

  runMigrations(db, resolveMigrationsDir());

  const settings = new SettingsService(db, {
    payoutRate: config.PAYOUT_RATE,
    payoutMode: config.PAYOUT_MODE,
  });
  settings.load();

  const hasher = createPasswordHasher({ memoryCost: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_TIME_COST });
  if (options.seed !== false) {
    const seeded = await seedDatabase(db, config, hasher);
    if (seeded.marketsInserted || seeded.adminCreated) logger.info(seeded, 'database seeded');
    settings.load();
  }

  const tokens = createTokenService(config.JWT_SECRET, config.SESSION_TTL_SEC);
  const mailer = options.mailer ?? (config.isTest ? new MemoryMailer() : new DevMailer(logger));

  // markets own the configuration, the engine consumes it - attach after construction
  const markets = new MarketService({ db, now: () => clock.now() });
  const engine = new PriceEngine({
    markets: markets.engineConfigs(),
    now: () => clock.now(),
    jitter: !config.isTest,
  });
  markets.attachEngine(engine);

  const users = new UserService({
    db,
    hasher,
    tokens,
    mailer,
    settings,
    publicUrl: config.APP_PUBLIC_URL,
    cookieName: config.COOKIE_NAME,
    exposeDevTokens: config.EXPOSE_DEV_TOKENS,
    now: () => clock.now(),
  });
  const wallets = new WalletService({ db, settings, now: () => clock.now() });
  const trades = new TradeService({ db, engine, settings, wallets, markets, clock, logger });
  const marketData = new MarketDataService({ db, engine, logger, config, clock });
  const settlement = new SettlementLoop({
    trades,
    clock,
    logger,
    intervalMs: config.isTest ? config.TEST_SETTLE_INTERVAL_MS : config.SETTLE_INTERVAL_MS,
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
    wallets,
    markets,
    trades,
    marketData,
    settlement,
    tokens,
    mailer,
    payments: new PaymentService(),
    realtime: null,
  };

  const app = createApp(ctx);
  const server = http.createServer(app);

  let realtime: RealtimeServer | null = null;
  if (options.attachRealtime !== false) {
    realtime = new RealtimeServer({ server, config, logger, engine, tokens, users });
    ctx.realtime = realtime;

    const walletPayload = (userId: string) => wallets.balances(userId);
    trades.events.on('opened', ({ trade, balanceMinor }) => {
      realtime?.sendToUser(trade.userId, {
        type: 'trade:opened',
        trade: { ...trade, amountDisplay: toMajor(trade.amountMinor, trade.currency) },
      });
      realtime?.sendToUser(trade.userId, { type: 'balance', wallets: walletPayload(trade.userId) });
      void balanceMinor;
    });
    trades.events.on('settled', ({ trade }) => {
      if (!trade.result || trade.closePrice === null) return;
      realtime?.sendToUser(trade.userId, {
        type: 'trade:settled',
        id: trade.id,
        result: trade.result,
        payout: trade.payout ?? 0,
        closePrice: trade.closePrice,
        trade: { ...trade, amountDisplay: toMajor(trade.amountMinor, trade.currency) },
      });
      realtime?.sendToUser(trade.userId, { type: 'balance', wallets: walletPayload(trade.userId) });
    });
  }

  let started = false;
  let listened = false;

  const runtime: Runtime = {
    ctx,
    app,
    server,

    async start() {
      if (started) return;
      started = true;

      if (options.backfill !== false) {
        marketData.bootstrapHistory(markets.rows(true).map((r) => ({
          symbol: r.symbol,
          basePrice: r.base_price,
          tickSize: r.tick_size,
          priceDecimals: r.price_decimals,
        })));
      }
      marketData.seedEngineFromDb();

      if (options.startEngine !== false) engine.start();
      marketData.start();
      if (options.runSettlementLoop !== false) settlement.start();

      if (options.listen) await runtime.listen(options.port, options.host);
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
      const actual = typeof address === 'object' && address ? address.port : port;
      logger.info(
        {
          port: actual,
          host,
          ws: `/ws`,
          db: db.driver,
          env: config.NODE_ENV,
          markets: engine.symbols,
          simulation: true,
        },
        'http server listening',
      );
      return actual;
    },

    async stop() {
      await settlement.stop();
      await marketData.stop();
      engine.stop();
      if (realtime) {
        await realtime.close();
        realtime = null;
        ctx.realtime = null;
      }
      if (listened) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        listened = false;
      }
      db.close();
      started = false;
    },
  };

  return runtime;
}
