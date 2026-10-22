import { describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../src/auth/passwords.js';
import { createTokenService } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';

describe('password hashing', () => {
  const hasher = createPasswordHasher({ memoryCost: 1_024, timeCost: 1 });

  it('produces an argon2id hash that verifies', async () => {
    const hash = await hasher.hash('s3cret-password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hash, 's3cret-password')).toBe(true);
    expect(await hasher.verify(hash, 'wrong-password')).toBe(false);
  });

  it('salts hashes so identical passwords differ', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a).not.toBe(b);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await hasher.verify('not-a-hash', 'whatever')).toBe(false);
  });
});

describe('JWT tokens', () => {
  const tokens = createTokenService('unit-test-secret-unit-test-secret-123', 60);

  it('signs and verifies a payload', () => {
    const token = tokens.sign({ sub: 'user-1', role: 'admin' });
    expect(tokens.verify(token)).toEqual({ sub: 'user-1', role: 'admin' });
  });

  it('rejects a token signed with another secret', () => {
    const other = createTokenService('another-secret-another-secret-123', 60);
    const token = other.sign({ sub: 'user-1', role: 'user' });
    expect(tokens.verify(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(tokens.verify('garbage')).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = createTokenService('unit-test-secret-unit-test-secret-123', -10);
    expect(expired.verify(expired.sign({ sub: 'user-1', role: 'user' }))).toBeNull();
  });
});

describe('configuration validation', () => {
  it('rejects a production setup without a strong JWT secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DB_DRIVER: 'sqlite' })).toThrow(/JWT_SECRET/);
  });

  it('requires DATABASE_URL for postgres', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DB_DRIVER: 'postgres' })).toThrow(/DATABASE_URL/);
  });

  it('rejects an inverted stake range', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', TRADE_MIN_CENTS: '500', TRADE_MAX_CENTS: '100' }),
    ).toThrow(/TRADE_MIN_CENTS/);
  });

  it('parses duration lists and de-duplicates them', () => {
    const cfg = loadConfig({ NODE_ENV: 'development', ALLOWED_DURATIONS: '30,5,5,60' });
    expect(cfg.ALLOWED_DURATIONS).toEqual([5, 30, 60]);
  });

  it('exposes the supported timeframes', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' });
    expect(Object.keys(cfg.TIMEFRAMES)).toEqual(['5s', '15s', '30s', '1m', '5m']);
    expect(cfg.TIMEFRAMES['5m']).toBe(300_000);
  });
});
