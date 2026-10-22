import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;
  role: 'user' | 'admin';
}

export interface TokenService {
  sign(payload: TokenPayload): string;
  verify(token: string): TokenPayload | null;
}

export function createTokenService(secret: string, ttlSec: number): TokenService {
  return {
    sign(payload) {
      return jwt.sign({ role: payload.role }, secret, {
        subject: payload.sub,
        expiresIn: ttlSec,
        algorithm: 'HS256',
        issuer: 'demo-trading',
      });
    },
    verify(token) {
      try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'demo-trading' });
        if (typeof decoded === 'string' || !decoded.sub) return null;
        const role = decoded.role === 'admin' ? 'admin' : 'user';
        return { sub: String(decoded.sub), role };
      } catch {
        return null;
      }
    },
  };
}
