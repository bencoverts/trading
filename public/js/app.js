import { get, post } from './api.js';
import { route, setNotFound, navigate, render, startRouter } from './router.js';
import { $, el, money, toast, openModal } from './ui.js';
import {
  isAdmin,
  loadConfig,
  loadMarkets,
  loadSession,
  setDisplayCurrency,
  setWallets,
  store,
  subscribe,
  wallet,
} from './state.js';
import { MarketSocket } from './ws.js';

import { loginPage } from './pages/login.js';
import { registerPage } from './pages/register.js';
import { forgotPage } from './pages/forgot.js';
import { resetPage } from './pages/reset.js';
import { verifyPage } from './pages/verify.js';
import { tradingPage } from './pages/trading.js';
import { accountPage } from './pages/account.js';
import { adminPage } from './pages/admin.js';

/** one socket for the whole app; pages attach their own message handlers */
export const socket = new MarketSocket({
  onStatus: (status) => {
    const badge = $('#conn');
    badge.dataset.state = status;
    badge.textContent = status === 'online' ? 'live' : status;
  },
  onMessage: (msg) => {
    if (msg.type === 'balance' || msg.type === 'account:reset') {
      setWallets(msg.wallets ?? []);
    }
    for (const fn of pageHandlers) fn(msg);
  },
});

const pageHandlers = new Set();
export function onSocketMessage(fn) {
  pageHandlers.add(fn);
  return () => pageHandlers.delete(fn);
}

function renderNav() {
  const nav = $('#nav');
  const items = [
    { href: '/trading', label: 'Trading' },
    { href: '/account', label: 'Account' },
  ];
  if (isAdmin()) items.push({ href: '/admin', label: 'Admin' });
  nav.replaceChildren(
    ...items.map((item) =>
      el(
        'a',
        {
          href: item.href,
          class: `nav-link ${location.pathname.startsWith(item.href) ? 'active' : ''}`,
          'data-link': '',
        },
        item.label,
      ),
    ),
  );
}

function renderSessionChrome() {
  const pill = $('#balancePill');
  const authLink = $('#authLink');
  const toggle = $('#currencyToggle');
  if (store.user) {
    pill.hidden = false;
    authLink.textContent = 'Sign out';
    authLink.href = '#';
    authLink.onclick = async (event) => {
      event.preventDefault();
      await post('/api/v1/auth/logout').catch(() => {});
      store.user = null;
      store.account = null;
      setWallets([]);
      socket.authenticate(null);
      socket.clearSubscriptions();
      toast('Signed out');
      navigate('/login');
      renderNav();
    };
    const w = wallet(store.displayCurrency);
    $('#balanceValue').textContent = money(w.balance, store.displayCurrency);
    toggle.textContent = store.displayCurrency;
    toggle.onclick = async () => {
      const order = store.config?.currencies ?? ['USD', 'IDR', 'USDT'];
      const next = order[(order.indexOf(store.displayCurrency) + 1) % order.length];
      try {
        await import('./api.js').then((m) => m.patch('/api/v1/account', { displayCurrency: next }));
        setDisplayCurrency(next);
        if (store.account) store.account.user.displayCurrency = next;
        toast(`Display currency: ${next}`);
      } catch (err) {
        toast(err.message, 'lose');
      }
    };
  } else {
    pill.hidden = true;
    authLink.textContent = 'Sign in';
    authLink.href = '/login';
    authLink.onclick = null;
  }
  renderNav();
}

subscribe(renderSessionChrome);

// ---------------------------------------------------------------- routes
const guarded = (handler) => async (ctx) => {
  if (!store.user) {
    navigate(`/login?next=${encodeURIComponent(ctx.path)}`, { replace: true });
    return;
  }
  return handler(ctx);
};

const adminOnly = (handler) => async (ctx) => {
  if (!store.user) {
    navigate(`/login?next=${encodeURIComponent(ctx.path)}`, { replace: true });
    return;
  }
  if (!isAdmin()) {
    toast('Admin role required', 'lose');
    navigate('/trading', { replace: true });
    return;
  }
  return handler(ctx);
};

route('/', async () => navigate('/trading', { replace: true }));
route('/login', loginPage);
route('/register', registerPage);
route('/forgot-password', forgotPage);
route('/reset-password', resetPage);
route('/verify-email', verifyPage);
route('/trading', tradingPage);
route('/account', guarded(accountPage));
route('/account/', guarded(accountPage));
route('/admin', adminOnly(adminPage));
route('/admin/', adminOnly(adminPage));

setNotFound(({ outlet }) => {
  outlet.append(el('div', { class: 'panel center' }, el('h2', {}, 'Page not found'), el('a', { href: '/trading', 'data-link': '' }, 'Back to trading')));
});

async function bootstrap() {
  await loadConfig(true).catch((err) => toast(err.message, 'lose'));
  await loadSession().catch(() => {});
  await loadMarkets().catch(() => {});
  renderSessionChrome();
  socket.connect();
  startRouter();
  // keep the header wallet fresh
  setInterval(async () => {
    if (!store.user) return;
    try {
      const account = await get('/api/v1/account');
      store.account = account;
      setWallets(account.wallets);
    } catch {
      /* ignore transient errors */
    }
  }, 30_000);
}

bootstrap();

// expose for debugging in the console (documented in README)
window.simtrade = { store, socket, openModal, money };
