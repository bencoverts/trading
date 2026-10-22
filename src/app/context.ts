import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { PriceEngine } from '../price/engine.js';
import type { TokenService } from '../auth/tokens.js';
import type { UserService } from '../services/users.js';
import type { TradeService } from '../services/trades.js';
import type { SettingsService } from '../services/settings.js';
import type { CandleRecorder } from '../services/candleRecorder.js';
import type { SettlementLoop } from '../services/settlementLoop.js';
import type { RealtimeServer } from '../ws/server.js';

export interface AppContext {
  config: Config;
  db: Db;
  logger: Logger;
  clock: Clock;
  engine: PriceEngine;
  settings: SettingsService;
  users: UserService;
  trades: TradeService;
  tokens: TokenService;
  recorder: CandleRecorder;
  settlement: SettlementLoop;
  /** null in unit/integration tests that do not open a socket */
  realtime: RealtimeServer | null;
}
