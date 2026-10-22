import { get } from '../api.js';
import { state } from '../store.js';
import { $, clear, el, emptyState, fmt, marketLogo, skeleton, toast } from '../ui.js';

export async function homePage(ctx, { refreshSession } = {}) {
  const root = $('#view');
  clear(root);
  root.append(renderHero());

  const marketSection = el('section', {});
  marketSection.append(skeleton(3));
  root.append(marketSection);
  root.append(renderFeatures());

  try {
    const [marketsRes, bannersRes] = await Promise.all([
      get('/api/v1/markets'),
      get('/api/v1/banners').catch(() => ({ banners: [] })),
    ]);
    marketsRes.markets.forEach((market) => {
      window.__marketCache = window.__marketCache ?? new Map();
      window.__marketCache.set(market.symbol, market);
    });
    clear(marketSection);
    marketSection.append(renderMarketBoard(marketsRes.markets));
    if (bannersRes.banners?.length) root.prepend(renderBanner(bannersRes.banners[0]));
  } catch (error) {
    clear(marketSection);
    marketSection.append(el('div', { class: 'alert alert--error' }, error.message));
  }

  if (!state.user) {
    const cta = el(
      'div',
      { class: 'card', style: { marginTop: 'var(--space-5)' } },
      el('h2', { style: { marginTop: 0 } }, 'Coba tanpa risiko'),
      el(
        'p',
        { class: 'dim' },
        'Buat akun demo untuk mendapatkan saldo virtual USD, IDR, dan USDT. Tidak ada pembayaran sama sekali.',
      ),
      el(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        el('a', { class: 'btn btn--primary', href: '/register', 'data-link': '' }, 'Buat akun demo'),
        el('a', { class: 'btn btn--ghost', href: '/login', 'data-link': '' }, 'Masuk'),
      ),
    );
    root.append(cta);
  }
  void refreshSession;
  void toast;
  void ctx;
}

function renderHero() {
  return el(
    'section',
    { class: 'hero' },
    el(
      'div',
      {},
      el('span', { class: 'pill pill--warn' }, 'SIMULASI / DEMO'),
      el('h1', {}, 'Latih strategi biner di ', el('em', {}, 'pasar simulasi'), ' yang jujur.'),
      el(
        'p',
        {},
        'Harga dihasilkan server simulasi kami sendiri, hasil trade ditentukan dari data yang tercatat, dan setiap perubahan parameter admin terlihat di riwayat market. Tidak ada uang sungguhan.',
      ),
      el(
        'div',
        { class: 'hero__actions' },
        el('a', { class: 'btn btn--primary', href: '/trading', 'data-link': '' }, 'Mulai trading demo'),
        el('a', { class: 'btn btn--ghost', href: '/faq', 'data-link': '' }, 'Baca FAQ'),
      ),
    ),
    el(
      'div',
      { class: 'hero__panel' },
      el('div', { class: 'card__title' }, 'Ringkasan demo'),
      el(
        'div',
        { class: 'hero__stats' },
        el('div', { class: 'hero__stat' }, el('b', {}, '3'), el('span', {}, 'market awal')),
        el('div', { class: 'hero__stat' }, el('b', {}, '85%'), el('span', {}, 'payout default')),
        el('div', { class: 'hero__stat' }, el('b', {}, '13'), el('span', {}, 'durasi preset')),
      ),
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px', marginTop: '12px' } },
        'Saldo awal virtual: USD 1.000 · IDR 15.000.000 · USDT 1.000. Semua angka dapat diatur admin.',
      ),
    ),
  );
}

function renderBanner(banner) {
  return el(
    'div',
    { class: 'alert', style: { marginBottom: 'var(--space-4)' } },
    el('span', { class: 'pill pill--warn' }, 'INFO'),
    el('span', {}, el('strong', {}, banner.title), banner.body ? ` — ${banner.body}` : ''),
    banner.link ? el('a', { href: banner.link, 'data-link': '', class: 'dim' }, 'Selengkapnya') : null,
  );
}

function renderMarketBoard(markets) {
  const section = el('section', {});
  section.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Market simulasi'), el('p', {}, 'Klik market untuk membuka chart dan panel trade.')),
      el('a', { class: 'btn btn--ghost btn--sm', href: '/trading', 'data-link': '' }, 'Buka terminal trading'),
    ),
  );
  if (!markets.length) {
    section.append(emptyState('Belum ada market aktif', 'Admin dapat menambahkan market baru dari panel admin.'));
    return section;
  }
  const grid = el('div', { class: 'grid grid--3' });
  for (const market of markets) {
    const change = market.ticker?.change24hPercent;
    grid.append(
      el(
        'a',
        { class: 'market-card', href: `/trading/${market.symbol}`, 'data-link': '' },
        marketLogo(market, 'logo--lg'),
        el(
          'div',
          { class: 'market-card__body' },
          el('div', { class: 'market-card__title' }, market.name),
          el(
            'div',
            { class: 'market-card__sub' },
            market.category,
            ' · ',
            market.status === 'active' ? 'aktif' : market.status,
            market.featured ? ' · unggulan' : '',
          ),
        ),
        el(
          'div',
          { class: 'market-card__price' },
          market.ticker?.price === null || market.ticker?.price === undefined
            ? '—'
            : fmt(market.ticker.price, market.priceDecimals),
          el(
            'span',
            {
              class: `market-item__chg ${change > 0 ? 'up' : change < 0 ? 'down' : 'muted'}`,
            },
            change === null || change === undefined ? '' : `${change > 0 ? '+' : ''}${fmt(change, 2)}%`,
          ),
        ),
      ),
    );
  }
  section.append(grid);
  return section;
}

function renderFeatures() {
  const items = [
    [
      '01',
      'Chart realtime',
      'Candlestick, line, dan area dengan zoom, pan, crosshair, serta countdown candle dari server.',
    ],
    [
      '02',
      'Trade transparan',
      'Entry price dari server, expiry = waktu server + durasi, hasil dihitung dari harga tercatat.',
    ],
    ['03', 'Saldo virtual', 'USD, IDR, dan USDT dengan konversi demo. Top-up virtual dibatasi dan tercatat di ledger.'],
    [
      '04',
      'Kontrol admin',
      'Parameter simulasi (tren, volatilitas, mood, pause) dicatat di riwayat market yang publik.',
    ],
  ];
  return el(
    'section',
    { class: 'feature-grid' },
    ...items.map(([num, title, body]) =>
      el(
        'article',
        { class: 'feature' },
        el('div', { class: 'feature__icon' }, num),
        el('h3', {}, title),
        el('p', {}, body),
      ),
    ),
  );
}
