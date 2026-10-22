import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Splits a .sql file into individual statements (our migrations contain no functions/triggers). */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function resolveMigrationsDir(driver: 'sqlite' | 'postgres'): Promise<string> {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'migrations', driver),
    path.resolve(here, '..', '..', 'migrations', driver),
    path.resolve(here, '..', '..', '..', 'migrations', driver),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      const entries = await readdir(dir);
      if (entries.some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Could not find migrations for "${driver}". Set MIGRATIONS_DIR or run from the repository root.`,
  );
}

/**
 * Applies pending .sql migrations in filename order. Each migration and its
 * bookkeeping row are committed atomically.
 */
export async function runMigrations(db: Db, dir: string): Promise<string[]> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const done = await db.get<{ name: string }>(`SELECT name FROM schema_migrations WHERE name = ?`, [file]);
    if (done) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.tx(async (t) => {
      for (const stmt of splitStatements(sql)) {
        await t.run(stmt);
      }
      await t.run(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, [file, Date.now()]);
    });
    applied.push(file);
  }
  return applied;
}
