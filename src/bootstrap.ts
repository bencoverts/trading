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
import { AccountService } from './auth/accounts.js';
import { PriceEngine } from './price/engine.js';
import { SettingsService } from './services/settings.js';
import { UserService } from './services/users.js';
import { WalletService } from './services/wallets.js';
import { LedgerService } from './services/ledger.js';
import { MarketService } from './services/markets.js';
import { TradeService } from './services/trades.js';
import { MarketDataService } from './services/marketData.js';
import { SettlementLoop } from './services/settlement.js';
import { NotificationService } from './services/notifications.js';
import { ContentService } from './services/content.js';
import { UploadService } from './services/uploads.js';
import { StatsService } from './services/stats.js';
import { DevMailer, MemoryMailer, type Mailer } from './services/mailer.js';
import { PaymentService } from './payments/service.js';
import { KlikQrisClient } from './payments/klikqris.js';
import { CurrencyService } from './services/currencies.js';
import { DepositService } from './services/deposits.js';
import { WithdrawalService } from './services/withdrawals.js';
import { ChatService } from './services/chat.js';
import { SiteService } from './services/site.js';
import { createApp } from './http/app.js';
import type { AppContext } from './app/context.js';
import { RealtimeServer } from './ws/server.js';
import { toMajor } from './domain/money.js';
import { createBackupService, registerJobs } from './jobs/index.js';

export interface RuntimeOptions {
  config?: Config;
  db?: Database;
  dbPath?: string;
  clock?: Clock;
  logger?: Logger;
  attachRealtime?: boolean;
  startEngine?: boolean;
  runSettlementLoop?: boolean;
  startJobs?: boolean;
  seed?: boolean;
  demoData?: boolean;
  backfill?: boolean;
  mailer?: Mailer;
  /** injectable KlikQRIS transport (tests never touch the network) */
  paymentTransport?: import('./payments/klikqris.js').KlikQrisTransport;
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
 * Assembles the whole app. Everything is injectable so tests can use a
 * temporary SQLite file, a fake clock and manual ticks (no timers, no I/O).
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
    tickRetentionDays: config.TICK_RETENTION_DAYS,
    candleRetentionDays: config.CANDLE_RETENTION_DAYS,
  });
  settings.load();

  const hasher = createPasswordHasher({ memoryCost: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_TIME_COST });
  if (options.seed !== false) {
    const seeded = await seedDatabase(db, config, hasher, settings, {
      demoData: options.demoData ?? !config.isProd,
    });
    if (seeded.marketsInserted || seeded.adminCreated || seeded.demoTrades) logger.info(seeded, 'database seeded');
    settings.load();
  }

  const tokens = createTokenService(config.JWT_SECRET, config.SESSION_TTL_SEC);
  const mailer = options.mailer ?? (config.isTest ? new MemoryMailer() : new DevMailer(logger));

  // markets own the configuration, the engine consumes it - wire them together
  const markets = new MarketService({ db, now: () => clock.now() });
  const engine = new PriceEngine({
    markets: markets.engineConfigs(),
    now: () => clock.now(),
    jitter: !config.isTest,
  });
  markets.attachEngine(engine);

  const accounts = new AccountService({ db, now: () => clock.now() });
  const users = new UserService({
    db,
    hasher,
    mailer,
    settings,
    publicUrl: config.APP_PUBLIC_URL,
    exposeDevTokens: config.EXPOSE_DEV_TOKENS,
    now: () => clock.now(),
    loginMaxAttempts: config.LOGIN_MAX_ATTEMPTS,
    loginLockMs: config.LOGIN_LOCK_MIN_MS,
  });
  const ledger = new LedgerService(db);
  const wallets = new WalletService({ db, settings, ledger, now: () => clock.now() });
  const currencies = new CurrencyService(db, () => clock.now());
  const site = new SiteService(db, () => clock.now());
  const kliqris = new KlikQrisClient(
    {
      baseUrl: config.KLIKQRIS_BASE_URL,
      apiKey: config.KLIKQRIS_API_KEY,
      merchantId: config.KLIKQRIS_MERCHANT_ID,
      callbackUrl: config.KLIKQRIS_CALLBACK_URL,
      webhookSecret: config.KLIKQRIS_WEBHOOK_SECRET,
      signatureHeader: config.KLIKQRIS_SIGNATURE_HEADER,
      timeoutMs: config.KLIKQRIS_TIMEOUT_MS,
      logger,
    },
    options.paymentTransport,
  );
  const trades = new TradeService({ db, engine, settings, wallets, markets, clock, logger });
  const marketData = new MarketDataService({ db, engine, logger, config, clock });
  const settlement = new SettlementLoop({
    trades,
    clock,
    logger,
    intervalMs: config.isTest ? config.TEST_SETTLE_INTERVAL_MS : config.SETTLE_INTERVAL_MS,
    firstDelayMs: 1_000,
  });
  const notifications = new NotificationService(db, () => clock.now());
  let realtime: RealtimeServer | null = null;
  const pushToUser = (userId: string, message: Record<string, unknown>) =>
    realtime?.sendToUser(userId, message as never);
  const pushToStaff = (message: Record<string, unknown>) => realtime?.sendToStaff(message as never);
  const deposits = new DepositService({
    db,
    currencies,
    wallets,
    notifications,
    client: kliqris,
    now: () => clock.now(),
    push: pushToUser,
  });
  const withdrawals = new WithdrawalService({
    db,
    currencies,
    wallets,
    notifications,
    now: () => clock.now(),
    push: pushToUser,
  });
  const chat = new ChatService({ db, notifications, now: () => clock.now(), push: pushToUser, pushStaff: pushToStaff });
  const content = new ContentService(db, () => clock.now());
  const uploads = new UploadService(config.UPLOADS_DIR, config.MAX_UPLOAD_BYTES, logger);
  const stats = new StatsService(db, () => clock.now());
  const backups = createBackupService({
    db,
    logger,
    settings,
    trades,
    marketData,
    engine,
    backupDir: config.BACKUP_DIR,
    dbPath: db.path,
    now: () => clock.now(),
    settleIntervalMs: config.SETTLE_INTERVAL_MS,
  });
  const jobs = registerJobs(
    {
      db,
      logger,
      settings,
      trades,
      marketData,
      engine,
      backupDir: config.BACKUP_DIR,
      dbPath: db.path,
      now: () => clock.now(),
      settleIntervalMs: config.isTest ? config.TEST_SETTLE_INTERVAL_MS : config.SETTLE_INTERVAL_MS,
    },
    backups,
  );

  const ctx: AppContext = {
    config,
    db,
    logger,
    clock,
    engine,
    settings,
    users,
    accounts,
    wallets,
    ledger,
    markets,
    trades,
    marketData,
    settlement,
    notifications,
    content,
    uploads,
    stats,
    jobs,
    backups,
    tokens,
    mailer,
    payments: new PaymentService(kliqris, {
      depositsEnabled: config.PAYMENTS_ENABLED && site.isEnabled('deposits'),
      withdrawalsEnabled: config.PAYMENTS_ENABLED && site.isEnabled('withdrawals'),
    }),
    currencies,
    deposits,
    withdrawals,
    chat,
    site,
    realtime: null,
  };
  markets.setHistoryBootstrap((symbol) => {
    const row = markets.row(symbol);
    if (!row) return;
    marketData.bootstrapHistory(
      [{ symbol: row.symbol, basePrice: row.base_price, tickSize: row.tick_size, priceDecimals: row.price_decimals }],
      { hours: 24, force: true },
    );
    marketData.seedEngineFromDb();
  });

  const app = createApp(ctx);
  const server = http.createServer(app);

  if (options.attachRealtime !== false) {
    realtime = new RealtimeServer({ server, config, logger, engine, tokens, users, accounts, markets });
    ctx.realtime = realtime;
  }

  // Domain side effects (notifications, realtime pushes) are wired even when no
  // socket server is attached so tests and CLI jobs observe the same behaviour.
  trades.events.on('opened', ({ trade }) => {
    ctx.realtime?.sendToUser(trade.userId, {
      type: 'trade:opened',
      trade: { ...trade, amountDisplay: toMajor(trade.amountMinor, trade.currency) },
    });
    ctx.realtime?.sendToUser(trade.userId, { type: 'balance', wallets: wallets.balances(trade.userId) });
  });
  trades.events.on('settled', ({ trade }) => {
    if (!trade.result || trade.closePrice === null) return;
    ctx.realtime?.sendToUser(trade.userId, {
      type: 'trade:settled',
      id: trade.id,
      result: trade.result,
      payout: trade.payout ?? 0,
      closePrice: trade.closePrice,
      trade: { ...trade, amountDisplay: toMajor(trade.amountMinor, trade.currency) },
    });
    ctx.realtime?.sendToUser(trade.userId, { type: 'balance', wallets: wallets.balances(trade.userId) });
    notifications.create({
      userId: trade.userId,
      kind: `trade_${trade.result}`,
      title:
        trade.result === 'win'
          ? `Trade ${trade.market} menang 🎉`
          : trade.result === 'lose'
            ? `Trade ${trade.market} kalah`
            : `Trade ${trade.market} seri`,
      body:
        trade.result === 'win'
          ? `Payout ${trade.payout} ${trade.currency} masuk ke dompet demo kamu.`
          : trade.result === 'lose'
            ? `Nominal ${trade.amount} ${trade.currency} hangus (simulasi).`
            : `Nominal ${trade.amount} ${trade.currency} dikembalikan penuh.`,
      link: '/history',
    });
  });

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
        marketData.bootstrapHistory(
          markets.rows({ includeInactive: false }).map((row) => ({
            symbol: row.symbol,
            basePrice: row.base_price,
            tickSize: row.tick_size,
            priceDecimals: row.price_decimals,
          })),
        );
      }
      marketData.seedEngineFromDb();

      if (options.startEngine !== false) engine.start();
      marketData.start();
      if (options.runSettlementLoop !== false) settlement.start();
      if (options.startJobs !== false) jobs.start();

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
          ws: '/ws',
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
      await jobs.stop();
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
