/**
 * Signed-in home (`/platform`) and account dashboard (`/dashboard`).
 * Read-only overview: balances come from the session payload, trades and money
 * history from the API. Nothing here can change a balance.
 */

import { get } from '../api.js';
import { state } from '../store.js';
import { $, clear, dateTime, el, emptyState, fmt, marketLogo, money, relativeTime, statusPill } from '../ui.js';

const quickAction = (label, hint, href, icon) =>
  el(
    'a',
    { class: 'quick-action card', href, 'data-link': '' },
    el('span', { class: 'quick-action__icon', 'aria-hidden': 'true' }, icon),
    el('span', {}, el('strong', {}, label), el('span', { class: 'small muted' }, hint)),
  );

export async function platformPage({ variant = 'platform' } = {}) {
  if (!state.user) {
    window.router.go('/login');
    return;
  }
  const root = $('#view');
  clear(root);

  const [me, markets, trades, activity] = await Promise.all([
    get('/api/v1/auth/me').catch(() => ({})),
    get('/api/v1/markets').catch(() => ({ markets: [] })),
    get('/api/v1/trades?status=open&limit=8').catch(() => ({ items: [] })),
    get('/api/v1/transactions?limit=6').catch(() => ({ ledger: [], deposits: [], withdrawals: [] })),
  ]);

  const wallets = me.wallets ?? state.wallets ?? [];
  const user = me.user ?? state.user;
  const site = state.config?.site ?? {};
  const flags = state.config?.features ?? {};
  const name = user.displayName || user.username || 'Trader';
  const isDashboard = variant === 'dashboard';

  const walletCards = el(
    'div',
    { class: 'grid grid--3' },
    ...wallets.map((wallet) =>
      el(
        'div',
        { class: 'card wallet-card' },
        el(
          'div',
          { class: 'spread' },
          el('span', { class: 'muted' }, wallet.currency),
          wallet.active === false ? el('span', { class: 'pill pill--muted' }, 'nonaktif') : null,
        ),
        el('div', { class: 'price-headline' }, money(wallet.available ?? wallet.balance, wallet.currency)),
        el(
          'div',
          { class: 'small muted' },
          `Saldo ${money(wallet.balance, wallet.currency)} · tertahan ${money(wallet.locked ?? 0, wallet.currency)}`,
        ),
        el(
          'div',
          { class: 'chip-row mt-2' },
          wallet.depositEnabled ? el('a', { class: 'chip', href: '/deposit', 'data-link': '' }, 'Deposit') : null,
          wallet.withdrawalEnabled ? el('a', { class: 'chip', href: '/withdraw', 'data-link': '' }, 'Tarik') : null,
        ),
      ),
    ),
  );

  const openTrades = trades.items ?? [];
  const openTradesBox = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'page-head' },
      el('h2', {}, 'Trade terbuka'),
      el('a', { href: '/history', 'data-link': '', class: 'small' }, 'Riwayat lengkap →'),
    ),
    openTrades.length
      ? el(
          'div',
          { class: 'trade-list' },
          ...openTrades.map((trade) =>
            el(
              'a',
              { class: 'trade-row', href: `/trading/${trade.market}`, 'data-link': '' },
              el(
                'span',
                { class: `pill pill--${trade.direction === 'up' ? 'up' : 'down'}` },
                trade.direction === 'up' ? 'BUY' : 'SELL',
              ),
              el('span', { class: 'mono' }, trade.market),
              el('span', { class: 'right' }, money(trade.amount, trade.currency)),
              el('span', { class: 'small muted nowrap' }, relativeTime(trade.expiresAt)),
            ),
          ),
        )
      : emptyState(
          'Tidak ada trade terbuka',
          'Buka trade pertama dari halaman trading.',
          el('a', { class: 'btn btn--primary btn--sm', href: '/trading', 'data-link': '' }, 'Mulai trading'),
        ),
  );

  const marketMovers = (markets.markets ?? [])
    .filter((market) => market.status === 'active')
    .slice(0, 4)
    .map((market) =>
      el(
        'a',
        { class: 'market-item', href: `/trading/${market.symbol}`, 'data-link': '' },
        marketLogo(market),
        el(
          'span',
          {},
          el('strong', {}, market.symbol),
          el('span', { class: 'small muted' }, market.label ?? market.name),
        ),
        el(
          'span',
          { class: 'right mono' },
          el('strong', {}, fmt(market.lastPrice ?? 0, market.priceDecimals ?? 2)),
          el(
            'span',
            { class: `small ${(market.changePct ?? 0) >= 0 ? 'up' : 'down'}` },
            `${(market.changePct ?? 0) >= 0 ? '+' : ''}${fmt(market.changePct ?? 0, 2)}%`,
          ),
        ),
      ),
    );

  const ledgerRows = [
    ...(activity.ledger ?? []).map((row) => ({
      ...row,
      kindLabel: row.kind,
      sign: row.direction === 'credit' ? '+' : '−',
    })),
  ].slice(0, 6);

  const activityBox = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'page-head' },
      el('h2', {}, 'Aktivitas terbaru'),
      el('a', { href: '/transactions', 'data-link': '', class: 'small' }, 'Semua transaksi →'),
    ),
    ledgerRows.length
      ? el(
          'div',
          {},
          ...ledgerRows.map((row) =>
            el(
              'div',
              { class: 'spread activity-row' },
              el(
                'span',
                {},
                el('strong', {}, row.sign + ' ' + money(row.amount, row.currency)),
                el('span', { class: 'small muted' }, ` ${row.kindLabel}`),
              ),
              el('span', { class: 'small muted' }, dateTime(row.createdAt)),
            ),
          ),
        )
      : emptyState('Belum ada aktivitas', 'Transaksi demo akan muncul di sini.'),
  );

  const verification = user.emailVerified
    ? null
    : el(
        'div',
        { class: 'alert alert--warn' },
        el('strong', {}, 'Email belum diverifikasi'),
        el('span', {}, 'Verifikasi email supaya akun demo kamu aman. '),
        el('a', { href: '/account', 'data-link': '' }, 'Kirim tautan verifikasi →'),
      );

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, isDashboard ? 'Dashboard Akun' : `Halo, ${name}`),
        el(
          'p',
          { class: 'muted' },
          isDashboard
            ? 'Ringkasan akun, dompet demo dan aktivitas.'
            : 'Ringkasan akun demo, saldo, dan pasar hari ini.',
        ),
      ),
      el('span', { class: 'pill pill--warn' }, 'SIMULASI / DEMO'),
    ),
    verification,
    !me.totpEnabled
      ? el(
          'div',
          { class: 'alert alert--warn' },
          el('strong', {}, '2FA belum aktif'),
          el('span', {}, 'Aktifkan TOTP di halaman akun untuk lapisan keamanan tambahan. '),
          el('a', { href: '/profile-security', 'data-link': '' }, 'Atur keamanan →'),
        )
      : null,
    walletCards,
    el(
      'div',
      { class: 'grid grid--2 mt-3' },
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Aksi cepat'),
        el(
          'div',
          { class: 'quick-grid' },
          quickAction('Trading', 'Buka chart & pasang trade demo', '/trading', '◔'),
          flags.deposits ? quickAction('Deposit', 'Isi saldo demo via QRIS / manual', '/deposit', '↓') : null,
          flags.withdrawals ? quickAction('Penarikan', 'Ajukan tarik saldo demo', '/withdraw', '↑') : null,
          flags.liveChat ? quickAction('Live Chat', 'Tanya tim support demo', '/live-chat', '✉') : null,
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'page-head' },
          el('h2', {}, 'Pasar aktif'),
          el('a', { href: '/trading', 'data-link': '', class: 'small' }, 'Semua pasar →'),
        ),
        marketMovers.length
          ? el('div', { class: 'market-list' }, ...marketMovers)
          : emptyState('Pasar belum tersedia', 'Admin belum mengaktifkan pasar.'),
      ),
    ),
    openTradesBox,
    activityBox,
    el(
      'div',
      { class: 'card mt-3' },
      el('h2', {}, 'Fitur akun'),
      el(
        'div',
        { class: 'chip-row' },
        el('a', { class: 'chip', href: '/transactions', 'data-link': '' }, 'Transaksi'),
        el('a', { class: 'chip', href: '/history', 'data-link': '' }, 'Order history'),
        el('a', { class: 'chip', href: '/profile-security', 'data-link': '' }, 'Profil & keamanan'),
        el('a', { class: 'chip', href: '/payment-status', 'data-link': '' }, 'Status pembayaran'),
        el('a', { class: 'chip', href: '/notifications', 'data-link': '' }, 'Notifikasi'),
      ),
    ),
    el(
      'p',
      { class: 'small muted mt-4 center' },
      site?.legal?.riskWarning ??
        'Simulasi tanpa uang nyata. Hasil ditentukan server dan admin hanya mengatur parameter simulasi.',
    ),
    el(
      'p',
      { class: 'small muted center' },
      `Status pasar: ${markets.markets?.length ?? 0} aktif · diperbarui ${new Date().toLocaleTimeString('id-ID')}`,
    ),
  );
  void statusPill;
}
