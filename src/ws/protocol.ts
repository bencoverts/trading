import { z } from 'zod';

/** ---------- client -> server ---------- */

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.union([z.string(), z.number()]).optional() }),
  z.object({
    type: z.literal('subscribe'),
    symbol: z.string().min(1).max(32),
    timeframe: z.string().min(1).max(8),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    symbol: z.string().min(1).max(32),
    timeframe: z.string().min(1).max(8),
  }),
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({ type: z.literal('resume'), lastSeq: z.number().int().nonnegative() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** ---------- server -> client ---------- */

export interface ServerHello {
  type: 'hello';
  serverTime: number;
  seq: number;
  symbol: string;
  symbolName: string;
  timeframes: string[];
  priceDecimals: number;
  authenticated: boolean;
  userId: string | null;
  tickIntervalMs: number;
  heartbeatMs: number;
}

export interface ServerSubscribed {
  type: 'subscribed';
  symbol: string;
  timeframe: string;
  seq: number;
}

export interface ServerTick {
  type: 'tick';
  symbol: string;
  price: number;
  time: number;
  seq: number;
}

export interface ServerCandle {
  type: 'candle';
  symbol: string;
  tf: string;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  seq: number;
}

export interface ServerCandleClosed {
  type: 'candle_closed';
  symbol: string;
  tf: string;
  candle: { t: number; o: number; h: number; l: number; c: number };
  seq: number;
}

export interface ServerTradeOpened {
  type: 'trade:opened';
  trade: Record<string, unknown>;
}

export interface ServerTradeSettled {
  type: 'trade:settled';
  id: string;
  result: 'win' | 'lose' | 'draw';
  payout: number;
  closePrice: number;
  trade: Record<string, unknown>;
}

export interface ServerBalance {
  type: 'balance';
  amount: number;
  amountCents: number;
  currency: string;
}

export interface ServerPong {
  type: 'pong';
  id?: string | number;
  serverTime: number;
  seq: number;
}

export interface ServerReplay {
  type: 'replay';
  fromSeq: number;
  seq: number;
  ticks: ServerTick[];
  candles: ServerCandle[];
}

export interface ServerError {
  type: 'error';
  code: string;
  message: string;
}

export interface ServerResync {
  type: 'resync';
  reason: 'seq_too_old';
  seq: number;
}

export type ServerMessage =
  | ServerHello
  | ServerSubscribed
  | ServerTick
  | ServerCandle
  | ServerCandleClosed
  | ServerTradeOpened
  | ServerTradeSettled
  | ServerBalance
  | ServerPong
  | ServerReplay
  | ServerError
  | ServerResync;
