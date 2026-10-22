import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config. `npm run test:e2e` boots the real server on port 3210 with
 * an isolated SQLite file and driven UI flows.
 *
 * NOTE: Playwright browsers must be installed once with `npx playwright install`.
 * In restricted/sandboxed environments the download may be blocked; that is
 * reported honestly in docs/TEST-REPORT.md instead of being faked.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx tsx src/server.ts',
    url: 'http://127.0.0.1:3210/healthz',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      PORT: '3210',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      SQLITE_PATH: './data/e2e.sqlite',
      UPLOADS_DIR: './data/e2e-uploads',
      BACKUP_DIR: './data/e2e-backups',
      JWT_SECRET: 'e2e-secret-that-is-long-enough-for-hs256-ok',
      ADMIN_EMAIL: 'admin@simtrade.local',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin-demo-123',
      DEV_EMAIL_LINKS: 'true',
      RATE_GLOBAL_MAX: '100000',
      RATE_AUTH_MAX: '1000',
      RATE_TRADE_MAX: '1000',
      SETTLE_INTERVAL_MS: '200',
    },
  },
});
