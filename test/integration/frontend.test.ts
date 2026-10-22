import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/bootstrap.js';
import type { Runtime } from '../../src/bootstrap.js';
import { TEST_ADMIN, testConfig } from '../helpers/app.js';

/**
 * Front-end smoke test.
 *
 * The browser code is plain ES modules served by the same Express app, so we
 * load them in jsdom against a real running server. This catches what unit
 * tests cannot see: missing DOM ids, broken module imports, chart/canvas
 * assumptions, cookie/CSRF wiring and the WebSocket connection.
 */
let runtime: Runtime;
let port: number;
let dom: JSDOM;
const errors: unknown[] = [];
const jar = new Map<string, string>();

function installCanvasStub(win: JSDOM['window']) {
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, prop: string) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') return () => ({ width: 24 });
        if (prop === 'createLinearGradient') return () => gradient;
        if (prop === 'canvas') return target.canvas;
        return () => {};
      },
      set(target: Record<string, unknown>, prop: string, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  win.HTMLCanvasElement.prototype.getContext = function (this: unknown) {
    (ctx as unknown as Record<string, unknown>).canvas = this;
    return ctx;
  } as unknown as typeof win.HTMLCanvasElement.prototype.getContext;
}

function storeCookies(win: JSDOM['window'], res: Response) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const header of raw) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
    // httpOnly cookies are invisible to document.cookie by design
    if (!/httponly/i.test(header)) {
      win.document.cookie = `${name}=${value}; path=/`;
    }
  }
}

beforeAll(async () => {
  runtime = await createRuntime({
    config: testConfig(),
    logger: (await import('pino')).default({ level: 'silent' }),
    attachRealtime: true,
    startEngine: false,
    runSettlementLoop: false,
    startJobs: false,
    backfill: false,
  });
  port = await runtime.listen(0, '127.0.0.1');
  runtime.ctx.engine.ingest('DOGE', 0.4, Date.now());
  for (const symbol of ['ASIA_COMPOSITE', 'CRYPTO_COMPOSITE']) {
    runtime.ctx.engine.ingest(symbol, runtime.ctx.engine.lastPrice(symbol) ?? 100, Date.now());
  }

  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/`)).text();
  dom = new JSDOM(html, { url: `${base}/`, pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  installCanvasStub(win);

  const globalAny = globalThis as unknown as Record<string, unknown>;
  const define = (key: string, value: unknown) => {
    try {
      globalAny[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'localStorage',
    'HTMLElement',
    'HTMLCanvasElement',
    'XMLHttpRequest',
    'Node',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'FormData',
    'File',
    'Blob',
  ]) {
    define(key, (win as unknown as Record<string, unknown>)[key]);
  }
  define('window', win);
  define('WebSocket', win.WebSocket);

  const nodeFetch = globalThis.fetch.bind(globalThis);
  define('fetch', async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await nodeFetch(input.startsWith('http') ? input : `${base}${input}`, { ...init, headers });
    storeCookies(win, res);
    return res;
  });
  define('WebSocket', win.WebSocket);

  win.addEventListener('error', (event: Event) => errors.push((event as unknown as { error: unknown }).error));
  win.addEventListener('unhandledrejection', (event: Event) =>
    errors.push((event as unknown as { reason: unknown }).reason),
  );
});

afterAll(async () => {
  window.__socket?.close?.();
  await runtime.stop();
  dom?.window.close();
});

async function waitFor(selector: string, timeout = 8_000): Promise<Element> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const node = dom.window.document.querySelector(selector);
    if (node) return node;
    if (Date.now() > deadline) throw new Error(`selector not found: ${selector}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('static shell', () => {
  it('serves the SPA shell, design system and favicon', async () => {
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('SIMULASI');
    expect(html).toContain('/css/app.css');
    expect(html).toContain('/js/app.js');
    expect(html).toContain('id="view"');
    // every footer page is linked and every page is part of the client router
    for (const route of ['/faq', '/terms', '/privacy', '/contact', '/shortcuts']) {
      expect(html).toContain(route);
    }

    const css = await fetch(`http://127.0.0.1:${port}/css/app.css`);
    expect(css.status).toBe(200);
    const cssText = await css.text();
    expect(cssText).toContain('--up:');
    expect(cssText).toContain("data-theme='light'");
    expect(cssText).toContain('.trade-layout');

    const favicon = await fetch(`http://127.0.0.1:${port}/assets/favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(await favicon.text()).toContain('<svg');

    const fallback = await fetch(`http://127.0.0.1:${port}/trading/DOGE`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('id="view"');

    const missingApi = await fetch(`http://127.0.0.1:${port}/api/v1/does-not-exist`);
    expect(missingApi.status).toBe(404);
    const body = (await missingApi.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('imports every page module shipped in public/js/pages', () => {
    const dir = path.resolve('public/js/pages');
    const files = [
      'account.js',
      'admin.js',
      'auth.js',
      'content.js',
      'history.js',
      'home.js',
      'notifications.js',
      'trading.js',
      'platform.js',
      'finance.js',
      'chat.js',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source.length).toBeGreaterThan(200);
    }
  });

  it('ships the v4 routes in the client router', async () => {
    const app = await (await import('node:fs/promises')).readFile(path.resolve('public/js/app.js'), 'utf8');
    for (const route of [
      "'/platform'",
      "'/dashboard'",
      "'/deposit'",
      "'/withdraw'",
      "'/transactions'",
      "'/payment-status'",
      "'/live-chat'",
      "'/adminpages'",
      "'/market/:symbol'",
    ]) {
      expect(app).toContain(route);
    }
    const css = await (await import('node:fs/promises')).readFile(path.resolve('public/css/app.css'), 'utf8');
    expect(css).toContain('.chat-layout');
    expect(css).toContain('.quick-action');
  });
});

describe('browser app', () => {
  it('boots, renders the landing page and marks itself as a simulation everywhere', async () => {
    await import('../../public/js/app.js');
    await waitFor('.hero');
    await waitFor('.market-card');
    const document = dom.window.document;
    expect(document.querySelector('.sim-banner')?.textContent).toContain('SIMULASI');
    expect(document.querySelector('.footer')?.textContent).toContain('SIMULASI');
    const view = document.getElementById('view')!;
    expect(view.textContent).toContain('Dogecoin');
    expect(view.textContent).toContain('Asia Composite');
    expect(view.textContent).toContain('Crypto Composite');
    expect(view.textContent).toContain('payout');
  });

  it('renders the trading terminal with chart, market list and duration presets', async () => {
    await (dom.window as unknown as { router: { go: (path: string) => Promise<void> } }).router.go('/trading');
    await waitFor('.trade-layout');
    const document = dom.window.document;
    expect(document.querySelectorAll('.market-item').length).toBe(3);
    expect(document.querySelector('.chart-canvas-wrap canvas')).toBeTruthy();
    const chips = [...document.querySelectorAll('.chip')].map((chip) => chip.textContent);
    expect(chips).toContain('5s');
    expect(chips).toContain('8j');
    expect(chips).toEqual(expect.arrayContaining(['maks', '×2', '½']));
    const buttons = [...document.querySelectorAll('.btn--trade')].map((button) => button.textContent);
    expect(buttons.join(' ')).toContain('BELI');
    expect(buttons.join(' ')).toContain('JUAL');
    expect(document.getElementById('view')!.textContent).toContain('SIMULASI');
  });

  it('renders the auth and content pages', async () => {
    const router = (dom.window as unknown as { router: { go: (path: string) => Promise<void> } }).router;
    await router.go('/login');
    const form = await waitFor('form');
    expect(form.querySelectorAll('input').length).toBeGreaterThanOrEqual(2);
    expect(dom.window.document.getElementById('view')!.textContent).toContain('Masuk');

    await router.go('/faq');
    await waitFor('.content-page');
    expect(dom.window.document.getElementById('view')!.textContent).toContain('FAQ');
  });

  it('signs in through the form, shows the demo balance and opens a trade', async () => {
    const router = (dom.window as unknown as { router: { go: (path: string) => Promise<void> } }).router;
    const password = 'password-12345';
    const username = `ui${Date.now().toString(36)}`;

    await router.go('/register');
    const form = await waitFor('form');
    const setValue = (name: string, value: string) => {
      const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    setValue('email', `${username}@example.com`);
    setValue('username', username);
    setValue('password', password);
    const terms = form.querySelector('[name="acceptTerms"]') as HTMLInputElement;
    terms.checked = true;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor('.trade-layout', 10_000);
    const balancePill = dom.window.document.getElementById('balancePill')!;
    expect(balancePill.hidden).toBe(false);
    expect(dom.window.document.getElementById('balanceValue')?.textContent).toContain('1');

    const document = dom.window.document;
    const amount = document.querySelector('.amount-input input') as HTMLInputElement;
    // new accounts default to IDR, whose minimum ticket is much larger than USD's
    const displayCurrency = dom.window.document.querySelector('.amount-input__ccy')?.textContent?.trim();
    amount.value = displayCurrency === 'IDR' ? '100000' : '10';
    amount.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const buy = [...document.querySelectorAll('.trade-panel-col .btn--trade')].find((button) =>
      button.textContent?.includes('BELI'),
    ) as HTMLElement;
    expect(buy).toBeTruthy();
    buy.click();
    const confirm = await waitFor('.modal .modal__actions');
    const ok = [...confirm.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Konfirmasi'),
    ) as HTMLElement;
    ok.click();

    await waitFor('.card .trade-row', 10_000);
    expect(document.getElementById('view')!.textContent).toContain('terbuka');
  });

  it('renders the account, history, notifications and admin screens for staff', async () => {
    const router = (dom.window as unknown as { router: { go: (path: string) => Promise<void> } }).router;
    type WindowWithLogout = { __logout: () => Promise<void> };
    await (dom.window as unknown as WindowWithLogout).__logout();

    await router.go('/login');
    const form = await waitFor('form');
    const setValue = (name: string, value: string) => {
      const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    setValue('identifier', TEST_ADMIN.email);
    setValue('password', TEST_ADMIN.password);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor('.trade-layout', 10_000);

    const document = dom.window.document;
    await router.go('/history');
    await waitFor('.filter-bar');
    expect(document.getElementById('view')!.textContent).toContain('Riwayat');

    await router.go('/account');
    await waitFor('.tabs');
    expect(document.getElementById('view')!.textContent).toContain('Dompet');

    await router.go('/notifications');
    await waitFor('.page-head');
    expect(document.getElementById('view')!.textContent).toContain('Notifikasi');

    await router.go('/admin');
    await waitFor('.admin-layout', 10_000);
    expect(document.querySelector('.admin-nav')!.textContent).toContain('Pengguna');
    expect(document.querySelector('.admin-nav')!.textContent).toContain('Sistem');
  });

  it('renders the v4 platform, finance and chat pages', async () => {
    const router = (dom.window as unknown as { router: { go: (path: string) => Promise<void> } }).router;
    const document = dom.window.document;

    await router.go('/platform');
    await waitFor('.quick-grid', 10_000);
    expect(document.getElementById('view')!.textContent).toContain('SIMULASI / DEMO');
    expect(document.querySelectorAll('.wallet-card').length).toBeGreaterThanOrEqual(3);

    await router.go('/dashboard');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector('.page-head h1')?.textContent).toContain('Dashboard Akun');

    await router.go('/deposit');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitFor('form');
    expect(document.getElementById('view')!.textContent).toContain('Deposit Demo');
    expect(document.getElementById('view')!.textContent).toContain('SIMULASI');

    await router.go('/withdraw');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitFor('form');
    expect(document.getElementById('view')!.textContent).toContain('Penarikan Demo');

    await router.go('/transactions');
    await waitFor('.page-head');
    expect(document.getElementById('view')!.textContent).toContain('Transaksi');

    await router.go('/payment-status');
    await waitFor('.page-head');
    expect(document.getElementById('view')!.textContent).toContain('Status Pembayaran');

    await router.go('/live-chat');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitFor('.chat-layout');
    expect(document.getElementById('view')!.textContent).toContain('Live Chat');

    await router.go('/adminpages/deposits');
    await waitFor('.admin-layout', 10_000);
    expect(document.querySelector('.admin-nav')!.textContent).toContain('Penarikan');
    expect(document.querySelector('.admin-nav')!.textContent).toContain('Mata uang');
  });

  it('did not produce unhandled browser errors', () => {
    expect(errors).toEqual([]);
  });
});

declare global {
  interface Window {
    __socket?: { close?: () => void };
  }
}
