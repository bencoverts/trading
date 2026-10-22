import { z } from 'zod';

/** ---------- client -> server ---------- */

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.union([z.string(), z.number()]).optional() }),
  z.object({
    type: z.literal('subscribe'),
    market: z.string().min(1).max(32),
    timeframe: z.string().min(1).max(8),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    market: z.string().min(1).max(32),
    timeframe: z.string().min(1).max(8),
  }),
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({ type: z.literal('resume'), market: z.string().min(1).max(32), lastSeq: z.number().int().nonnegative() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** ---------- server -> client ---------- */

export type ServerMessage =
  | {
      type: 'hello';
      serverTime: number;
      simulation: true;
      markets: Array<{ symbol: string; name: string; lastSeq: number; paused: boolean; priceDecimals: number }>;
      timeframes: string[];
      authenticated: boolean;
      userId: string | null;
      tickMaxPerSec: number;
      heartbeatMs: number;
    }
  | { type: 'subscribed'; market: string; timeframe: string; snapshot: { lastPrice: number | null; candle: unknown } }
  | { type: 'tick'; market: string; price: number; time: number; seq: number }
  | { type: 'candle'; market: string; tf: string; t: number; o: number; h: number; l: number; c: number; seq: number }
  | {
      type: 'candle_closed';
      market: string;
      tf: string;
      candle: { t: number; o: number; h: number; l: number; c: number };
      seq: number;
    }
  | { type: 'trade:opened'; trade: unknown }
  | { type: 'trade:settled'; id: string; result: 'win' | 'lose' | 'draw'; payout: number; closePrice: number; trade: unknown }
  | { type: 'balance'; wallets: Array<{ currency: string; balance: number; balanceMinor: number }> }
  | { type: 'account:reset'; wallets: Array<{ currency: string; balance: number; balanceMinor: number }> }
  | { type: 'pong'; id?: string | number; serverTime: number }
  | {
      type: 'replay';
      market: string;
      fromSeq: number;
      seq: number;
      ticks: Array<{ price: number; time: number; seq: number }>;
      candles: Array<{ tf: string; t: number; o: number; h: number; l: number; c: number }>;
    }
  | { type: 'resync'; market: string; reason: 'seq_too_old'; seq: number }
  | { type: 'error'; code: string; message: string };
