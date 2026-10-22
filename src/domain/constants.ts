export const TIME_FRAMES = {
  '5s': 5_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
} as const;

export type Timeframe = keyof typeof TIME_FRAMES;
export const TIMEFRAME_LIST = Object.keys(TIME_FRAMES) as Timeframe[];

/** Durations offered in the UI and accepted by the server (seconds). */
export const DURATION_PRESETS = [5, 10, 15, 30, 60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800] as const;
export const MIN_DURATION_SEC = 5;
export const MAX_DURATION_SEC = 28_800;

export const CURRENCIES = {
  USD: { code: 'USD', label: 'US Dollar', decimals: 2, symbol: '$' },
  IDR: { code: 'IDR', label: 'Indonesian Rupiah', decimals: 0, symbol: 'Rp' },
  USDT: { code: 'USDT', label: 'Tether (demo)', decimals: 2, symbol: '₮' },
} as const;

export type Currency = keyof typeof CURRENCIES;
export const CURRENCY_LIST = Object.keys(CURRENCIES) as Currency[];

export const MOODS = ['sepi', 'normal', 'cepat', 'liar'] as const;
export type Mood = (typeof MOODS)[number];

export const TRENDS = ['up', 'down', 'neutral'] as const;
export type TrendDirection = (typeof TRENDS)[number];

export type Direction = 'up' | 'down';
export type TradeResult = 'win' | 'lose' | 'draw';

/** UI copy that must also appear in API payloads. */
export const SIMULATION_LABEL = 'SIMULASI';
