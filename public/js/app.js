/**
 * Application shell: session bootstrap, navigation, theme/language, realtime
 * connection and the client router. Pages are plain ES modules that render
 * into #view.
 */

import { get, post } from './api.js';
import { setLanguage, t, translateDom } from './i18n.js';
import { createRouter } from './router.js';
import { loadLocalPrefs, saveLocalPrefs, setState, state, subscribe, walletFor } from './store.js';
import { $, clear, el, fmt, toast } from './ui.js';
import { createSocket } from './ws.js';
import { homePage } from './pages/home.js';
import { tradingPage } from './pages/trading.js';
import { historyPage } from './pages/history.js';
import { accountPage } from './pages/account.js';
import { notificationsPage } from './pages/notifications.js';
import { authPage } from './pages/auth.js';
import { contentPage, notFoundPage } from './pages/content.js';
import { platformPage } from './pages/platform.js';
import { depositPage, paymentStatusPage, transactionsPage, withdrawPage } from './pages/finance.js';
import { liveChatPage } from './pages/chat.js';

const view = $('#view');
const nav = $('#nav');

loadLocalPrefs();
applyTheme(state.theme);
setLanguage(state.language);

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--accent', state.platform?.accent ?? '#5b8cff');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#080b12');
  const icon = document.querySelector('[data-theme-icon]');
  if (icon) icon.textContent = theme === 'light' ? '☾' : '◐';
}

function applyLanguage(lang) {
  setLanguage(lang);
  translateDom();
  const button = $('#langToggle');
  if (button) button.textContent = lang === 'en' ? 'EN' : 'ID';
  renderNav();
}

function renderNav() {
  clear(nav);
  const staff = Boolean(state.user?.staffRole);
  const flags = state.config?.features ?? {};
  const items = [
    { href: state.user ? '/platform' : '/', label: state.user ? t('nav.platform') : t('nav.home') },
    { href: '/trading', label: t('nav.trade') },
    ...(state.user && flags.deposits ? [{ href: '/deposit', label: t('nav.deposit') }] : []),
    ...(state.user ? [{ href: '/history', label: t('nav.history') }] : []),
    ...(state.user && flags.liveChat ? [{ href: '/live-chat', label: t('nav.chat') }] : []),
    ...(state.user ? [{ href: '/account', label: t('nav.account') }] : []),
    ...(state.user ? [{ href: '/notifications', label: t('nav.notifications') }] : []),
    ...(staff ? [{ href: '/adminpages', label: t('nav.admin') }] : []),
  ];
  for (const item of items) {
    nav.append(
      el(
        'a',
        { href: item.href, 'data-link': '', 'aria-current': location.pathname === item.href ? 'page' : null },
        item.label,
      ),
    );
  }
  if (!state.user) nav.append(el('a', { href: '/login', 'data-link': '' }, t('nav.login')));
}

function renderHeader() {
  const signedIn = Boolean(state.user);
  const balancePill = $('#balancePill');
  const authLink = $('#authLink');
  const bell = $('#bellLink');
  const badge = $('#notifBadge');
  const menu = $('#menuToggle');
  if (balancePill) balancePill.hidden = !signedIn;
  if (bell) bell.hidden = !signedIn;
  if (menu) menu.hidden = false;
  if (authLink) {
    authLink.hidden = signedIn;
    authLink.textContent = t('nav.login');
  }
  if (signedIn) {
    const wallet = walletFor(state.displayCurrency);
    $('#balanceValue').textContent = fmt(wallet.balance ?? 0, state.displayCurrency === 'IDR' ? 0 : 2);
    $('#balanceCurrency').textContent = state.displayCurrency;
  }
  if (badge) {
    badge.hidden = !state.notifications.unread;
    badge.textContent = String(state.notifications.unread);
  }
  const conn = $('#conn');
  if (conn) {
    conn.dataset.state = state.connection;
    conn.querySelector('.conn__label').textContent =
      state.connection === 'live' ? 'live' : state.connection === 'connecting' ? 'menyambung…' : 'offline';
  }
}

// --------------------------------------------------------------- shortcuts
const shortcutHandler = (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable;
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === '?') {
    event.preventDefault();
    window.router.go('/shortcuts');
    return;
  }
  const page = window.__activePage;
  if (page?.onShortcut) page.onShortcut(key, event);
};

// --------------------------------------------------------------- bootstrap
async function bootstrap() {
  try {
    const config = await get('/api/v1/config');
    setState({
      config,
      platform: config.platform,
      displayCurrency: state.displayCurrency ?? config.activeCurrencies?.[0]?.code ?? 'IDR',
    });
    document.documentElement.style.setProperty('--accent', config.platform.accent);
    const prefersDark = !window.matchMedia?.('(prefers-color-scheme: light)').matches;
    if (!localStorage.getItem('simtrade.prefs')) applyTheme(prefersDark ? 'dark' : 'light');
    if (!localStorage.getItem('simtrade.prefs')) {
      state.language = config.platform.defaultLanguage ?? 'id';
      applyLanguage(state.language);
    }
    const title = config.platform.name ?? 'SimTrade Demo';
    document.title = `${title} · Simulasi Trading`;
    const footerVersion = $('#footerVersion');
    if (footerVersion) footerVersion.textContent = `v4 · ${config.label}`;
  } catch (error) {
    toast({ title: 'Gagal memuat konfigurasi', message: error.message, type: 'error' });
  }

  await refreshSession();
  applyLanguage(state.language);
  renderHeader();

  window.__logout = logout;
  const socket = createSocket({
    onStatus: (status) => {
      setState({ connection: status });
      renderHeader();
    },
    onMessage: (message) => {
      if (message.type === 'trade:settled') {
        const { result, payout, trade } = message;
        toast({
          title:
            result === 'win'
              ? `Trade ${trade?.market ?? ''} menang`
              : result === 'lose'
                ? `Trade ${trade?.market ?? ''} kalah`
                : `Trade ${trade?.market ?? ''} seri`,
          message:
            result === 'win'
              ? `+${payout} ${trade?.currency ?? ''} masuk ke saldo demo`
              : result === 'lose'
                ? 'Nominal stake hangus (simulasi)'
                : 'Stake dikembalikan penuh',
          type: result,
        });
        if (state.soundEnabled) beep(result);
      }
      if (message.type === 'balance' || message.type === 'account:reset') {
        setState({ wallets: message.wallets ?? state.wallets });
        renderHeader();
      }
      if (message.type === 'notification') {
        setState({ notifications: { ...state.notifications, unread: state.notifications.unread + 1 } });
        renderHeader();
      }
      window.__activePage?.onSocket?.(message);
    },
  });
  window.__socket = socket;

  window.addEventListener('keydown', shortcutHandler);

  let router;
  router = createRouter(
    [
      { path: '/', render: (ctx) => homePage(ctx, { refreshSession, renderHeader }) },
      { path: '/platform', render: () => platformPage({ variant: 'platform' }) },
      { path: '/dashboard', render: () => platformPage({ variant: 'dashboard' }) },
      { path: '/trading', render: (ctx) => tradingPage(ctx) },
      { path: '/trading/:symbol', render: (ctx) => tradingPage(ctx) },
      { path: '/market/:symbol', render: (ctx) => tradingPage(ctx) },
      { path: '/history', render: (ctx) => historyPage(ctx) },
      { path: '/account', render: (ctx) => accountPage(ctx, { refreshSession, renderHeader }) },
      { path: '/notifications', render: (ctx) => notificationsPage(ctx) },
      { path: '/login', render: (ctx) => authPage(ctx, { mode: 'login', refreshSession }) },
      { path: '/register', render: (ctx) => authPage(ctx, { mode: 'register', refreshSession }) },
      { path: '/forgot-password', render: (ctx) => authPage(ctx, { mode: 'forgot' }) },
      { path: '/reset-password', render: (ctx) => authPage(ctx, { mode: 'reset' }) },
      { path: '/verify-email', render: (ctx) => authPage(ctx, { mode: 'verify', refreshSession }) },
      { path: '/faq', render: (ctx) => contentPage(ctx, { slug: 'faq' }) },
      { path: '/terms', render: (ctx) => contentPage(ctx, { slug: 'terms' }) },
      { path: '/privacy', render: (ctx) => contentPage(ctx, { slug: 'privacy' }) },
      { path: '/contact', render: (ctx) => contentPage(ctx, { slug: 'contact' }) },
      { path: '/deposit', render: () => depositPage() },
      { path: '/withdraw', render: () => withdrawPage() },
      { path: '/payment-status', render: () => paymentStatusPage() },
      { path: '/transactions', render: () => transactionsPage() },
      { path: '/live-chat', render: () => liveChatPage() },
      { path: '/order-history', render: (ctx) => historyPage(ctx) },
      { path: '/profile-security', render: (ctx) => accountPage(ctx, { refreshSession, renderHeader }) },
      { path: '/shortcuts', render: (ctx) => contentPage(ctx, { slug: 'shortcuts' }) },
      {
        path: '/admin',
        render: (ctx) => loadAdmin(ctx, ''),
      },
      {
        path: '/admin/:section',
        render: (ctx) => loadAdmin(ctx, ctx.params.section),
      },
      {
        path: '/adminpages',
        render: (ctx) => loadAdmin(ctx, ''),
      },
      {
        path: '/adminpages/:section',
        render: (ctx) => loadAdmin(ctx, ctx.params.section),
      },
    ],
    {
      fallback: { path: '*', render: (ctx) => notFoundPage(ctx, router) },
      onBefore: (route) => {
        const needsAuth = [
          '/account',
          '/history',
          '/order-history',
          '/profile-security',
          '/notifications',
          '/platform',
          '/dashboard',
          '/deposit',
          '/withdraw',
          '/transactions',
          '/payment-status',
          '/live-chat',
        ].some((prefix) => location.pathname.startsWith(prefix));
        if (needsAuth && !state.user) {
          window.router.go('/login');
          return false;
        }
        if (
          (location.pathname.startsWith('/admin') || location.pathname.startsWith('/adminpages')) &&
          !state.user?.staffRole
        ) {
          toast({ title: 'Akses ditolak', message: 'Halaman admin hanya untuk staf.', type: 'error' });
          router.go('/');
          return false;
        }
        void route;
        return true;
      },
      onAfter: (pathname) => {
        window.__activePage?.destroy?.();
        window.__activePage = null;
        clear(view);
        view.classList.toggle('view--wide', pathname.startsWith('/admin') || pathname.startsWith('/adminpages'));
        renderNav();
        window.scrollTo({ top: 0, behavior: 'instant' });
      },
    },
  );

  window.router = router;

  $('#themeToggle')?.addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(state.theme);
    saveLocalPrefs();
  });
  $('#langToggle')?.addEventListener('click', () => {
    state.language = state.language === 'id' ? 'en' : 'id';
    applyLanguage(state.language);
    saveLocalPrefs();
  });
  $('#menuToggle')?.addEventListener('click', (event) => {
    const open = nav.classList.toggle('is-open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $('#balancePill')?.addEventListener('click', () => router.go('/account'));

  await router.start();
}

async function loadAdmin(ctx, section) {
  const { adminPage } = await import('./pages/admin.js');
  return adminPage(ctx, { section });
}

export async function refreshSession() {
  try {
    const me = await get('/api/v1/auth/me');
    if (me.user) {
      const favorites = await get('/api/v1/favorites').catch(() => ({ favorites: [] }));
      setState({
        user: me.user,
        wallets: me.wallets ?? [],
        favorites: favorites.favorites ?? [],
        displayCurrency: me.user.displayCurrency ?? 'USD',
        permissions: me.permissions ?? [],
      });
      const notifications = await get('/api/v1/notifications?limit=20').catch(() => ({ items: [], unread: 0 }));
      setState({ notifications });
      window.__socket?.auth(document.cookie.match(/sim_session=([^;]+)/)?.[1] ?? '');
    } else {
      setState({ user: null, wallets: [], favorites: [], permissions: [], notifications: { items: [], unread: 0 } });
    }
  } catch {
    setState({ user: null });
  }
  renderHeader();
  return state.user;
}

export async function logout() {
  try {
    await post('/api/v1/auth/logout', {});
  } catch {
    /* already signed out */
  }
  setState({ user: null, wallets: [], notifications: { items: [], unread: 0 }, permissions: [] });
  await refreshSession();
  window.router.go('/');
}

function beep(result) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = result === 'win' ? 880 : result === 'lose' ? 280 : 440;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch {
    /* audio is a nicety, never an error */
  }
}

subscribe(() => renderHeader());
void bootstrap();
