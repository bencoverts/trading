import { Writable } from 'node:stream';

export interface BufferedLog {
  id: number;
  time: number;
  level: number;
  levelLabel: string;
  msg: string;
  context: Record<string, unknown>;
}

const LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * In-memory tail of the application log so the admin "System → Log" page can
 * show recent lines without reading files. Never stores credentials because
 * pino redaction happens before the stream is written.
 */
export class LogBuffer extends Writable {
  private entries: BufferedLog[] = [];
  private seq = 0;

  constructor(private readonly limit = 500) {
    super({ objectMode: true });
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const raw =
        typeof chunk === 'string' ? (JSON.parse(chunk) as Record<string, unknown>) : (chunk as Record<string, unknown>);
      const { level, time, msg, pid, hostname, service, env, ...rest } = raw as Record<string, unknown>;
      this.seq += 1;
      this.entries.push({
        id: this.seq,
        time: typeof time === 'number' ? time : Date.parse(String(time)) || Date.now(),
        level: Number(level ?? 30),
        levelLabel: LEVELS[Number(level ?? 30)] ?? 'info',
        msg: String(msg ?? ''),
        context: rest,
      });
      if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
      void pid;
      void hostname;
      void service;
      void env;
    } catch {
      /* never let logging break the request */
    }
    callback();
  }

  list(opts: { level?: string; search?: string; limit?: number } = {}): BufferedLog[] {
    const minLevelEntry = opts.level
      ? Object.keys(LEVELS).find((key) => LEVELS[Number(key)] === opts.level)
      : undefined;
    const min = minLevelEntry ? Number(minLevelEntry) : 0;
    const needle = opts.search?.trim().toLowerCase();
    return this.entries
      .filter((entry) => entry.level >= min)
      .filter((entry) => {
        if (!needle) return true;
        return entry.msg.toLowerCase().includes(needle) || JSON.stringify(entry.context).toLowerCase().includes(needle);
      })
      .slice(-Math.min(opts.limit ?? 200, this.limit))
      .reverse();
  }
}

export const logBuffer = new LogBuffer(1000);
