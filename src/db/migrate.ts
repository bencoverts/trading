import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './sqlite.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Splits a .sql file into statements (our migrations contain no triggers/functions). */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'migrations', 'sqlite'),
    path.resolve(here, '..', '..', 'migrations', 'sqlite'),
    path.resolve(here, '..', '..', '..', 'migrations', 'sqlite'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      if (readdirSync(dir).some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('Could not find migrations/sqlite. Set MIGRATIONS_DIR or run from the repository root.');
}

/** Applies pending migrations in filename order; each migration is atomic. */
export function runMigrations(db: Database, dir = resolveMigrationsDir()): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const done = db.get<{ name: string }>('SELECT name FROM schema_migrations WHERE name = ?', file);
    if (done) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      for (const stmt of splitStatements(sql)) db.exec(stmt);
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, Date.now());
    });
    applied.push(file);
  }
  return applied;
}
