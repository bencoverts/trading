/** Central, tiny observable store. No framework, no dependencies. */

const listeners = new Set();

const defaults = {
  user: null,
  wallets: [],
  favorites: [],
  config: null,
  platform: null,
  permissions: [],
  csrfToken: '',
  displayCurrency: 'IDR',
  theme: 'dark',
  language: 'id',
  connection: 'offline',
  notifications: { unread: 0, items: [] },
  markets: [],
  soundEnabled: false,
  skipTradeConfirmUnder: 0,
};

export const state = { ...defaults };

export function setState(patch) {
  Object.assign(state, patch);
  notify();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a broken subscriber must not break the app */
    }
  }
}

export function walletFor(currency = state.displayCurrency) {
  return state.wallets.find((wallet) => wallet.currency === currency) ?? { currency, balance: 0, balanceMinor: 0 };
}

export function balance(currency = state.displayCurrency) {
  return walletFor(currency).balance ?? 0;
}

export function favoriteMarkets() {
  const bySymbol = new Map(state.markets.map((market) => [market.symbol, market]));
  return state.favorites.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
}

/** Preferences survive reloads (theme, language, sound). */
export function loadLocalPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('simtrade.prefs') ?? '{}');
    if (saved.theme === 'light' || saved.theme === 'dark') state.theme = saved.theme;
    if (saved.language === 'en' || saved.language === 'id') state.language = saved.language;
    if (typeof saved.sound === 'boolean') state.soundEnabled = saved.sound;
    if (typeof saved.skipTradeConfirmUnder === 'number') state.skipTradeConfirmUnder = saved.skipTradeConfirmUnder;
  } catch {
    /* ignore corrupt storage */
  }
}

export function saveLocalPrefs() {
  try {
    localStorage.setItem(
      'simtrade.prefs',
      JSON.stringify({
        theme: state.theme,
        language: state.language,
        sound: state.soundEnabled,
        skipTradeConfirmUnder: state.skipTradeConfirmUnder,
      }),
    );
  } catch {
    /* private mode: preferences simply do not persist */
  }
}
