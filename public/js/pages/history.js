import { get } from '../api.js';
import { state } from '../store.js';
import { $, clear, debounce, el, emptyState, fmt, money, resultPill, durationLabel } from '../ui.js';

export async function historyPage() {
  const root = $('#view');
  clear(root);
  if (!state.user) {
    window.router.go('/login');
    return;
  }
  const filters = { status: 'all', market: '', result: 'all', cursor: null, rows: [] };
  const table = el('div', {});
  const loadMore = el('button', { class: 'btn btn--ghost btn--block', type: 'button' }, 'Muat lebih banyak');

  const marketSelect = el(
    'select',
    { class: 'input', 'aria-label': 'Filter market' },
    el('option', { value: '' }, 'Semua market'),
  );
  for (const market of state.markets ?? []) marketSelect.append(el('option', { value: market.symbol }, market.name));

  const controls = el(
    'div',
    { class: 'filter-bar' },
    el(
      'div',
      { class: 'chip-row' },
      ...['all', 'open', 'closed'].map((status) =>
        el(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(status === filters.status),
            onClick: (event) => {
              filters.status = status;
              [...event.currentTarget.parentElement.children].forEach((chip) =>
                chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
              );
              void reload();
            },
          },
          status === 'all' ? 'Semua' : status === 'open' ? 'Terbuka' : 'Selesai',
        ),
      ),
    ),
    marketSelect,
    el(
      'select',
      {
        class: 'input',
        'aria-label': 'Filter hasil',
        onChange: (event) => {
          filters.result = event.target.value;
          void reload();
        },
      },
      el('option', { value: 'all' }, 'Semua hasil'),
      el('option', { value: 'win' }, 'Menang'),
      el('option', { value: 'lose' }, 'Kalah'),
      el('option', { value: 'draw' }, 'Seri'),
    ),
    el('a', { class: 'btn btn--ghost btn--sm', href: '/api/v1/trades/export.csv', download: '' }, 'Ekspor CSV'),
  );
  marketSelect.addEventListener('change', () => {
    filters.market = marketSelect.value;
    void reload();
  });

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Riwayat trade'),
        el('p', {}, 'Semua trade demo kamu, termasuk settlement manual admin (jika ada).'),
      ),
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
    ),
    el('section', { class: 'card' }, controls, table, loadMore),
  );

  async function reload() {
    filters.cursor = null;
    filters.rows = [];
    clear(table);
    table.append(el('div', { class: 'skeleton', style: { height: '120px' } }));
    await fetchPage();
  }

  async function fetchPage() {
    const params = new URLSearchParams({ limit: '25', status: filters.status });
    if (filters.market) params.set('market', filters.market);
    if (filters.result !== 'all') params.set('result', filters.result);
    if (filters.cursor) params.set('cursor', filters.cursor);
    try {
      const res = await get(`/api/v1/trades?${params}`);
      if (!filters.cursor) clear(table);
      filters.rows.push(...res.trades);
      renderRows(res.trades);
      filters.cursor = res.nextCursor ?? null;
      loadMore.hidden = !filters.cursor;
    } catch (error) {
      clear(table);
      table.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  }

  function renderRows(rows) {
    if (!filters.rows.length) {
      table.append(emptyState('Belum ada trade', 'Trade yang kamu buka akan muncul di sini.'));
      return;
    }
    for (const trade of rows) {
      table.append(
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
              `${money(trade.amount, trade.currency)} · ${durationLabel(trade.durationSec)} · `,
              new Date(trade.createdAt).toLocaleString('id-ID'),
            ),
          ),
          el(
            'div',
            { class: 'right' },
            resultPill(trade.result),
            el(
              'div',
              { class: 'muted', style: { fontSize: '11px' } },
              `entry ${fmt(trade.entryPrice, 4)}`,
              trade.closePrice !== null && trade.closePrice !== undefined ? ` → ${fmt(trade.closePrice, 4)}` : '',
            ),
            el(
              'div',
              { class: 'mono', style: { fontSize: '11px' } },
              trade.status === 'closed' ? money(trade.payout ?? 0, trade.currency) : 'berjalan…',
            ),
          ),
        ),
      );
    }
  }

  loadMore.addEventListener('click', () => void fetchPage());
  await reload();
  void debounce;
}
