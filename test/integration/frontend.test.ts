import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRuntime } from '../../src/bootstrap.js';
import type { Runtime } from '../../src/bootstrap.js';
import { testConfig } from '../helpers/app.js';

/**
 * Front-end smoke test.
 *
 * The browser code is plain ES modules served by the same Express app, so we can
 * load them in jsdom against a real running server instance. This catches the
 * kind of mistakes unit tests cannot see: missing elements, broken imports,
 * chart/canvas assumptions and WebSocket wiring.
 */
let runtime: Runtime;
let port: number;
let dom: JSDOM;
let errors: unknown[] = [];

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
        if (prop === 'canRoundRect') return true;
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

beforeAll(async () => {
  runtime = await createRuntime({
    config: testConfig(),
    logger: (await import('pino')).default({ level: 'silent' }),
    attachRealtime: true,
    startEngine: false,
    runSettlementLoop: false,
    backfill: false,
  });
  port = await runtime.listen(0, '127.0.0.1');
  runtime.ctx.engine.ingest('DOGE', 0.4, Date.now());

  dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="sim-banner"><strong>SIMULASI</strong></div>
      <header><nav id="nav"></nav><span id="conn"></span>
        <div id="balancePill" hidden><strong id="balanceValue"></strong><button id="currencyToggle"></button></div>
        <a id="authLink"></a>
      </header>
      <main id="view"></main><div id="modalHost"></div><div id="toasts"></div>
    </body></html>`,
    { url: `http://127.0.0.1:${port}/trading`, pretendToBeVisual: true, runScripts: 'outside-only' },
  );

  const win = dom.window;
  installCanvasStub(win);

  const globalAny = globalThis as unknown as Record<string, unknown>;
  const define = (key: string, value: unknown) => {
    // some globals (navigator) are getter-only on Node, so define instead of assign
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
    'Node',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
  ]) {
    define(key, (win as unknown as Record<string, unknown>)[key]);
  }
  define('window', win);

  // relative fetch -> the real server (capture the native implementation first)
  const base = `http://127.0.0.1:${port}`;
  const nodeFetch = globalThis.fetch.bind(globalThis);
  // Node's fetch has no cookie jar: forward jsdom's document.cookie (the session
  // cookie is httpOnly in the browser, but its value is also returned by /login)
  define('fetch', (input: string, init?: RequestInit) => {
    const cookie = dom.window.document.cookie;
    const headers = new Headers(init?.headers);
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    return nodeFetch(input.startsWith('http') ? input : `${base}${input}`, { ...init, headers });
  });
  define('WebSocket', win.WebSocket);

  win.addEventListener('error', (event: Event) => errors.push((event as unknown as { error: unknown }).error));
  win.addEventListener('unhandledrejection', (event: Event) => errors.push((event as unknown as { reason: unknown }).reason));
});

afterAll(async () => {
  await runtime.stop();
  dom?.window.close();
});

async function waitFor(selector: string, timeout = 5_000): Promise<Element> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const node = dom.window.document.querySelector(selector);
    if (node) return node;
    if (Date.now() > deadline) throw new Error(`selector not found: ${selector}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

it('boots the app shell and renders the trading page with the SIMULASI label', async () => {
  await import('../../public/js/app.js');
  const layout = await waitFor('.trade-layout');

  expect(layout.className).toContain('trade-layout');
  const view = dom.window.document.getElementById('view')!;
  expect(view.textContent).toContain('SIMULASI');
  expect(view.textContent).toContain('DOGE');
  expect(view.textContent).toContain('ASIA_COMPOSITE');
  expect(view.textContent).toContain('CRYPTO_COMPOSITE');

  // market list, chart canvas, timeframe bar
  expect(dom.window.document.querySelectorAll('.market-item').length).toBe(3);
  expect(dom.window.document.querySelector('canvas.chart-canvas')).toBeTruthy();
  const tfs = [...dom.window.document.querySelectorAll('.tf-btn')].map((b) => b.textContent);
  expect(tfs).toEqual(['5s', '15s', '30s', '1m', '5m', '15m', '1h']);

  // trade form: BUY / SELL, amount quick buttons and the 12 duration presets
  const buy = [...dom.window.document.querySelectorAll('.trade-btn')].find((b) => b.textContent?.includes('BUY'));
  const sell = [...dom.window.document.querySelectorAll('.trade-btn')].find((b) => b.textContent?.includes('SELL'));
  expect(buy).toBeTruthy();
  expect(sell).toBeTruthy();
  const durations = [...dom.window.document.querySelectorAll('.dur-btn')].map((b) => b.textContent);
  expect(durations).toEqual(['5s', '10s', '15s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h']);
  const quick = [...dom.window.document.querySelectorAll('.chip')].map((b) => b.textContent);
  expect(quick).toEqual(expect.arrayContaining(['½', 'x2', 'min', 'max']));

  // payout preview exists before any confirmation
  expect(dom.window.document.querySelector('.preview-box')?.textContent).toContain('Payout if win');
});

it('switches market and updates the live price from the websocket feed', async () => {
  await waitFor('#livePrice');
  const doge = [...dom.window.document.querySelectorAll('.market-item')].find((el) => el.textContent?.includes('DOGE')) as HTMLElement;
  expect(doge).toBeTruthy();
  doge.click();
  await new Promise((r) => setTimeout(r, 150));
  // renderMarkets() rebuilds the list, so re-query instead of reusing the node
  const active = dom.window.document.querySelector('.market-item.active');
  expect(active?.textContent).toContain('DOGE');

  runtime.ctx.engine.ingest('DOGE', 0.4321, Date.now());
  const deadline = Date.now() + 4_000;
  let updated = '';
  while (Date.now() < deadline) {
    updated = dom.window.document.querySelector('#livePrice')?.textContent ?? '';
    if (updated.includes('0.4321')) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  // DOGE has 5 price decimals, so the live badge renders 0.43210
  expect(updated).toBe('0.43210');
});

it('renders the login page and navigates between pages without crashing', async () => {
  const { navigate } = await import('../../public/js/router.js');
  await navigate('/login');
  const auth = await waitFor('.auth-card');
  expect(auth.textContent).toContain('Sign in');
  expect(auth.querySelectorAll('input').length).toBe(2);

  await navigate('/register');
  const register = await waitFor('.auth-card');
  expect(register.textContent).toContain('Create account');

  await navigate('/forgot-password');
  expect((await waitFor('.auth-card')).textContent).toContain('Forgot password');
});

it('signs in, shows the demo balance and places a trade through the confirm dialog', async () => {
  const username = `ui_${Date.now().toString(36)}`;
  const email = `${username}@example.com`;
  const res = await (globalThis as unknown as { fetch: typeof fetch }).fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password: 'password-12345' }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  expect(res.status).toBe(201);
  dom.window.document.cookie = `sim_session=${body.token}`;

  const { navigate } = await import('../../public/js/router.js');
  const { loadSession, store } = (await import('../../public/js/state.js')) as {
    loadSession: () => Promise<unknown>;
    store: { user: { username: string } | null };
  };
  await loadSession();
  expect(store.user?.username).toBe(username);

  await navigate('/trading');
  await waitFor('.trade-layout');
  // header balance pill reflects the demo wallet ($1,000.00)
  const pill = dom.window.document.getElementById('balancePill')!;
  expect(pill.hidden).toBe(false);
  expect(dom.window.document.getElementById('balanceValue')?.textContent).toContain('1,000.00');

  // choose DOGE, 5s, amount 10, then BUY -> confirm dialog -> confirm
  const doge = [...dom.window.document.querySelectorAll('.market-item')].find((el) => el.textContent?.includes('DOGE')) as HTMLElement;
  doge.click();
  await new Promise((r) => setTimeout(r, 200));

  const amount = dom.window.document.querySelector('.amount-input') as HTMLInputElement;
  amount.value = '10';
  amount.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const fiveSeconds = [...dom.window.document.querySelectorAll('.dur-btn')].find((b) => b.textContent === '5s') as HTMLElement;
  fiveSeconds.click();
  await new Promise((r) => setTimeout(r, 100));
  expect(dom.window.document.querySelector('.preview-box')?.textContent).toContain('Payout if win');

  const buy = [...dom.window.document.querySelectorAll('.trade-btn')].find((b) => b.textContent?.includes('BUY')) as HTMLElement;
  expect(buy.classList.contains('disabled')).toBe(false);
  buy.click();

  const modal = await waitFor('.modal-card');
  expect(modal.textContent).toContain('Confirm trade');
  expect(modal.textContent).toContain('DOGE');
  expect(modal.textContent).toContain('Entry price');
  expect(modal.textContent).toContain('Payout if win');

  (dom.window.document.getElementById('modalConfirm') as HTMLElement).click();
  const deadline = Date.now() + 5_000;
  let openRows = 0;
  while (Date.now() < deadline) {
    openRows = dom.window.document.querySelectorAll('.trade-row.open').length;
    if (openRows > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(openRows).toBeGreaterThan(0);
  expect(dom.window.document.querySelector('.trade-row.open')?.textContent).toContain('DOGE');
});

it('did not raise uncaught browser errors', () => {
  expect(errors).toEqual([]);
});
