import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { TradeService } from './trades.js';

export interface SettlementLoopOptions {
  trades: TradeService;
  clock: Clock;
  logger: Logger;
  intervalMs: number;
  firstDelayMs?: number;
}

/**
 * Drives expiry settlement. The first pass after boot also completes trades
 * that expired while the server was down. Settlement itself is claim-based, so
 * overlapping passes are harmless.
 */
export class SettlementLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;

  constructor(private readonly opts: SettlementLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.opts.firstDelayMs ?? 1_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.inFlight) await new Promise((r) => setTimeout(r, 20));
  }

  runOnce(): number {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const settled = this.opts.trades.settleDue(this.opts.clock.now());
      if (settled.length) this.opts.logger.info({ count: settled.length }, 'trades settled');
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
    this.timer = setTimeout(() => {
      this.runOnce();
      this.schedule(this.opts.intervalMs);
    }, delay);
    this.timer.unref?.();
  }
}
