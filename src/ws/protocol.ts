import { z } from 'zod';

/**
 * WebSocket contract (v3).
 * Client: subscribe / unsubscribe / ping / auth / resume.
 * Server: hello, subscribed, tick, candle, candle_closed, market_status,
 *         trade:opened, trade:settled, balance, notification, replay, resync,
 *         pong, error.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.union([z.string(), z.number()]).optional() }),
  z.object({
    type: z.literal('subscribe'),
    /** v3 name */
    symbol: z.string().min(1).max(32).optional(),
    /** v2 name, kept for compatibility with older clients */
    market: z.string().min(1).max(32).optional(),
    timeframe: z.string().min(1).max(8),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    symbol: z.string().min(1).max(32).optional(),
    market: z.string().min(1).max(32).optional(),
    timeframe: z.string().min(1).max(8).optional(),
  }),
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({
    type: z.literal('resume'),
    symbol: z.string().min(1).max(32).optional(),
    market: z.string().min(1).max(32).optional(),
    lastSeq: z.number().int().nonnegative(),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface MarketStatusMessage {
  type: 'market_status';
  market: string;
  status: 'active' | 'paused' | 'inactive' | 'closed';
  paused: boolean;
  open: boolean;
  reason: string | null;
  serverTime: number;
}

export interface TradeViewWire {
  [key: string]: unknown;
}

export type ServerMessage =
  | {
      type: 'hello';
      serverTime: number;
      simulation: true;
      label: 'SIMULASI';
      markets: Array<{
        symbol: string;
        name: string;
        lastSeq: number;
        paused: boolean;
        open: boolean;
        priceDecimals: number;
        status: string;
      }>;
      timeframes: string[];
      authenticated: boolean;
      userId: string | null;
      tickMaxPerSec: number;
      heartbeatMs: number;
    }
  | {
      type: 'subscribed';
      market: string;
      symbol: string;
      timeframe: string;
      snapshot: { lastPrice: number | null; candle: unknown };
    }
  | { type: 'tick'; market: string; symbol: string; price: number; time: number; seq: number }
  | {
      type: 'candle';
      market: string;
      symbol: string;
      tf: string;
      t: number;
      o: number;
      h: number;
      l: number;
      c: number;
      seq: number;
    }
  | {
      type: 'candle_closed';
      market: string;
      symbol: string;
      tf: string;
      candle: { t: number; o: number; h: number; l: number; c: number };
      seq: number;
    }
  | MarketStatusMessage
  | { type: 'trade:opened'; trade: TradeViewWire }
  | {
      type: 'trade:settled';
      id: string;
      result: 'win' | 'lose' | 'draw';
      payout: number;
      closePrice: number;
      trade: TradeViewWire;
    }
  | {
      type: 'balance';
      wallets: Array<{
        currency: string;
        balance: number;
        balanceMinor: number;
        locked?: number;
        lockedMinor?: number;
        available?: number;
        availableMinor?: number;
      }>;
    }
  | { type: 'account:reset'; wallets: Array<{ currency: string; balance: number; balanceMinor: number }> }
  | {
      type: 'notification';
      notification: {
        id: string;
        kind: string;
        title: string;
        body: string | null;
        link: string | null;
        createdAt: number;
      };
    }
  | { type: 'deposit:updated'; deposit: Record<string, unknown> }
  | { type: 'withdrawal:updated'; withdrawal: Record<string, unknown> }
  | { type: 'chat:message'; message: Record<string, unknown>; conversation: Record<string, unknown> }
  | { type: 'chat:new'; conversation: Record<string, unknown> }
  | { type: 'pong'; id?: string | number; serverTime: number }
  | {
      type: 'replay';
      market: string;
      symbol: string;
      fromSeq: number;
      seq: number;
      ticks: Array<{ price: number; time: number; seq: number }>;
      candles: Array<{ tf: string; t: number; o: number; h: number; l: number; c: number }>;
    }
  | { type: 'resync'; market: string; symbol: string; reason: 'seq_too_old'; seq: number }
  | { type: 'error'; code: string; message: string };
