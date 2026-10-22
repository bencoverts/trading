import argon2 from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** argon2id with parameters from the environment. */
export function createPasswordHasher(opts: { memoryCost: number; timeCost: number }): PasswordHasher {
  return {
    hash(password) {
      return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: opts.memoryCost,
        timeCost: opts.timeCost,
        parallelism: 1,
      });
    },
    async verify(hash, password) {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    },
  };
}

/** Used by tests and dev tooling: a hash that works with the same verifier. */
export const ARGON2_DEFAULTS = { memoryCost: 19_456, timeCost: 2 } as const;
