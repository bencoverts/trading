import type { Config } from '../config.js';
import type { Database } from '../db/sqlite.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { PriceEngine } from '../price/engine.js';
import type { TokenService } from '../auth/tokens.js';
import type { Mailer } from '../services/mailer.js';
import type { SettingsService } from '../services/settings.js';
import type { UserService } from '../services/users.js';
import type { WalletService } from '../services/wallets.js';
import type { MarketService } from '../services/markets.js';
import type { TradeService } from '../services/trades.js';
import type { MarketDataService } from '../services/marketData.js';
import type { SettlementLoop } from '../services/settlement.js';
import type { RealtimeServer } from '../ws/server.js';
import type { PaymentService } from '../payments/service.js';

export interface AppContext {
  config: Config;
  db: Database;
  logger: Logger;
  clock: Clock;
  engine: PriceEngine;
  settings: SettingsService;
  users: UserService;
  wallets: WalletService;
  markets: MarketService;
  trades: TradeService;
  marketData: MarketDataService;
  settlement: SettlementLoop;
  tokens: TokenService;
  mailer: Mailer;
  payments: PaymentService;
  /** null in tests that do not attach a socket server */
  realtime: RealtimeServer | null;
}
