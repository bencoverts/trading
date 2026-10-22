import pino from 'pino';
import type { Config } from '../config.js';
import { logBuffer } from './logBuffer.js';

export type Logger = pino.Logger;

export function createLogger(config: Config): Logger {
  return pino(
    {
      level: config.LOG_LEVEL,
      base: { service: 'simulated-trading', env: config.NODE_ENV },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          '*.password',
          'body.password',
          'token',
          '*.token',
          'secret',
          '*.secret',
          'req.headers["x-csrf-token"]',
        ],
        censor: '[redacted]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([{ stream: process.stdout }, { stream: logBuffer }]),
  );
}
