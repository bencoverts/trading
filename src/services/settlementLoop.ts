import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { TradeService } from './trades.js';

export interface SettlementLoopOptions {
  trades: TradeService;
  clock: Clock;
  logger: Logger;
  intervalMs: number;
  /** delay before the first pass so the price feed has produced a tick */
  firstDelayMs?: number;
}

/**
 * Drives trade expiry. A single loop in the process settles everything;
 * settlement itself is claim-based so duplicated/overlapping passes are safe.
 * The first pass after boot also completes trades that expired while the
 * server was down.
 */
export class SettlementLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;

  constructor(private readonly opts: SettlementLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.opts.firstDelayMs ?? 200);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inFlight) await new Promise((r) => setTimeout(r, 20));
  }

  /** Runs exactly one settlement pass (used at startup and by tests). */
  async runOnce(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const settled = await this.opts.trades.settleDue(this.opts.clock.now());
      if (settled.length > 0) {
        this.opts.logger.info({ count: settled.length }, 'trades settled');
      }
      return settled.length;
    } catch (err) {
      this.opts.logger.error({ err }, 'settlement pass failed');
      return 0;
    } finally {
      this.inFlight = false;
    }
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.runOnce();
      this.schedule(this.opts.intervalMs);
    }, delay);
    this.timer.unref?.();
  }
}
