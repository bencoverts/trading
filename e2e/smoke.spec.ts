import { expect, test } from '@playwright/test';

/**
 * Playwright flows required by the spec:
 *  - register a demo account
 *  - login
 *  - open a trade and see the result
 *  - admin adds a market with a logo, and the market becomes visible to users
 */

const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(page: import('@playwright/test').Page) {
  const username = unique('e2e');
  await page.goto('/register');
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Kata sandi').fill('password-12345');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Buat akun demo' }).click();
  await expect(page.locator('.trade-layout')).toBeVisible();
  return username;
}

test.describe('demo trading platform', () => {
  test('registers, opens a trade in the UI and sees a settled result', async ({ page }) => {
    await register(page);
    await expect(page.getByText('SIMULASI').first()).toBeVisible();

    const amount = page.locator('.amount-input input');
    const currency = (await page.locator('.amount-input__ccy').first().textContent())?.trim();
    await amount.fill(currency === 'IDR' ? '100000' : '10');
    await page.locator('.chip', { hasText: '5s' }).first().click();
    await page.getByRole('button', { name: /BELI/ }).first().click();

    // confirmation dialog (the "don't ask again" preference is opt-in)
    const dialog = page.locator('.modal');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Konfirmasi' }).click();

    // the active-trades card shows the countdown
    await expect(page.locator('.countdown').first()).toBeVisible({ timeout: 15_000 });
    // settlement (5 s) turns into a toast and a closed row in history
    await expect(page.locator('.toast')).toBeVisible({ timeout: 20_000 });
    await page.goto('/history');
    await expect(page.locator('.trade-row').first()).toBeVisible();
  });

  test('logs in with the seeded demo account', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email atau username').fill('demo@simtrade.local');
    await page.getByLabel('Kata sandi').fill('demo-password-123');
    await page.getByRole('button', { name: 'Masuk' }).click();
    await expect(page.locator('.trade-layout')).toBeVisible();
    await expect(page.locator('#balancePill')).toBeVisible();
  });

  test('admin adds a market with a logo and users can see it', async ({ page }) => {
    const symbol = `E2E${Math.floor(Math.random() * 90_000 + 10_000)}`;
    await page.goto('/login');
    await page.getByLabel('Email atau username').fill('admin@simtrade.local');
    await page.getByLabel('Kata sandi').fill('admin-demo-123');
    await page.getByRole('button', { name: 'Masuk' }).click();
    await expect(page.locator('#balancePill')).toBeVisible();

    await page.goto('/admin/markets');
    await page.getByRole('button', { name: 'Tambah market' }).click();
    const dialog = page.locator('.modal');
    await dialog.locator('input').nth(0).fill(symbol);
    await dialog.locator('input').nth(1).fill(`Market ${symbol}`);
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await dialog.getByRole('button', { name: 'Buat market' }).click();
    await expect(page.locator('table.data')).toContainText(symbol);

    // a normal user sees the new market in the public list
    await page.goto('/');
    await expect(page.locator('.market-card', { hasText: `Market ${symbol}` })).toBeVisible();
  });

  test('is mobile friendly: the trade panel becomes a bottom sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/trading');
    await expect(page.locator('.mobile-trade-bar')).toBeVisible();
    await page.getByRole('button', { name: 'BELI' }).click();
    await expect(page.locator('.sheet')).toBeVisible();
  });
});
