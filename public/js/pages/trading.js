import { get, post } from '../api.js';
import { createChart } from '../chart.js';
import { t } from '../i18n.js';
import { favoriteMarkets, saveLocalPrefs, setState, state, walletFor } from '../store.js';
import { $, clear, debounce, durationLabel, el, emptyState, fmt, marketLogo, money, openSheet, toast } from '../ui.js';

const TIMEFRAMES = [
  ['5s', 5_000],
  ['15s', 15_000],
  ['30s', 30_000],
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
];

const DURATION_FALLBACK = [5, 10, 15, 30, 60, 120, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800];

/**
 * Trading terminal. Every price shown here comes from the server (REST snapshot
 * + WebSocket stream); the client never invents quotes.
 */
export async function tradingPage(ctx) {
  const root = $('#view');
  clear(root);
  const config = state.config;
  const marketsRes = await get('/api/v1/markets').catch(() => ({ markets: [] }));
  const markets = marketsRes.markets ?? [];
  setState({ markets });
  if (!markets.length) {
    root.append(emptyState('Belum ada market aktif', 'Hubungi admin untuk mengaktifkan market.'));
    return;
  }

  const initialSymbol = (ctx.params?.symbol ?? markets[0].symbol).toUpperCase();
  const page = { symbol: markets.some((m) => m.symbol === initialSymbol) ? initialSymbol : markets[0].symbol };
  const market = () => state.markets.find((m) => m.symbol === page.symbol) ?? markets[0];

  const search = { text: '', category: 'all' };
  const order = { favorites: true };
  const panel = { amount: '', duration: config?.durations?.allowed?.[0] ?? 5, manual: '', direction: null };

  // -------------------------------------------------------------- layout
  const marketCol = el('aside', { class: 'market-col card' });
  const marketList = el('div', { class: 'market-list' });
  marketCol.append(
    el(
      'div',
      { class: 'card__head' },
      el('h2', { class: 'card__title' }, 'Pilih market'),
      el('span', { class: 'pill pill--warn' }, 'SIM'),
    ),
    el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Cari market…',
      'aria-label': 'Cari market',
      onInput: debounce((event) => {
        search.text = event.target.value.toLowerCase();
        renderMarketList();
      }, 120),
    }),
    el('div', { class: 'chip-row', style: { margin: '10px 0' } }),
    marketList,
  );
  const categoryRow = marketCol.querySelector('.chip-row');
  const categories = ['all', ...new Set(markets.map((m) => m.category))];
  for (const category of categories) {
    categoryRow.append(
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(category === 'all'),
          onClick: (event) => {
            search.category = category;
            [...categoryRow.children].forEach((chip) =>
              chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
            );
            renderMarketList();
          },
        },
        category === 'all' ? 'Semua' : category,
      ),
    );
  }

  const chartCanvas = el('canvas', { role: 'img', 'aria-label': 'Chart harga simulasi' });
  const chartWrap = el('div', { class: 'chart-canvas-wrap' }, chartCanvas);
  const priceValue = el('span', { class: 'price-headline__value mono' }, '—');
  const priceChange = el('span', { class: 'pill pill--muted' }, '—');
  const marketTitle = el('div', {});
  const ohlc = el('span', { class: 'mono muted' }, '');
  const candleCountdown = el('span', { class: 'mono muted' }, '');
  const liveDot = el('span', { class: 'pill pill--up' }, 'live');

  const typeButtons = ['candle', 'line', 'area'].map((type) =>
    el(
      'button',
      { class: 'chip', type: 'button', 'aria-pressed': String(type === 'candle'), onClick: () => setType(type) },
      type,
    ),
  );
  const tfButtons = TIMEFRAMES.map(([label]) =>
    el(
      'button',
      { class: 'chip', type: 'button', 'aria-pressed': String(label === '1m'), onClick: () => setTimeframe(label) },
      label,
    ),
  );

  const chartCard = el(
    'section',
    { class: 'chart-card' },
    el(
      'div',
      { class: 'price-headline' },
      marketTitle,
      priceValue,
      priceChange,
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
    ),
    el(
      'div',
      { class: 'chart-toolbar' },
      ...typeButtons,
      el('span', { class: 'spacer' }),
      ...tfButtons,
      liveDot,
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => chart.goLive() }, 'Live'),
    ),
    chartWrap,
    el(
      'div',
      { class: 'chart-meta' },
      ohlc,
      candleCountdown,
      el('span', { class: 'muted' }, 'Gulir = zoom · geser = pan · hover = crosshair'),
    ),
  );

  const panelCol = el('div', { class: 'trade-panel-col' });
  const tradePanel = buildTradePanel({
    panel,
    market,
    onSubmit: submitTrade,
    onQuickAmount: (value) => setAmount(value),
  });
  panelCol.append(tradePanel.node);

  const activeCard = el('section', { class: 'card', style: { marginTop: 'var(--space-4)' } });
  const historyCard = el('section', { class: 'card', style: { marginTop: 'var(--space-4)' } });

  const layout = el(
    'div',
    { class: 'trade-layout' },
    marketCol,
    el('div', {}, chartCard, activeCard, historyCard),
    panelCol,
  );

  const sheetHost = el('div', {});
  const mobileBar = el(
    'div',
    { class: 'mobile-trade-bar' },
    el('button', { class: 'btn btn--up btn--trade', type: 'button', onClick: () => openTradeSheet('up') }, 'BELI'),
    el('button', { class: 'btn btn--down btn--trade', type: 'button', onClick: () => openTradeSheet('down') }, 'JUAL'),
  );

  root.append(layout, sheetHost, mobileBar);

  // -------------------------------------------------------------- chart
  const chart = createChart(chartCanvas, { type: 'candle' });
  if (chart.setTheme) chart.setTheme(state.theme);
  chart.setTimeframe('1m', 60_000);
  chart.onHover = ({ candle }) => {
    if (!candle) return;
    ohlc.textContent = `O ${fmt(candle.o, market().priceDecimals)}  H ${fmt(candle.h, market().priceDecimals)}  L ${fmt(candle.l, market().priceDecimals)}  C ${fmt(candle.c, market().priceDecimals)}`;
  };

  let activeTrades = [];
  let timer = null;
  let lastCandleTick = 0;

  function setType(type) {
    chart.setType(type);
    typeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.textContent === type)));
  }

  async function setTimeframe(tf) {
    tfButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.textContent === tf)));
    const ms = TIMEFRAMES.find(([label]) => label === tf)?.[1] ?? 60_000;
    chart.setTimeframe(tf, ms);
    const data = await get(`/api/v1/markets/${page.symbol}/candles?tf=${tf}&limit=300`).catch(() => null);
    if (data) {
      chart.setData(data.candles);
      if (data.current) chart.applyCandle(data.current);
    }
    window.__socket?.subscribe(page.symbol, tf);
  }

  // -------------------------------------------------------------- markets
  function renderMarketList() {
    clear(marketList);
    const favorites = new Set(state.favorites);
    let list = markets.filter((m) => {
      const matchText =
        !search.text || m.symbol.toLowerCase().includes(search.text) || m.name.toLowerCase().includes(search.text);
      const matchCategory = search.category === 'all' || m.category === search.category;
      return matchText && matchCategory;
    });
    list = [...list].sort((a, b) => {
      if (order.favorites) {
        const favA = favorites.has(a.symbol) ? 1 : 0;
        const favB = favorites.has(b.symbol) ? 1 : 0;
        if (favA !== favB) return favB - favA;
      }
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    });
    if (!list.length) {
      marketList.append(emptyState('Market tidak ditemukan', 'Coba kata kunci atau kategori lain.'));
      return;
    }
    for (const item of list) {
      const price = item.ticker?.price;
      const change = item.ticker?.change24hPercent;
      const row = el(
        'button',
        {
          class: 'market-item',
          type: 'button',
          'aria-current': String(item.symbol === page.symbol),
          dataset: { symbol: item.symbol },
        },
        marketLogo(item),
        el(
          'span',
          { class: 'market-item__body' },
          el('span', { class: 'market-item__name' }, item.name),
          el(
            'span',
            { class: 'market-item__sub' },
            item.symbol,
            favorites.has(item.symbol) ? ' ★' : '',
            item.status !== 'active' ? ` · ${item.status}` : '',
          ),
        ),
        el(
          'span',
          { class: 'market-item__price' },
          price === null || price === undefined ? '—' : fmt(price, item.priceDecimals),
          el(
            'span',
            { class: `market-item__chg ${change > 0 ? 'up' : change < 0 ? 'down' : 'muted'}` },
            change === null || change === undefined ? '' : `${change > 0 ? '+' : ''}${fmt(change, 2)}%`,
          ),
        ),
      );
      row.addEventListener('click', () => selectMarket(item.symbol));
      marketList.append(row);
    }
  }

  async function selectMarket(symbol) {
    if (symbol === page.symbol) return;
    page.symbol = symbol;
    history.replaceState({}, '', `/trading/${symbol}`);
    renderMarketList();
    await loadMarket();
    await refreshTrades();
  }

  async function loadMarket() {
    const m = market();
    marketTitle.replaceChildren(
      el(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        marketLogo(m, 'logo--lg'),
        el(
          'div',
          {},
          el('div', { style: { fontWeight: '600', fontSize: '15px' } }, m.name),
          el(
            'div',
            { class: 'muted', style: { fontSize: '11px', letterSpacing: '0.05em' } },
            `${m.symbol} · ${m.category} · ${m.status === 'active' ? 'aktif' : m.status}`,
          ),
        ),
      ),
    );
    chart.setDecimals(m.priceDecimals);
    const detail = await get(`/api/v1/markets/${m.symbol}`).catch(() => null);
    if (detail) {
      chart.setData(detail.candles ?? []);
      if (detail.current) chart.applyCandle(detail.current);
      applyTicker(detail.ticker ?? {});
    }
    window.__socket?.subscribe(m.symbol, '1m');
    tfButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.textContent === '1m')));
    chart.setTimeframe('1m', 60_000);
    panel.duration = (state.config?.durations?.allowed ?? DURATION_FALLBACK).includes(panel.duration)
      ? panel.duration
      : (state.config?.durations?.allowed ?? DURATION_FALLBACK)[0];
    tradePanel.refresh();
    chart.setMarkers(
      activeTrades
        .filter((trade) => trade.market === m.symbol)
        .map((trade) => ({
          price: trade.entryPrice,
          color: trade.direction === 'up' ? '#2ee6a8' : '#ff5c78',
          label: trade.direction === 'up' ? 'UP' : 'DOWN',
          open: true,
          expiryTime: trade.expiryTime,
        })),
    );
  }

  function applyTicker(ticker) {
    const m = market();
    if (ticker.price !== null && ticker.price !== undefined) {
      priceValue.textContent = fmt(ticker.price, m.priceDecimals);
      priceValue.className = `price-headline__value mono ${ticker.change24h >= 0 ? 'up' : 'down'}`;
    }
    if (ticker.change24hPercent === null || ticker.change24hPercent === undefined) {
      priceChange.className = 'pill pill--muted';
      priceChange.textContent = '24j —';
    } else {
      const up = ticker.change24hPercent >= 0;
      priceChange.className = `pill ${up ? 'pill--up' : 'pill--down'}`;
      priceChange.textContent = `${up ? '+' : ''}${fmt(ticker.change24hPercent, 2)}% 24j`;
    }
    candleCountdown.textContent = `server ${new Date(ticker.serverTime ?? Date.now()).toLocaleTimeString('id-ID')}`;
  }

  // -------------------------------------------------------------- trade panel
  function setAmount(value) {
    panel.amount = value === '' ? '' : String(value);
    tradePanel.setAmount(panel.amount);
    tradePanel.refresh();
  }

  function buildTradePanel() {
    const balanceRow = el('div', { class: 'trade-summary' });
    const amountInput = el('input', {
      class: 'input',
      type: 'text',
      inputmode: 'decimal',
      'aria-label': 'Nominal trade',
      placeholder: '10',
      value: panel.amount,
      onInput: (event) => {
        panel.amount = event.target.value.replace(/[^0-9.,]/g, '').replace(',', '.');
        event.target.value = panel.amount;
        refresh();
      },
    });
    const amountBox = el(
      'div',
      { class: 'amount-input' },
      amountInput,
      el('span', { class: 'amount-input__ccy' }, state.displayCurrency),
    );
    const quickRow = el('div', { class: 'quick-amounts' });
    const durationRow = el('div', { class: 'chip-row' });
    const manualRow = el('input', {
      class: 'input',
      type: 'number',
      min: '5',
      max: '28800',
      placeholder: 'Detik manual (5–28800)',
      'aria-label': 'Durasi manual dalam detik',
    });
    const summary = el('div', { class: 'trade-summary' });
    const warning = el('div', { class: 'alert alert--warn hidden' });
    const buyBtn = el('button', { class: 'btn btn--up btn--trade', type: 'button' }, t('action.buy'));
    const sellBtn = el('button', { class: 'btn btn--down btn--trade', type: 'button' }, t('action.sell'));
    const favoriteBtn = el(
      'button',
      { class: 'icon-btn', type: 'button', title: 'Favorit', 'aria-label': 'Tandai favorit' },
      '☆',
    );

    const allowed = state.config?.durations?.allowed ?? DURATION_FALLBACK;
    for (const duration of allowed) {
      durationRow.append(
        el(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(Number(panel.duration) === duration),
            onClick: (event) => {
              panel.duration = duration;
              panel.manual = '';
              manualRow.value = '';
              [...durationRow.children].forEach((chip) =>
                chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
              );
              refresh();
            },
          },
          durationLabel(duration),
        ),
      );
    }
    manualRow.addEventListener('input', () => {
      const value = Number(manualRow.value);
      if (!Number.isInteger(value) || value < 5 || value > 28_800) return;
      panel.duration = value;
      [...durationRow.children].forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
      refresh();
    });

    const node = el(
      'section',
      { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { class: 'card__title' }, 'Panel trade'), favoriteBtn),
      balanceRow,
      el(
        'div',
        { class: 'field', style: { marginTop: '10px' } },
        el('label', { for: 'trade-amount' }, 'Nominal'),
        amountBox,
        quickRow,
      ),
      el('div', { class: 'field' }, el('label', {}, 'Durasi'), durationRow, manualRow),
      summary,
      warning,
      el('div', { class: 'direction-toggle', style: { marginTop: 'var(--space-3)' } }, buyBtn, sellBtn),
      el(
        'p',
        { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } },
        'Hasil ditentukan server dari harga tercatat saat expiry. Simulasi, bukan investasi.',
      ),
    );

    buyBtn.addEventListener('click', () => submitTrade('up'));
    sellBtn.addEventListener('click', () => submitTrade('down'));
    favoriteBtn.addEventListener('click', async () => {
      try {
        const res = await post(`/api/v1/favorites/${page.symbol}`, {});
        setState({ favorites: res.favorites });
        renderMarketList();
        refresh();
      } catch (error) {
        toast({ title: 'Gagal memperbarui favorit', message: error.message, type: 'error' });
      }
    });

    function amountValue() {
      const numeric = Number(String(panel.amount).replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(numeric) ? numeric : 0;
    }

    function refresh() {
      const m = market();
      const wallet = walletFor(state.displayCurrency);
      clear(balanceRow);
      balanceRow.append(
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Saldo demo'),
          el('strong', { class: 'mono' }, money(wallet.balance, state.displayCurrency)),
        ),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Min / maks'),
          el(
            'span',
            { class: 'mono' },
            m.minAmount ? money(m.minAmount, 'USD') : '—',
            ' / ',
            m.maxAmount ? money(m.maxAmount, 'USD') : '—',
          ),
        ),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Payout'),
          el('span', { class: 'mono' }, `${fmt(payoutRate() * 100, 0)}%`),
        ),
      );

      clear(quickRow);
      const decimals = state.displayCurrency === 'IDR' ? 0 : 2;
      const half = Math.floor((wallet.balance ?? 0) * 50) / 100;
      const quick = [
        ['+', () => setAmount((amountValue() + (state.displayCurrency === 'IDR' ? 10_000 : 10)).toFixed(decimals))],
        [
          '−',
          () =>
            setAmount(Math.max(0, amountValue() - (state.displayCurrency === 'IDR' ? 10_000 : 10)).toFixed(decimals)),
        ],
        ['½', () => setAmount((half || 0).toFixed(decimals))],
        [
          '×2',
          () => setAmount(((amountValue() || (state.displayCurrency === 'IDR' ? 10_000 : 10)) * 2).toFixed(decimals)),
        ],
        ['maks', () => setAmount(Math.max(0, wallet.balance ?? 0).toFixed(decimals))],
      ];
      for (const [label, action] of quick) {
        quickRow.append(el('button', { class: 'chip', type: 'button', onClick: action, 'aria-label': label }, label));
      }

      const rate = payoutRate();
      const amount = amountValue();
      const profit = amount * rate;
      clear(summary);
      summary.append(
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Entry (perkiraan)'),
          el('span', { class: 'mono' }, fmt(m.ticker?.price ?? 0, m.priceDecimals)),
        ),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Expiry'),
          el(
            'span',
            { class: 'mono' },
            `${durationLabel(Number(panel.duration))} · ${new Date(Date.now() + Number(panel.duration) * 1000).toLocaleTimeString('id-ID')}`,
          ),
        ),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Payout'),
          el('span', { class: 'mono' }, `${money(amount + profit, state.displayCurrency)} (${fmt(rate * 100, 0)}%)`),
        ),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Potensi profit'),
          el('span', { class: 'mono up' }, money(profit, state.displayCurrency)),
        ),
      );

      const min = m.minAmount ?? 1;
      const maxUsd = m.maxAmount ?? 1_000;
      const limit =
        state.displayCurrency === 'USD' ? maxUsd : state.displayCurrency === 'IDR' ? maxUsd * 16_000 : maxUsd;
      const minLimit = state.displayCurrency === 'USD' ? min : state.displayCurrency === 'IDR' ? min * 16_000 : min;
      const outOfRange = amount > 0 && (amount < minLimit || amount > limit);
      const notEnough = amount > (wallet.balance ?? 0);
      warning.classList.toggle('hidden', !(outOfRange || notEnough));
      clear(warning);
      if (outOfRange) {
        warning.append(
          el('strong', {}, 'Nominal di luar batas. '),
          `Gunakan antara ${money(minLimit, state.displayCurrency)} dan ${money(limit, state.displayCurrency)}.`,
        );
      } else if (notEnough) {
        warning.append(
          el('strong', {}, 'Saldo demo tidak cukup. '),
          'Kurangi nominal atau top-up demo dari halaman akun.',
        );
      }
      window.__tradePanel = { amountValue, minLimit, limit, rate };
      buyBtn.disabled = Boolean(outOfRange || notEnough || amount <= 0 || m.status !== 'active');
      sellBtn.disabled = buyBtn.disabled;
      favoriteBtn.textContent = state.favorites.includes(page.symbol) ? '★' : '☆';
      return summary;
    }

    function payoutRate() {
      const m = market();
      if (m.payoutRate !== null && m.payoutRate !== undefined) return Number(m.payoutRate);
      const byDuration = state.config?.payout?.byDuration ?? {};
      return Number(byDuration[String(panel.duration)] ?? state.config?.payout?.rate ?? 0.85);
    }

    return {
      node,
      refresh,
      setAmount: (value) => {
        amountInput.value = value;
      },
      amountValue,
    };
  }

  async function submitTrade(direction, { skipConfirm } = {}) {
    if (!state.user) {
      toast({ title: 'Masuk dulu', message: 'Buat akun demo untuk membuka trade.', type: 'info' });
      window.router.go('/login');
      return;
    }
    const amount = tradePanel.amountValue();
    if (!amount || amount <= 0) {
      toast({ title: 'Nominal belum diisi', message: 'Masukkan nominal trade dulu.', type: 'error' });
      return;
    }
    const m = market();
    if (!skipConfirm && amount > (state.skipTradeConfirmUnder || 0)) {
      const confirmed = await confirmTrade({ direction, amount, market: m });
      if (!confirmed) return;
    }
    try {
      const res = await post(
        '/api/v1/trades',
        {
          market: m.symbol,
          direction,
          currency: state.displayCurrency,
          amount,
          durationSec: Number(panel.duration),
        },
        { idempotency: `trade-${globalThis.crypto?.randomUUID?.() ?? Date.now()}` },
      );
      setState({ wallets: res.wallets });
      toast({
        title: `Trade ${direction === 'up' ? 'NAIK' : 'TURUN'} dibuka`,
        message: `${money(amount, state.displayCurrency)} · ${durationLabel(Number(panel.duration))} · entry ${fmt(res.trade.entryPrice, m.priceDecimals)}`,
        type: 'info',
      });
      await refreshTrades();
    } catch (error) {
      toast({ title: 'Trade gagal', message: error.message, type: 'error', timeout: 6000 });
    }
  }

  function confirmTrade({ direction, amount, market: m }) {
    return new Promise((resolve) => {
      const skip = el('input', { type: 'checkbox' });
      const ok = el('button', { class: 'btn btn--primary', type: 'button' }, t('action.confirm'));
      const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, t('action.cancel'));
      const dialog = el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('trade.confirmTitle') },
        el('h2', {}, t('trade.confirmTitle')),
        el(
          'div',
          { class: 'trade-summary' },
          el('div', {}, el('span', { class: 'muted' }, t('common.market')), el('span', {}, m.name)),
          el(
            'div',
            {},
            el('span', { class: 'muted' }, t('common.direction')),
            el('span', { class: direction === 'up' ? 'up' : 'down' }, direction === 'up' ? 'NAIK' : 'TURUN'),
          ),
          el(
            'div',
            {},
            el('span', { class: 'muted' }, t('common.amount')),
            el('span', { class: 'mono' }, money(amount, state.displayCurrency)),
          ),
          el(
            'div',
            {},
            el('span', { class: 'muted' }, t('common.duration')),
            el('span', { class: 'mono' }, durationLabel(Number(panel.duration))),
          ),
          el(
            'div',
            {},
            el('span', { class: 'muted' }, 'Payout'),
            el('span', { class: 'mono' }, `${fmt((window.__tradePanel?.rate ?? 0.85) * 100, 0)}%`),
          ),
        ),
        el('label', { class: 'checkbox', style: { marginTop: '12px' } }, skip, el('span', {}, t('trade.dontAsk'))),
        el('div', { class: 'modal__actions' }, cancel, ok),
      );
      const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
      document.getElementById('modalHost').append(backdrop);
      const finish = (value) => {
        backdrop.remove();
        resolve(value);
      };
      if (skip.checked) {
        state.skipTradeConfirmUnder = Math.max(state.skipTradeConfirmUnder, amount);
        saveLocalPrefs();
      }
      skip.addEventListener('change', () => {
        if (skip.checked) {
          state.skipTradeConfirmUnder = Math.max(state.skipTradeConfirmUnder, amount);
          saveLocalPrefs();
        }
      });
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(false);
      });
      document.addEventListener('keydown', function onKey(event) {
        if (event.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          finish(false);
        }
      });
      ok.focus();
    });
  }

  function openTradeSheet(direction) {
    const clone = tradePanel.node.cloneNode(true);
    const sheet = openSheet('Panel trade', clone);
    // the clone is visual only: wire its buttons to the real panel actions
    clone.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => sheet.close());
    });
    clone.querySelectorAll('button.btn--up').forEach((button) =>
      button.addEventListener('click', () => {
        sheet.close();
        submitTrade('up', { skipConfirm: direction === 'up' });
      }),
    );
    clone.querySelectorAll('button.btn--down').forEach((button) =>
      button.addEventListener('click', () => {
        sheet.close();
        submitTrade('down', { skipConfirm: direction === 'down' });
      }),
    );
  }

  // -------------------------------------------------------------- trades
  async function refreshTrades() {
    if (!state.user) {
      activeCard.replaceChildren(
        el('h2', { class: 'card__title' }, t('trade.active')),
        emptyState('Masuk untuk melihat trade', 'Trade hanya tersedia untuk akun demo yang sudah masuk.'),
      );
      return;
    }
    const [activeRes, historyRes] = await Promise.all([
      get('/api/v1/trades/active').catch(() => ({ trades: [] })),
      get('/api/v1/trades?limit=6').catch(() => ({ trades: [] })),
    ]);
    activeTrades = activeRes.trades ?? [];
    activeCard.replaceChildren(
      el(
        'div',
        { class: 'card__head' },
        el('h2', { class: 'card__title' }, t('trade.active')),
        el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
      ),
    );
    if (!activeTrades.length) {
      activeCard.append(
        emptyState(t('trade.noActive'), 'Buka trade dari panel kanan untuk melihat countdown di sini.'),
      );
    } else {
      for (const trade of activeTrades) activeCard.append(renderActiveTrade(trade));
    }
    chart.setMarkers(
      activeTrades.map((trade) => ({
        price: trade.entryPrice,
        color: trade.direction === 'up' ? '#2ee6a8' : '#ff5c78',
        label: trade.direction === 'up' ? 'UP' : 'DOWN',
        open: true,
        expiryTime: trade.expiryTime,
      })),
    );

    historyCard.replaceChildren(
      el(
        'div',
        { class: 'card__head' },
        el('h2', { class: 'card__title' }, 'Trade terakhir'),
        el('a', { class: 'btn btn--ghost btn--sm', href: '/history', 'data-link': '' }, 'Semua riwayat'),
      ),
    );
    const trades = historyRes.trades ?? [];
    if (!trades.length) historyCard.append(emptyState('Belum ada trade', 'Riwayat trade akan muncul di sini.'));
    for (const trade of trades) {
      historyCard.append(
        el(
          'div',
          { class: 'trade-row' },
          el(
            'div',
            {},
            el(
              'div',
              { style: { fontWeight: '600' } },
              `${trade.market} · ${trade.direction === 'up' ? 'NAIK' : 'TURUN'}`,
            ),
            el(
              'div',
              { class: 'trade-row__meta' },
              `${money(trade.amount, trade.currency)} · ${durationLabel(trade.durationSec)}`,
              el('span', { class: 'muted' }, new Date(trade.createdAt).toLocaleString('id-ID')),
            ),
          ),
          el(
            'div',
            { class: 'right' },
            el(
              'span',
              {
                class: `pill ${trade.result === 'win' ? 'pill--up' : trade.result === 'lose' ? 'pill--down' : trade.result === 'draw' ? 'pill--warn' : 'pill--muted'}`,
              },
              trade.result === 'win'
                ? 'menang'
                : trade.result === 'lose'
                  ? 'kalah'
                  : trade.result === 'draw'
                    ? 'seri'
                    : 'terbuka',
            ),
            el(
              'div',
              { class: 'muted', style: { fontSize: '11px' } },
              trade.status === 'closed'
                ? money(trade.payout ?? 0, trade.currency)
                : `→ ${fmt(trade.estimatedPayout ?? 0, 2)}`,
            ),
          ),
        ),
      );
    }
  }

  function renderActiveTrade(trade) {
    const row = el('div', { class: 'trade-row' });
    const countdown = el('span', { class: 'countdown' }, '—');
    const live = el('span', { class: 'pill pill--muted' }, '—');
    const estimated = el('span', { class: 'mono' }, '—');
    row.append(
      el(
        'div',
        {},
        el('div', { style: { fontWeight: '600' } }, `${trade.market} · ${trade.direction === 'up' ? 'NAIK' : 'TURUN'}`),
        el(
          'div',
          { class: 'trade-row__meta' },
          `${money(trade.amount, trade.currency)} · ${durationLabel(trade.durationSec)} · entry ${fmt(trade.entryPrice, 4)}`,
        ),
      ),
      el(
        'div',
        { class: 'right' },
        countdown,
        el('div', {}, live),
        el('div', { style: { fontSize: '11px' } }, estimated),
      ),
    );
    const update = () => {
      const remaining = Math.max(0, trade.expiryTime - Date.now());
      countdown.textContent = `${Math.floor(remaining / 1000)}s`;
      const price = trade.livePrice ?? market().ticker?.price ?? trade.entryPrice;
      const winning = trade.direction === 'up' ? price >= trade.entryPrice : price <= trade.entryPrice;
      live.className = `pill ${winning ? 'pill--up' : 'pill--down'}`;
      live.textContent = winning ? 'di jalur menang' : 'di jalur kalah';
      estimated.textContent = `≈ ${money(trade.estimatedPayout ?? 0, trade.currency)}`;
      if (remaining === 0) clearInterval(handle);
    };
    update();
    const handle = setInterval(update, 500);
    return row;
  }

  // -------------------------------------------------------------- live data
  window.__activePage = {
    destroy() {
      clearInterval(timer);
      window.__socket?.unsubscribe();
    },
    onSocket(message) {
      if (!message?.type) return;
      if (message.type === 'tick' && message.symbol === page.symbol) {
        chart.push(message.price, message.time);
        priceValue.textContent = fmt(message.price, market().priceDecimals);
        const now = performance.now();
        if (now - lastCandleTick > 300) {
          lastCandleTick = now;
          const liveTrade = activeTrades[0];
          if (liveTrade) {
            liveTrade.livePrice = message.price;
          }
        }
      }
      if (message.type === 'candle' && message.symbol === page.symbol) chart.applyCandle(message.candle);
      if (message.type === 'candle_closed' && message.symbol === page.symbol) chart.closeCandle(message.candle);
      if (message.type === 'trade:settled' || message.type === 'trade:opened') void refreshTrades();
      if (message.type === 'market_status' && message.symbol === page.symbol) {
        loadMarket();
      }
    },
    onShortcut(key) {
      if (key === 'b') submitTrade('up');
      if (key === 's') submitTrade('down');
      if (key === 'l') chart.goLive();
      if (key === 't') {
        const index = TIMEFRAMES.findIndex(
          ([label]) => tfButtons.find((b) => b.textContent === label)?.getAttribute('aria-pressed') === 'true',
        );
        const next = TIMEFRAMES[(index + 1) % TIMEFRAMES.length][0];
        void setTimeframe(next);
      }
    },
  };

  renderMarketList();
  await loadMarket();
  tradePanel.setAmount('');
  tradePanel.refresh();
  await refreshTrades();
  timer = setInterval(() => {
    candleCountdown.textContent = `${new Date().toLocaleTimeString('id-ID')} · ${TIMEFRAMES.find(([label]) => tfButtons.find((b) => b.textContent === label)?.getAttribute('aria-pressed') === 'true')?.[0] ?? '1m'}`;
  }, 1000);
  void favoriteMarkets;
}
