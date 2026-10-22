import { describe, expect, it } from 'vitest';
import { detectImage, sanitizeSvg } from '../../src/services/uploads.js';
import { ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_MATRIX, can, permissionsFor } from '../../src/auth/permissions.js';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  totp,
  verifyTotp,
} from '../../src/auth/totp.js';
import { assertSameOrigin } from '../../src/http/session.js';
import type { AppContext } from '../../src/app/context.js';

describe('upload validation', () => {
  it('detects PNG, JPEG, WEBP and SVG by magic bytes', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(8)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(detectImage(png)?.kind).toBe('png');
    expect(detectImage(jpeg)?.kind).toBe('jpeg');
    expect(detectImage(webp)?.kind).toBe('webp');
    expect(detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.kind).toBe('svg');
  });

  it('rejects everything else (HTML, plain text, empty)', () => {
    expect(detectImage(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    expect(detectImage(Buffer.from('hello world'))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });

  it('strips scripts, event handlers and external references from SVG', () => {
    const dirty = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert('xss')</script>
      <a xlink:href="javascript:alert(2)">x</a>
      <iframe src="http://evil"></iframe>
      <circle cx="5" cy="5" r="4" onmouseover="evil()" />
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onload/i);
    expect(clean).not.toMatch(/onmouseover/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).toContain('<circle');
  });
});

describe('permission matrix', () => {
  it('gives super_admin every permission and nobody else users.role', () => {
    expect(ROLE_PERMISSIONS.super_admin).toEqual([...PERMISSIONS]);
    expect(ROLE_PERMISSIONS.operator).not.toContain('users.role');
    expect(ROLE_PERMISSIONS.support).not.toContain('users.role');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('users.role');
  });

  it('keeps viewer read-only', () => {
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(permission.endsWith('.read')).toBe(true);
    }
    expect(can('viewer', 'markets.write')).toBe(false);
    expect(can('operator', 'markets.write')).toBe(true);
    expect(can(null, 'dashboard.read')).toBe(false);
    expect(permissionsFor(null)).toEqual([]);
  });

  it('exposes the same matrix to the UI', () => {
    const row = PERMISSION_MATRIX.find((entry) => entry.permission === 'trades.settle');
    expect(row?.roles.operator).toBe(true);
    expect(row?.roles.support).toBe(false);
    expect(row?.roles.super_admin).toBe(true);
  });
});

describe('TOTP', () => {
  it('round-trips base32', () => {
    const buffer = Buffer.from('12345678901234567890');
    expect(base32Encode(buffer)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890');
  });

  it('matches the RFC 6238 test vector (SHA1, 8 digits, T=59)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
  });

  it('accepts the current code and a one-step drift, rejects others', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });

  it('generates unique recovery codes and hashes them', () => {
    const codes = generateRecoveryCodes(8);
    expect(new Set(codes).size).toBe(8);
    expect(hashRecoveryCode(codes[0])).toHaveLength(64);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(codes[0]));
  });
});

describe('same-origin guard for pre-session mutations', () => {
  const ctx = { config: { CORS_ORIGINS: ['http://localhost:3000'] } } as unknown as AppContext;

  it('allows requests whose host matches, or without an Origin header', () => {
    expect(() => assertSameOrigin(ctx, { header: () => undefined } as never)).not.toThrow();
    expect(() =>
      assertSameOrigin(ctx, { header: () => 'http://localhost:3000', headers: { host: 'localhost:3000' } } as never),
    ).not.toThrow();
  });

  it('rejects a cross-site origin', () => {
    expect(() =>
      assertSameOrigin(ctx, { header: () => 'http://evil.example', headers: { host: 'localhost:3000' } } as never),
    ).toThrow();
  });
});
