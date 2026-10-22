/**
 * Trading hours per market, always evaluated in the market's timezone
 * (default Asia/Jakarta). Two modes:
 *   { "mode": "24_7" }
 *   { "mode": "schedule", "timezone": "Asia/Jakarta",
 *     "days": [{ "day": 1, "from": "08:00", "to": "22:00" }, ...] }   // 0=Sunday
 */
export interface TradingWindow {
  day: number;
  from: string;
  to: string;
}

export interface TradingHours {
  mode: '24_7' | 'schedule';
  timezone?: string;
  days?: TradingWindow[];
}

export const DEFAULT_TRADING_HOURS: TradingHours = { mode: '24_7' };

export const DEFAULT_MARKET_TIMEZONE = 'Asia/Jakarta';

/** Current local day + minutes since midnight in `timezone`. */
export function zonedParts(timeMs: number, timezone: string): { day: number; minutes: number } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_MARKET_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  const parts = formatter.formatToParts(new Date(timeMs));
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: map[weekday] ?? 1, minutes: hour * 60 + minute };
}

const toMinutes = (value: string): number | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

export function isMarketOpen(
  hours: TradingHours | null | undefined,
  timeMs: number,
): { open: boolean; reason?: string } {
  if (!hours || hours.mode === '24_7') return { open: true };
  const timezone = hours.timezone || DEFAULT_MARKET_TIMEZONE;
  const { day, minutes } = zonedParts(timeMs, timezone);
  const windows = (hours.days ?? []).filter((w) => w.day === day);
  if (!windows.length) return { open: false, reason: `Tidak ada jam trading pada hari ini (${timezone})` };
  for (const window of windows) {
    const from = toMinutes(window.from);
    const to = toMinutes(window.to);
    if (from === null || to === null) continue;
    if (from <= to) {
      if (minutes >= from && minutes < to) return { open: true };
    } else if (minutes >= from || minutes < to) {
      // window crossing midnight
      return { open: true };
    }
  }
  return { open: false, reason: `Di luar jam trading (${timezone})` };
}

export function parseTradingHours(raw: string | null | undefined): TradingHours {
  if (!raw) return DEFAULT_TRADING_HOURS;
  try {
    const parsed = JSON.parse(raw) as TradingHours;
    if (parsed.mode === 'schedule') {
      return {
        mode: 'schedule',
        timezone: parsed.timezone || DEFAULT_MARKET_TIMEZONE,
        days: (parsed.days ?? [])
          .filter((d) => Number.isInteger(d.day) && d.day >= 0 && d.day <= 6)
          .map((d) => ({ day: d.day, from: d.from, to: d.to })),
      };
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_TRADING_HOURS;
}
