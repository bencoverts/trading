import { get } from './api.js';

/** Small global store for session, wallets, config and the selected market. */
export const store = {
  config: null,
  account: null,
  user: null,
  wallets: [],
  markets: [],
  activeMarket: localStorage.getItem('st.market') || 'ASIA_COMPOSITE',
  displayCurrency: 'USD',
  listeners: new Set(),
};

export const isAdmin = () => store.user?.role === 'admin';

export function subscribe(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

export function notify() {
  for (const fn of store.listeners) {
    try {
      fn(store);
    } catch (err) {
      console.error(err);
    }
  }
}

export function setWallets(wallets) {
  if (!Array.isArray(wallets)) return;
  store.wallets = wallets.map((w) => ({
    currency: w.currency,
    balance: Number(w.balance ?? 0),
    balanceMinor: Number(w.balanceMinor ?? 0),
  }));
  notify();
}

export function wallet(currency = store.displayCurrency) {
  return store.wallets.find((w) => w.currency === currency) ?? { currency, balance: 0, balanceMinor: 0 };
}

export function totalInDisplay() {
  const rates = store.config?.rates ?? store.account?.rates ?? { USD: 1, IDR: 16_000, USDT: 1 };
  const target = store.displayCurrency;
  let total = 0;
  for (const w of store.wallets) {
    const usd = w.balance / (rates[w.currency] ?? 1);
    total += usd * (rates[target] ?? 1);
  }
  return Math.round(total * 100) / 100;
}

export async function loadConfig(force = false) {
  if (store.config && !force) return store.config;
  store.config = await get('/api/v1/config');
  return store.config;
}

export async function loadMarkets() {
  const res = await get('/api/v1/markets');
  store.markets = res.markets;
  if (!store.markets.some((m) => m.symbol === store.activeMarket)) {
    store.activeMarket = store.markets[0]?.symbol ?? null;
  }
  notify();
  return store.markets;
}

export async function loadSession() {
  try {
    const account = await get('/api/v1/account');
    store.account = account;
    store.user = account.user;
    store.displayCurrency = account.user.displayCurrency;
    setWallets(account.wallets);
    return account;
  } catch (err) {
    if (err.status === 401) {
      store.account = null;
      store.user = null;
      store.wallets = [];
      notify();
      return null;
    }
    throw err;
  }
}

export function setMarket(symbol) {
  store.activeMarket = symbol;
  localStorage.setItem('st.market', symbol);
  notify();
}

export function setDisplayCurrency(currency) {
  store.displayCurrency = currency;
  notify();
}
