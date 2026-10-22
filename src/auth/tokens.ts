import jwt from 'jsonwebtoken';

export interface SessionPayload {
  sub: string;
  /** server-side session id (registry row); revoking the row kills the token */
  sid: string;
  /** token version - bumping it (logout everywhere / password change) revokes old tokens */
  v: number;
}

export interface TokenService {
  sign(payload: SessionPayload): string;
  verify(token: string): SessionPayload | null;
}

export function createTokenService(secret: string, ttlSec: number): TokenService {
  return {
    sign(payload) {
      return jwt.sign({ v: payload.v, sid: payload.sid }, secret, {
        subject: payload.sub,
        expiresIn: ttlSec,
        algorithm: 'HS256',
        issuer: 'simulated-trading',
      });
    },
    verify(token) {
      try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'simulated-trading' });
        if (typeof decoded === 'string' || !decoded.sub || !decoded.sid) return null;
        return { sub: String(decoded.sub), sid: String(decoded.sid), v: Number(decoded.v ?? 0) };
      } catch {
        return null;
      }
    },
  };
}
