import type { Database } from '../db/sqlite.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export interface JobDefinition {
  name: string;
  label: string;
  intervalMs: number;
  /** first run delay (defaults to the interval) */
  firstDelayMs?: number;
  run: () => Promise<unknown> | unknown;
}

export interface JobStatus {
  name: string;
  label: string;
  intervalMs: number;
  lastRunAt: number | null;
  lastFinishedAt: number | null;
  lastStatus: 'ok' | 'error' | 'never' | 'running';
  lastDurationMs: number | null;
  lastError: string | null;
  lastDetail: string | null;
  nextRunAt: number | null;
  stale: boolean;
}

interface JobState {
  definition: JobDefinition;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastRunAt: number | null;
  lastFinishedAt: number | null;
  lastStatus: 'ok' | 'error' | 'never' | 'running';
  lastDurationMs: number | null;
  lastError: string | null;
  lastDetail: string | null;
  nextRunAt: number | null;
}

/**
 * Tiny dependency-free scheduler. Every run is persisted to `job_runs`, so the
 * admin system page can show the last outcome and flag stale jobs.
 */
export class JobScheduler {
  private readonly jobs = new Map<string, JobState>();
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  register(definition: JobDefinition): void {
    if (this.jobs.has(definition.name)) throw new Error(`job ${definition.name} sudah terdaftar`);
    this.jobs.set(definition.name, {
      definition,
      timer: null,
      running: false,
      lastRunAt: null,
      lastFinishedAt: null,
      lastStatus: 'never',
      lastDurationMs: null,
      lastError: null,
      lastDetail: null,
      nextRunAt: null,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const state of this.jobs.values()) {
      this.schedule(state, state.definition.firstDelayMs ?? state.definition.intervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const state of this.jobs.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.nextRunAt = null;
    }
    // let in-flight runs finish (they are all short and synchronous in practice)
    const deadline = Date.now() + 3_000;
    while ([...this.jobs.values()].some((s) => s.running) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Runs a job now (used by the admin "Run now" button and by tests). */
  async runNow(name: string): Promise<unknown> {
    const state = this.jobs.get(name);
    if (!state) throw AppError.notFound(`Job tidak dikenal: ${name}`);
    return this.execute(state);
  }

  status(): JobStatus[] {
    const now = this.now();
    return [...this.jobs.values()].map((state) => ({
      name: state.definition.name,
      label: state.definition.label,
      intervalMs: state.definition.intervalMs,
      lastRunAt: state.lastRunAt,
      lastFinishedAt: state.lastFinishedAt,
      lastStatus: state.lastStatus,
      lastDurationMs: state.lastDurationMs,
      lastError: state.lastError,
      lastDetail: state.lastDetail,
      nextRunAt: state.nextRunAt,
      // a job that has not completed within 3 intervals is considered stale
      stale: state.lastFinishedAt === null ? false : now - state.lastFinishedAt > state.definition.intervalMs * 3,
    }));
  }

  history(limit = 50): Array<{
    id: number;
    job: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    durationMs: number | null;
    detail: string | null;
    error: string | null;
  }> {
    const rows = this.db.all<{
      id: number;
      job: string;
      status: string;
      started_at: number;
      finished_at: number | null;
      duration_ms: number | null;
      detail: string | null;
      error: string | null;
    }>('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?', Math.min(Math.max(limit, 1), 200));
    return rows.map((row) => ({
      id: row.id,
      job: row.job,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      detail: row.detail,
      error: row.error,
    }));
  }

  private schedule(state: JobState, delayMs: number): void {
    if (!this.running) return;
    state.nextRunAt = this.now() + delayMs;
    state.timer = setTimeout(
      () => {
        void this.execute(state).finally(() => this.schedule(state, state.definition.intervalMs));
      },
      Math.max(10, delayMs),
    );
    state.timer.unref?.();
  }

  private async execute(state: JobState): Promise<unknown> {
    const startedAt = this.now();
    const insert = this.db.run(
      'INSERT INTO job_runs (job, status, started_at) VALUES (?, ?, ?)',
      state.definition.name,
      'running',
      startedAt,
    );
    const runId = Number(insert.lastInsertRowid);
    state.running = true;
    state.lastRunAt = startedAt;
    state.lastStatus = 'running';
    try {
      const result = await state.definition.run();
      const finishedAt = this.now();
      const detail = summarize(result);
      state.lastStatus = 'ok';
      state.lastFinishedAt = finishedAt;
      state.lastDurationMs = finishedAt - startedAt;
      state.lastError = null;
      state.lastDetail = detail;
      this.db.run(
        'UPDATE job_runs SET status = ?, finished_at = ?, duration_ms = ?, detail = ? WHERE id = ?',
        'ok',
        finishedAt,
        finishedAt - startedAt,
        detail,
        runId,
      );
      return result;
    } catch (err) {
      const finishedAt = this.now();
      const message = err instanceof Error ? err.message : String(err);
      state.lastStatus = 'error';
      state.lastFinishedAt = finishedAt;
      state.lastDurationMs = finishedAt - startedAt;
      state.lastError = message;
      this.db.run(
        'UPDATE job_runs SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ?',
        'error',
        finishedAt,
        finishedAt - startedAt,
        message.slice(0, 500),
        runId,
      );
      this.logger.error({ err, job: state.definition.name }, 'job gagal');
      return null;
    } finally {
      state.running = false;
    }
  }
}

function summarize(result: unknown): string {
  if (result === null || result === undefined) return 'selesai';
  if (typeof result === 'number') return String(result);
  try {
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return 'selesai';
  }
}
