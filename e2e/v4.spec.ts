import { expect, test } from '@playwright/test';

/**
 * v4 flows: demo deposit (manual review), withdrawal hold + cancel, live chat.
 * These require the server under playwright.config.ts; KlikQRIS credentials are
 * intentionally absent, so the QRIS path is covered by API tests instead.
 */

const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(page: import('@playwright/test').Page) {
  const username = unique('v4');
  await page.goto('/register');
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Kata sandi').fill('password-12345');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Buat akun demo' }).click();
  await expect(page.locator('.trade-layout')).toBeVisible();
  return username;
}

test.describe('v4 money & support flows', () => {
  test('requests a manual deposit and sees it pending review', async ({ page }) => {
    await register(page);
    await page.goto('/deposit');
    await expect(page.getByRole('heading', { name: 'Deposit Demo' })).toBeVisible();
    await expect(page.getByText('SIMULASI').first()).toBeVisible();

    // manual transfer is the method that works without provider credentials
    await page.getByRole('tab', { name: /Transfer manual/i }).click();
    await page.locator('#depositAmount').fill('50000');
    await page.locator('#depositReference').fill(`E2E-${unique('trx')}`);
    await page.getByRole('button', { name: 'Lanjutkan deposit' }).click();

    await expect(page.getByText('Deposit menunggu review')).toBeVisible({ timeout: 10_000 });
    await page.goto('/transactions');
    await expect(page.getByText('Deposit manual').first()).toBeVisible();
  });

  test('withdraws demo funds then cancels before admin processing', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');
    await expect(page.getByRole('heading', { name: 'Penarikan Demo' })).toBeVisible();
    await page.locator('#wdAmount').fill('100000');
    await page.locator('#wdBank').fill('BCA');
    await page.locator('#wdAccount').fill('1234567890');
    await page.locator('#wdName').fill('Demo User');
    await page.getByRole('button', { name: 'Ajukan penarikan' }).click();

    await expect(page.getByText('Pengajuan dibuat')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.deposit-row').first()).toContainText('pending');
    await page.getByRole('button', { name: 'Batalkan' }).first().click();
    await expect(page.locator('.deposit-row').first()).toContainText('cancelled', { timeout: 10_000 });
  });

  test('sends a live-chat message and sees it in the thread', async ({ page }) => {
    await register(page);
    await page.goto('/live-chat');
    await expect(page.getByRole('heading', { name: 'Live Chat' })).toBeVisible();
    await page
      .getByRole('button', { name: 'Mulai percakapan' })
      .click()
      .catch(() => undefined);
    await page.getByLabel('Pesan').fill('Halo, ini pesan E2E.');
    await page.getByRole('button', { name: 'Kirim' }).click();
    await expect(page.locator('.bubble--user').last()).toContainText('Halo, ini pesan E2E.');
  });

  test('admin reviews the manual deposit queue', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email atau username').fill('admin@simtrade.local');
    await page.getByLabel('Kata sandi').fill('admin-demo-123');
    await page.getByRole('button', { name: 'Masuk' }).click();
    await expect(page.locator('.trade-layout')).toBeVisible();
    await page.goto('/adminpages/deposits');
    await expect(page.getByRole('heading', { name: 'Deposit' })).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();
  });

  test('platform dashboard is the post-login home', async ({ page }) => {
    await register(page);
    await page.goto('/platform');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Halo');
    await expect(page.getByText('SIMULASI / DEMO').first()).toBeVisible();
    await expect(page.getByText('Aksi cepat')).toBeVisible();
  });
});
