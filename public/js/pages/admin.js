import { del, get, patch, post, put, api } from '../api.js';
import { state } from '../store.js';
import {
  $,
  clear,
  dateTime,
  durationLabel,
  el,
  emptyState,
  fmt,
  marketLogo,
  money,
  modal,
  skeleton,
  statusPill,
  toast,
} from '../ui.js';

const SECTIONS = [
  ['dashboard', 'Dasbor', 'dashboard.read'],
  ['markets', 'Market', 'markets.read'],
  ['trades', 'Trade', 'trades.read'],
  ['users', 'Pengguna', 'users.read'],
  ['finance', 'Keuangan demo', 'finance.read'],
  ['deposits', 'Deposit', 'deposits.read'],
  ['withdrawals', 'Penarikan', 'withdrawals.read'],
  ['currencies', 'Mata uang', 'finance.read'],
  ['chat', 'Live chat', 'chat.read'],
  ['settings', 'Pengaturan', 'settings.read'],
  ['content', 'Konten', 'content.read'],
  ['system', 'Sistem', 'system.read'],
  ['permissions', 'Peran & izin', 'dashboard.read'],
  ['payments', 'Pembayaran', 'payments.read'],
  ['site', 'Situs & flag', 'settings.read'],
];

const can = (permission) => state.permissions?.includes(permission);

export async function adminPage(ctx, { section } = {}) {
  const root = $('#view');
  clear(root);
  const active = SECTIONS.find(([id]) => id === (section || 'dashboard')) ? section || 'dashboard' : 'dashboard';

  const nav = el('nav', { class: 'admin-nav', 'aria-label': 'Navigasi admin' });
  nav.append(el('div', { class: 'admin-nav__group' }, `Masuk sebagai ${state.user?.staffRole ?? 'staf'}`));
  for (const [id, label, permission] of SECTIONS) {
    if (!can(permission)) continue;
    nav.append(
      el('a', { href: `/admin/${id}`, 'data-link': '', 'aria-current': id === active ? 'page' : null }, label),
    );
  }

  const panel = el('div', { class: 'admin-panel' });
  root.append(el('div', { class: 'admin-layout' }, nav, panel));

  const renderers = {
    dashboard: renderDashboard,
    markets: renderMarkets,
    trades: renderTrades,
    users: renderUsers,
    finance: renderFinance,
    deposits: renderDeposits,
    withdrawals: renderWithdrawals,
    currencies: renderCurrencies,
    chat: renderChatInbox,
    site: renderSite,
    settings: renderSettings,
    content: renderContent,
    system: renderSystem,
    permissions: renderPermissions,
    payments: renderPayments,
  };
  try {
    await (renderers[active] ?? renderDashboard)(panel);
  } catch (error) {
    clear(panel);
    panel.append(el('div', { class: 'alert alert--error' }, el('strong', {}, 'Gagal memuat panel. '), error.message));
  }
  void ctx;
}

function head(title, subtitle, actions = []) {
  return el(
    'div',
    { class: 'page-head' },
    el('div', {}, el('h1', {}, title), el('p', {}, subtitle)),
    el(
      'div',
      { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
      ...actions,
    ),
  );
}

function table(headers, rows) {
  const node = el('table', { class: 'data' });
  const thead = el('thead', {});
  thead.append(el('tr', {}, ...headers.map(([label, cls]) => el('th', { class: cls ?? '' }, label))));
  const tbody = el('tbody', {});
  for (const row of rows) {
    const tr = el('tr', {});
    for (const cell of row) {
      const td = el('td', {});
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell === null || cell === undefined ? '—' : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  node.append(thead, tbody);
  return el('div', { class: 'table-wrap' }, node);
}

function barChart(data, { valueKey = 'trades', labelKey = 'hour' } = {}) {
  const canvas = el('canvas', { role: 'img', 'aria-label': 'Grafik' });
  const box = el('div', { class: 'chart-box' }, canvas);
  requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = box.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const values = data.map((row) => Number(row[valueKey] ?? 0));
    const max = Math.max(1, ...values);
    const barW = w / Math.max(data.length, 1);
    ctx.clearRect(0, 0, w, h);
    data.forEach((row, index) => {
      const value = Number(row[valueKey] ?? 0);
      const barH = (value / max) * (h - 18);
      ctx.fillStyle = value > 0 ? 'rgba(91,140,255,0.85)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(index * barW + 1, h - 14 - barH, Math.max(2, barW - 3), Math.max(2, barH));
    });
    ctx.fillStyle = 'rgba(150,160,180,0.9)';
    ctx.font = '9px ui-monospace, monospace';
    data.forEach((row, index) => {
      if (index % Math.ceil(data.length / 8) !== 0) return;
      ctx.fillText(String(row[labelKey]).slice(-5), index * barW + 1, h - 2);
    });
  });
  return box;
}

function statCard(label, value, hint) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat__label' }, label),
    el('div', { class: 'stat__value' }, value),
    hint ? el('div', { class: 'stat__hint' }, hint) : null,
  );
}

// ------------------------------------------------------------------ dashboard
async function renderDashboard(panel) {
  panel.append(head('Dasbor', 'Ringkasan aktivitas simulasi.'));
  const stats = await get('/api/v1/admin/dashboard');
  panel.append(
    el(
      'div',
      { class: 'grid grid--4' },
      statCard('Pengguna', fmt(stats.users.total, 0), `${stats.users.activeToday} aktif hari ini`),
      statCard('Trade hari ini', fmt(stats.trades.today, 0), `${stats.trades.open} terbuka`),
      statCard('Volume hari ini', money(stats.trades.volumeTodayMinor / 100, 'USD'), 'semua mata uang dinormalkan'),
      statCard('Payout hari ini', money(stats.trades.payoutTodayMinor / 100, 'USD'), 'virtual'),
    ),
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { class: 'card__title' }, 'Trade per jam (24 jam)')),
      barChart(stats.perHour, { valueKey: 'trades', labelKey: 'hour' }),
      el(
        'div',
        { class: 'card__head', style: { marginTop: '12px' } },
        el('h2', { class: 'card__title' }, 'Volume per hari (14 hari)'),
      ),
      barChart(stats.perDay, { valueKey: 'volumeMinor', labelKey: 'day' }),
    ),
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Market live'),
        table(
          [['Market'], ['Status'], ['Trade 24j', 'num']],
          stats.markets.map((market) => [market.symbol, statusPill(market.status), fmt(market.trades24h, 0)]),
        ),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Peringatan'),
        stats.alerts.length
          ? el(
              'ul',
              { class: 'list-plain' },
              ...stats.alerts.map((alert) =>
                el(
                  'li',
                  {},
                  el(
                    'span',
                    {
                      class: `pill ${alert.level === 'error' ? 'pill--down' : alert.level === 'warn' ? 'pill--warn' : 'pill--muted'}`,
                    },
                    alert.code,
                  ),
                  alert.message,
                ),
              ),
            )
          : emptyState('Tidak ada peringatan', 'Semua job dan koneksi tampak normal.'),
      ),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, 'Aktivitas terakhir'),
      el(
        'ul',
        { class: 'list-plain' },
        ...stats.activity
          .slice(0, 10)
          .map((item) =>
            el(
              'li',
              {},
              el('span', {}, `${item.label || item.kind}${item.actor ? ` · ${item.actor}` : ''}`),
              el('span', { class: 'muted' }, new Date(item.at).toLocaleString('id-ID')),
            ),
          ),
      ),
    ),
  );
}

// -------------------------------------------------------------------- markets
async function renderMarkets(panel) {
  panel.append(
    head('Market', 'Kelola market simulasi, logo, jam trading, dan parameter simulasi.', [
      el(
        'button',
        { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => createMarketDialog(reload) },
        'Tambah market',
      ),
    ]),
  );
  const listBox = el('div', {});
  panel.append(listBox);

  async function reload() {
    clear(listBox);
    listBox.append(skeleton(4));
    const data = await get('/api/v1/admin/markets');
    clear(listBox);
    listBox.append(table([['Market'], ['Harga'], ['Status'], ['Parameter'], ['Update']], []));
    const tableNode = listBox.querySelector('tbody');
    for (const market of data.markets) {
      tableNode.append(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              marketLogo(market),
              el(
                'div',
                {},
                el('div', { style: { fontWeight: '600' } }, market.name),
                el(
                  'div',
                  { class: 'muted', style: { fontSize: '10.5px' } },
                  `${market.symbol} · ${market.category} · ${market.priceDecimals}dp`,
                ),
              ),
            ),
          ),
          el(
            'td',
            { class: 'num' },
            market.ticker?.price === undefined ? '—' : fmt(market.ticker?.price ?? 0, market.priceDecimals),
          ),
          el(
            'td',
            {},
            statusPill(market.status),
            market.deleted ? el('span', { class: 'pill pill--down', style: { marginLeft: '4px' } }, 'deleted') : null,
          ),
          el(
            'td',
            { class: 'muted', style: { fontSize: '11px' } },
            `${market.trend} · ${market.volatilityPreset} · ${market.mood}`,
          ),
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              el(
                'button',
                { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => simulateDialog(market, reload) },
                'Simulasi',
              ),
              el(
                'button',
                { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => editLimitsDialog(market, reload) },
                'Ubah',
              ),
              el(
                'button',
                {
                  class: 'btn btn--ghost btn--sm',
                  type: 'button',
                  onClick: async () => {
                    try {
                      await post(`/api/v1/admin/markets/${market.symbol}/simulate`, {
                        paused: !market.paused,
                        pauseReason: market.paused ? null : 'dijeda admin',
                      });
                      toast({ title: market.paused ? 'Market dilanjutkan' : 'Market dipause', type: 'info' });
                      reload();
                    } catch (error) {
                      toast({ title: 'Gagal', message: error.message, type: 'error' });
                    }
                  },
                },
                market.paused ? 'Resume' : 'Pause',
              ),
              el(
                'button',
                { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => historyDialog(market) },
                'Riwayat',
              ),
              market.deleted
                ? el(
                    'button',
                    {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      onClick: async () => {
                        await post(`/api/v1/admin/markets/${market.symbol}/restore`, {});
                        reload();
                      },
                    },
                    'Pulihkan',
                  )
                : el(
                    'button',
                    {
                      class: 'btn btn--danger btn--sm',
                      type: 'button',
                      onClick: async () => {
                        if (!confirm(`Hapus market ${market.symbol}? Trade terbuka akan memblokir penghapusan.`))
                          return;
                        try {
                          await del(`/api/v1/admin/markets/${market.symbol}`);
                          toast({ title: 'Market dihapus (soft delete)', type: 'win' });
                          reload();
                        } catch (error) {
                          toast({ title: 'Tidak bisa dihapus', message: error.message, type: 'error' });
                        }
                      },
                    },
                    'Hapus',
                  ),
            ),
          ),
        ),
      );
    }
  }
  await reload();
}

function simulateDialog(market, after) {
  const trend = el(
    'select',
    { class: 'input' },
    ...['up', 'down', 'neutral'].map((value) => el('option', { value, selected: market.trend === value }, value)),
  );
  const strength = el('input', {
    class: 'input',
    type: 'number',
    min: '1',
    max: '10',
    value: String(market.trendStrength ?? 5),
  });
  const preset = el(
    'select',
    { class: 'input' },
    ...['rendah', 'sedang', 'tinggi', 'ekstrem'].map((value) =>
      el('option', { value, selected: market.volatilityPreset === value }, value),
    ),
  );
  const mood = el(
    'select',
    { class: 'input' },
    ...['sepi', 'normal', 'cepat', 'liar'].map((value) =>
      el('option', { value, selected: market.mood === value }, value),
    ),
  );
  const confirmBox = modal({
    title: `Simulasi ${market.symbol}`,
    body: el(
      'div',
      {},
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px' } },
        'Parameter ini memengaruhi tick berikutnya, bukan hasil trade yang sudah berjalan. Setiap perubahan dicatat di riwayat market yang publik.',
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Tren'), trend),
        el('div', { class: 'field' }, el('label', {}, 'Kekuatan tren (1–10)'), strength),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Volatilitas'), preset),
        el('div', { class: 'field' }, el('label', {}, 'Mood'), mood),
      ),
    ),
    actions: [
      { label: 'Batal', className: 'btn--ghost' },
      {
        label: 'Terapkan',
        className: 'btn--primary',
        onClick: async () => {
          try {
            await post(`/api/v1/admin/markets/${market.symbol}/simulate`, {
              trend: trend.value,
              trendStrength: Number(strength.value),
              volatilityPreset: preset.value,
              mood: mood.value,
            });
            toast({ title: 'Parameter diterapkan', message: 'Tercatat di riwayat market.', type: 'win' });
            after();
          } catch (error) {
            toast({ title: 'Gagal', message: error.message, type: 'error' });
            return false;
          }
          return true;
        },
      },
    ],
  });
  void confirmBox;
}

function editLimitsDialog(market, after) {
  const name = el('input', { class: 'input', value: market.name, maxlength: '60' });
  const min = el('input', { class: 'input', type: 'number', step: '0.01', value: market.minAmount ?? '' });
  const max = el('input', { class: 'input', type: 'number', step: '0.01', value: market.maxAmount ?? '' });
  const payout = el('input', {
    class: 'input',
    type: 'number',
    step: '0.01',
    value: market.payoutRate ?? '',
    placeholder: 'default',
  });
  const featured = el('input', { type: 'checkbox', checked: market.featured });
  modal({
    title: `Ubah ${market.symbol}`,
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', {}, 'Nama'), name),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Min stake (USD)'), min),
        el('div', { class: 'field' }, el('label', {}, 'Max stake (USD)'), max),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Payout override (0–3, kosong = default)'), payout),
      el('label', { class: 'checkbox' }, featured, el('span', {}, 'Tampilkan sebagai unggulan')),
      el(
        'div',
        { class: 'alert alert--warn', style: { marginTop: '10px' } },
        'Mengubah harga awal tidak mengubah trade yang sedang berjalan; entry price tersimpan per trade.',
      ),
    ),
    actions: [
      { label: 'Batal', className: 'btn--ghost' },
      {
        label: 'Simpan',
        className: 'btn--primary',
        onClick: async () => {
          try {
            await patch(`/api/v1/admin/markets/${market.symbol}`, {
              name: name.value,
              minAmountUsd: min.value ? Number(min.value) : null,
              maxAmountUsd: max.value ? Number(max.value) : null,
              payoutRate: payout.value ? Number(payout.value) : null,
              featured: featured.checked,
            });
            toast({ title: 'Market diperbarui', type: 'win' });
            after();
          } catch (error) {
            toast({ title: 'Gagal', message: error.message, type: 'error' });
            return false;
          }
          return true;
        },
      },
    ],
  });
}

async function historyDialog(market) {
  const res = await get(`/api/v1/admin/markets/${market.symbol}/history?limit=50`);
  modal({
    title: `Riwayat parameter ${market.symbol}`,
    body: res.entries.length
      ? el(
          'ul',
          { class: 'list-plain' },
          ...res.entries.map((entry) =>
            el(
              'li',
              {},
              el(
                'span',
                {},
                `${entry.action}${entry.note ? ` · ${entry.note}` : ''}`,
                el(
                  'div',
                  { class: 'muted', style: { fontSize: '10.5px' } },
                  `${entry.actorRole} · ${new Date(entry.createdAt).toLocaleString('id-ID')}`,
                ),
              ),
              el(
                'span',
                {
                  class: 'mono',
                  style: {
                    fontSize: '10px',
                    maxWidth: '45%',
                    textAlign: 'right',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                JSON.stringify(entry.after ?? {}).slice(0, 90),
              ),
            ),
          ),
        )
      : emptyState('Belum ada perubahan', 'Riwayat akan terisi saat admin mengubah parameter.'),
  });
}

async function createMarketDialog(after) {
  const categories = ['index', 'crypto', 'forex', 'komoditas', 'lainnya'];
  const form = {
    symbol: el('input', { class: 'input', placeholder: 'MISAL_DOGE2', maxlength: '20' }),
    name: el('input', { class: 'input', placeholder: 'Nama market' }),
    description: el('input', { class: 'input', placeholder: 'Deskripsi singkat' }),
    category: el('select', { class: 'input' }, ...categories.map((value) => el('option', { value }, value))),
    priceDecimals: el('input', { class: 'input', type: 'number', min: '0', max: '8', value: '2' }),
    startPrice: el('input', { class: 'input', type: 'number', step: '0.0001', value: '100' }),
    tickSize: el('input', { class: 'input', type: 'number', step: '0.0001', value: '0.1' }),
    volatilityPreset: el(
      'select',
      { class: 'input' },
      ...['rendah', 'sedang', 'tinggi', 'ekstrem'].map((value) =>
        el('option', { value, selected: value === 'sedang' }, value),
      ),
    ),
    mood: el(
      'select',
      { class: 'input' },
      ...['sepi', 'normal', 'cepat', 'liar'].map((value) =>
        el('option', { value, selected: value === 'normal' }, value),
      ),
    ),
    minAmountUsd: el('input', { class: 'input', type: 'number', step: '0.01', value: '1' }),
    maxAmountUsd: el('input', { class: 'input', type: 'number', step: '0.01', value: '1000' }),
    activate: el('input', { type: 'checkbox', checked: true }),
  };
  const previewCanvas = el('canvas', { style: { width: '100%', height: '110px' } });
  const nameSuggestion = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Nama acak');
  const fileInput = el('input', {
    class: 'input',
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });
  let logoPath = null;

  const preview = async () => {
    try {
      const res = await post('/api/v1/admin/markets/preview', {
        startPrice: Number(form.startPrice.value) || 100,
        priceDecimals: Number(form.priceDecimals.value) || 2,
        volatilityPreset: form.volatilityPreset.value,
        mood: form.mood.value,
      });
      drawSimpleLine(
        previewCanvas,
        res.candles.map((c) => c.c),
      );
    } catch {
      /* preview is a nicety */
    }
  };
  for (const key of ['startPrice', 'priceDecimals', 'volatilityPreset', 'mood']) {
    form[key].addEventListener('change', preview);
  }
  nameSuggestion.addEventListener('click', async () => {
    try {
      const res = await get(`/api/v1/admin/markets/suggestions/${form.category.value}`);
      form.name.value = res.name;
      if (!form.symbol.value)
        form.symbol.value = res.name
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .slice(0, 16);
    } catch (error) {
      toast({ title: 'Gagal', message: error.message, type: 'error' });
    }
  });
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const body = new FormData();
    body.append('file', fileInput.files[0]);
    try {
      const res = await api('/api/v1/admin/uploads/image', { method: 'POST', body });
      logoPath = res.relativePath;
      toast({ title: 'Logo diunggah', message: res.url, type: 'win' });
    } catch (error) {
      toast({ title: 'Logo ditolak', message: error.message, type: 'error' });
    }
  });

  modal({
    title: 'Tambah market simulasi',
    body: el(
      'div',
      {},
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Symbol (A–Z, 0–9, _)'), form.symbol),
        el('div', { class: 'field' }, el('label', {}, 'Nama'), form.name, nameSuggestion),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Deskripsi'), form.description),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Kategori'), form.category),
        el('div', { class: 'field' }, el('label', {}, 'Logo (PNG/JPG/WEBP/SVG ≤ 512 KB)'), fileInput),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Harga awal'), form.startPrice),
        el('div', { class: 'field' }, el('label', {}, 'Desimal harga'), form.priceDecimals),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Tick size'), form.tickSize),
        el('div', { class: 'field' }, el('label', {}, 'Volatilitas'), form.volatilityPreset),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Mood'), form.mood),
        el('div', { class: 'field' }, el('label', {}, 'Min stake USD'), form.minAmountUsd),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Max stake USD'), form.maxAmountUsd),
        el(
          'label',
          { class: 'checkbox', style: { marginTop: '26px' } },
          form.activate,
          el('span', {}, 'Aktifkan langsung'),
        ),
      ),
      el('div', { class: 'card__title', style: { marginTop: '10px' } }, 'Pratinjau chart'),
      previewCanvas,
    ),
    actions: [
      { label: 'Batal', className: 'btn--ghost' },
      {
        label: 'Buat market',
        className: 'btn--primary',
        onClick: async () => {
          try {
            await post('/api/v1/admin/markets', {
              symbol: form.symbol.value.toUpperCase(),
              name: form.name.value,
              description: form.description.value || null,
              category: form.category.value,
              priceDecimals: Number(form.priceDecimals.value),
              startPrice: Number(form.startPrice.value),
              tickSize: Number(form.tickSize.value),
              volatilityPreset: form.volatilityPreset.value,
              mood: form.mood.value,
              minAmountUsd: Number(form.minAmountUsd.value),
              maxAmountUsd: Number(form.maxAmountUsd.value),
              logoPath,
              activate: form.activate.checked,
            });
            toast({ title: 'Market dibuat', message: 'Histori & candle awal dibuat otomatis.', type: 'win' });
            after();
          } catch (error) {
            toast({ title: 'Gagal membuat market', message: error.message, type: 'error', timeout: 6000 });
            return false;
          }
          return true;
        },
      },
    ],
  });
  void preview();
}

function drawSimpleLine(canvas, values) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * w;
    const y = h - ((value - min) / Math.max(1e-9, max - min)) * (h - 8) - 4;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// --------------------------------------------------------------------- trades
async function renderTrades(panel) {
  panel.append(
    head('Trade', 'Semua trade simulasi, settlement manual, dan statistik.', [
      el('a', { class: 'btn btn--ghost btn--sm', href: '/api/v1/admin/trades/export.csv', download: '' }, 'Ekspor CSV'),
    ]),
  );
  const filters = { status: 'all', market: '', result: '', offset: 0 };
  const controls = el('div', { class: 'admin-toolbar' });
  const statusSelect = el(
    'select',
    { class: 'input' },
    ['all', 'open', 'closed'].map((value) => el('option', { value }, value)),
  );
  const marketInput = el('input', { class: 'input', placeholder: 'Market (mis. DOGE)' });
  const resultSelect = el(
    'select',
    { class: 'input' },
    ...['', 'win', 'lose', 'draw'].map((value) => el('option', { value }, value || 'semua hasil')),
  );
  controls.append(
    statusSelect,
    marketInput,
    resultSelect,
    el(
      'button',
      {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onClick: () => {
          filters.offset = 0;
          load();
        },
      },
      'Terapkan',
    ),
  );
  const listBox = el('div', {});
  panel.append(el('section', { class: 'card' }, controls, listBox));
  const statsBox = el('section', { class: 'card' });
  panel.append(statsBox);

  async function load() {
    clear(listBox);
    listBox.append(skeleton(3));
    const params = new URLSearchParams({ status: statusSelect.value, limit: '25', offset: String(filters.offset) });
    if (marketInput.value) params.set('market', marketInput.value.toUpperCase());
    if (resultSelect.value) params.set('result', resultSelect.value);
    try {
      const res = await get(`/api/v1/admin/trades?${params}`);
      clear(listBox);
      listBox.append(
        table(
          [['Waktu'], ['User'], ['Market'], ['Arah'], ['Nominal'], ['Status'], ['Hasil'], ['Aksi']],
          res.trades.map((trade) => [
            new Date(trade.createdAt).toLocaleString('id-ID'),
            trade.username ?? trade.userId,
            trade.market,
            trade.direction === 'up' ? 'NAIK' : 'TURUN',
            money(trade.amount, trade.currency),
            trade.status === 'closed' ? 'selesai' : 'terbuka',
            trade.result ?? '—',
            el(
              'button',
              { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => tradeDetail(trade, load) },
              'Detail',
            ),
          ]),
        ),
      );
      if (res.total > res.trades.length) {
        listBox.append(
          el(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
            el(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                onClick: () => {
                  filters.offset = Math.max(0, filters.offset - 25);
                  load();
                },
              },
              'Sebelumnya',
            ),
            el(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                onClick: () => {
                  filters.offset += 25;
                  load();
                },
              },
              'Berikutnya',
            ),
          ),
        );
      }
    } catch (error) {
      clear(listBox);
      listBox.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  }

  async function loadStats() {
    try {
      const stats = await get('/api/v1/admin/trades/stats');
      clear(statsBox);
      statsBox.append(
        el('h2', { class: 'card__title' }, 'Statistik'),
        el(
          'div',
          { class: 'grid grid--4' },
          statCard('Total trade', fmt(stats.total ?? 0, 0)),
          statCard('Win rate', `${fmt(stats.winRate ?? 0, 1)}%`),
          statCard('Volume', money((stats.volumeMinor ?? 0) / 100, 'USD')),
          statCard('Payout', money((stats.payoutMinor ?? 0) / 100, 'USD')),
        ),
      );
      if (stats.byMarket?.length) {
        statsBox.append(
          table(
            [['Market'], ['Jumlah', 'num'], ['Win', 'num'], ['Lose', 'num'], ['Draw', 'num']],
            stats.byMarket.map((row) => [
              row.market,
              fmt(row.count, 0),
              fmt(row.win, 0),
              fmt(row.lose, 0),
              fmt(row.draw, 0),
            ]),
          ),
        );
      }
    } catch (error) {
      clear(statsBox);
      statsBox.append(el('div', { class: 'alert alert--warn' }, error.message));
    }
  }

  await Promise.all([load(), loadStats()]);
}

async function tradeDetail(trade, after) {
  const detail = await get(`/api/v1/admin/trades/${trade.id}`);
  const reason = el('textarea', {
    class: 'input',
    placeholder: 'Alasan settlement manual (wajib, minimal 5 karakter)',
  });
  modal({
    title: `Trade ${trade.id.slice(0, 8)}`,
    body: el(
      'div',
      {},
      el(
        'div',
        { class: 'trade-summary' },
        el('div', {}, el('span', { class: 'muted' }, 'User'), el('span', {}, detail.user?.username ?? trade.userId)),
        el('div', {}, el('span', { class: 'muted' }, 'Market'), el('span', {}, trade.market)),
        el('div', {}, el('span', { class: 'muted' }, 'Arah'), el('span', {}, trade.direction)),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Nominal'),
          el('span', { class: 'mono' }, money(trade.amount, trade.currency)),
        ),
        el('div', {}, el('span', { class: 'muted' }, 'Entry'), el('span', { class: 'mono' }, fmt(trade.entryPrice, 4))),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Close'),
          el('span', { class: 'mono' }, trade.closePrice === null ? '—' : fmt(trade.closePrice, 4)),
        ),
        el('div', {}, el('span', { class: 'muted' }, 'Durasi'), el('span', {}, durationLabel(trade.durationSec))),
        el('div', {}, el('span', { class: 'muted' }, 'Hasil'), el('span', {}, trade.result ?? 'terbuka')),
        el('div', {}, el('span', { class: 'muted' }, 'Settled by'), el('span', {}, trade.settledBy ?? '—')),
      ),
      trade.status === 'open'
        ? el(
            'div',
            { style: { marginTop: '12px' } },
            el(
              'div',
              { class: 'alert alert--warn' },
              'Settlement manual hanya untuk kasus luar biasa. Alasan wajib dan tercatat di audit.',
            ),
            el('div', { class: 'field', style: { marginTop: '8px' } }, el('label', {}, 'Alasan'), reason),
            el(
              'button',
              {
                class: 'btn btn--danger btn--sm',
                type: 'button',
                onClick: async () => {
                  if (reason.value.trim().length < 5) {
                    toast({ title: 'Alasan wajib diisi', type: 'error' });
                    return;
                  }
                  try {
                    await post(`/api/v1/admin/trades/${trade.id}/settle`, { reason: reason.value.trim() });
                    toast({ title: 'Trade diselesaikan manual', type: 'win' });
                    after();
                    document.querySelector('.modal-backdrop')?.remove();
                  } catch (error) {
                    toast({ title: 'Gagal', message: error.message, type: 'error' });
                  }
                },
              },
              'Settle sekarang',
            ),
          )
        : null,
    ),
  });
}

// ---------------------------------------------------------------------- users
async function renderUsers(panel) {
  panel.append(head('Pengguna', 'Cari pengguna, periksa aktivitas, atur saldo demo, dan kelola sesi.'));
  const search = el('input', { class: 'input', placeholder: 'Cari email / username' });
  const listBox = el('div', {});
  panel.append(
    el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'admin-toolbar' },
        search,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => load() }, 'Cari'),
      ),
      listBox,
    ),
  );
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') load();
  });

  async function load() {
    clear(listBox);
    listBox.append(skeleton(3));
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (search.value.trim()) params.set('search', search.value.trim());
      const res = await get(`/api/v1/admin/users?${params}`);
      clear(listBox);
      listBox.append(
        table(
          [['Pengguna'], ['Peran'], ['Saldo demo'], ['Trade terbuka', 'num'], ['Status'], ['Aksi']],
          res.users.map((user) => [
            el(
              'div',
              {},
              el('div', { style: { fontWeight: '600' } }, user.displayName || user.username),
              el('div', { class: 'muted', style: { fontSize: '10.5px' } }, user.email),
            ),
            user.staffRole ?? 'user',
            user.wallets.map((wallet) => money(wallet.balance, wallet.currency)).join(' · '),
            String(user.openTrades),
            user.blocked
              ? el('span', { class: 'pill pill--down' }, 'diblokir')
              : el('span', { class: 'pill pill--up' }, 'aktif'),
            el(
              'button',
              { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => userDetail(user.id, load) },
              'Detail',
            ),
          ]),
        ),
      );
    } catch (error) {
      clear(listBox);
      listBox.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  }
  await load();
}

async function userDetail(userId, after) {
  const detail = await get(`/api/v1/admin/users/${userId}`);
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', placeholder: 'Nominal' });
  const currency = el(
    'select',
    { class: 'input' },
    ...['USD', 'IDR', 'USDT'].map((value) => el('option', { value }, value)),
  );
  const mode = el(
    'select',
    { class: 'input' },
    ...[
      ['add', 'tambah'],
      ['subtract', 'kurangi'],
      ['set', 'set ke'],
    ].map(([value, label]) => el('option', { value }, label)),
  );
  const reason = el('input', { class: 'input', placeholder: 'Alasan (wajib, min 5 karakter)' });
  const note = el('input', { class: 'input', placeholder: 'Catatan internal' });
  const clearNotes = () => {
    [...document.querySelectorAll('.modal-backdrop')].pop()?.remove();
  };

  modal({
    title: `Pengguna ${detail.user.username}`,
    body: el(
      'div',
      {},
      el(
        'div',
        { class: 'trade-summary' },
        el('div', {}, el('span', { class: 'muted' }, 'Email'), el('span', {}, detail.user.email)),
        el('div', {}, el('span', { class: 'muted' }, 'Role'), el('span', {}, detail.user.staffRole ?? 'user')),
        el('div', {}, el('span', { class: 'muted' }, 'Dibuat'), el('span', {}, dateTime(detail.user.createdAt))),
        el(
          'div',
          {},
          el('span', { class: 'muted' }, 'Login terakhir'),
          el('span', {}, detail.user.lastLoginAt ? dateTime(detail.user.lastLoginAt) : '—'),
        ),
      ),
      el('h3', { style: { marginTop: '14px' } }, 'Dompet demo'),
      el(
        'ul',
        { class: 'list-plain' },
        ...detail.wallets.map((wallet) =>
          el(
            'li',
            {},
            el('span', {}, wallet.currency),
            el('span', { class: 'mono' }, money(wallet.balance, wallet.currency)),
          ),
        ),
      ),
      el('h3', { style: { marginTop: '14px' } }, 'Sesuaikan saldo (audited)'),
      el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, currency, mode, amount),
      el(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
        reason,
        el(
          'button',
          {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                await post(`/api/v1/admin/users/${userId}/wallet`, {
                  currency: currency.value,
                  mode: mode.value,
                  amount: Number(amount.value),
                  reason: reason.value,
                });
                toast({ title: 'Saldo disesuaikan', type: 'win' });
                clearNotes();
                after();
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          'Terapkan',
        ),
      ),
      el('h3', { style: { marginTop: '14px' } }, 'Keamanan'),
      el(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                await post(`/api/v1/admin/users/${userId}/block`, {
                  blocked: !detail.user.blocked,
                  reason: 'diblokir admin',
                });
                toast({ title: detail.user.blocked ? 'Pengguna dibuka' : 'Pengguna diblokir', type: 'win' });
                clearNotes();
                after();
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          detail.user.blocked ? 'Buka blokir' : 'Blokir',
        ),
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              await post(`/api/v1/admin/users/${userId}/logout`, {});
              toast({ title: 'Semua sesi dikeluarkan', type: 'win' });
            },
          },
          'Keluarkan semua sesi',
        ),
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              const res = await post(`/api/v1/admin/users/${userId}/send-reset`, {});
              toast({
                title: 'Tautan reset dibuat',
                message: res.devResetLink ?? 'Mode produksi: email dikirim.',
                type: 'info',
                timeout: 8000,
              });
            },
          },
          'Kirim reset',
        ),
        detail.user.staffRole === null && state.user?.staffRole === 'super_admin'
          ? el(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                onClick: async () => {
                  try {
                    await patch(`/api/v1/admin/users/${userId}/role`, { staffRole: 'support' });
                    toast({ title: 'Role diubah ke support', type: 'win' });
                    clearNotes();
                    after();
                  } catch (error) {
                    toast({ title: 'Gagal', message: error.message, type: 'error' });
                  }
                },
              },
              'Jadikan support',
            )
          : null,
      ),
      el('h3', { style: { marginTop: '14px' } }, 'Catatan internal'),
      el(
        'div',
        { style: { display: 'flex', gap: '6px' } },
        note,
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                await post(`/api/v1/admin/users/${userId}/notes`, { body: note.value });
                toast({ title: 'Catatan ditambahkan', type: 'win' });
                note.value = '';
                clearNotes();
                after();
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          'Tambah',
        ),
      ),
      el(
        'ul',
        { class: 'list-plain', style: { marginTop: '6px' } },
        ...detail.notes.map((entry) =>
          el('li', {}, el('span', {}, entry.body), el('span', { class: 'muted' }, dateTime(entry.createdAt))),
        ),
      ),
      el('h3', { style: { marginTop: '14px' } }, 'Riwayat login'),
      el(
        'ul',
        { class: 'list-plain' },
        ...detail.loginHistory
          .slice(0, 8)
          .map((entry) =>
            el(
              'li',
              {},
              el('span', {}, entry.success ? 'berhasil' : `gagal (${entry.reason ?? '—'})`, ` · ${entry.ip ?? '—'}`),
              el('span', { class: 'muted' }, dateTime(entry.createdAt)),
            ),
          ),
      ),
    ),
  });
}

// --------------------------------------------------------------------- finance
async function renderFinance(panel) {
  panel.append(head('Keuangan demo', 'Total saldo virtual, aliran ledger, dan kurs demo.'));
  const data = await get('/api/v1/admin/finance');
  panel.append(
    el(
      'div',
      { class: 'grid grid--3' },
      ...data.wallets.map((wallet) =>
        statCard(`${wallet.currency} (virtual)`, money(wallet.total, wallet.currency), `${wallet.accounts} akun`),
      ),
    ),
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Aliran ledger 7 hari'),
        data.flows.length
          ? table(
              [['Jenis'], ['Mata uang'], ['Arah'], ['Total', 'num'], ['Jumlah', 'num']],
              data.flows.map((row) => [
                `${row.kind}`,
                row.currency,
                row.direction,
                fmt(row.totalMinor / 100, 2),
                fmt(row.count, 0),
              ]),
            )
          : emptyState('Belum ada aliran', 'Ledger akan terisi saat ada aktivitas.'),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Eksposur'),
        el(
          'ul',
          { class: 'list-plain' },
          el('li', {}, el('span', {}, 'Trade terbuka'), el('span', { class: 'mono' }, fmt(data.openTrades, 0))),
          el(
            'li',
            {},
            el('span', {}, 'Eksposur (≈ USD)'),
            el('span', { class: 'mono' }, money(data.openExposureUsd, 'USD')),
          ),
          el(
            'li',
            {},
            el('span', {}, 'Deposit / penarikan'),
            el('span', { class: 'pill pill--warn' }, 'tidak tersedia'),
          ),
        ),
      ),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, 'Kurs demo'),
      (() => {
        const inputs = {};
        const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
        for (const currency of ['USD', 'IDR', 'USDT']) {
          inputs[currency] = el('input', {
            class: 'input',
            type: 'number',
            step: '0.0001',
            value: String(data.settings.rates[currency]),
          });
          row.append(
            el(
              'div',
              { class: 'field', style: { flex: '1 1 120px' } },
              el('label', {}, `1 USD = ? ${currency}`),
              inputs[currency],
            ),
          );
        }
        row.append(
          el(
            'button',
            {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              style: { alignSelf: 'flex-end' },
              onClick: async () => {
                try {
                  await post('/api/v1/admin/finance/fx', {
                    rates: {
                      USD: Number(inputs.USD.value),
                      IDR: Number(inputs.IDR.value),
                      USDT: Number(inputs.USDT.value),
                    },
                  });
                  toast({ title: 'Kurs diperbarui', message: 'Tercatat di riwayat FX.', type: 'win' });
                } catch (error) {
                  toast({ title: 'Gagal', message: error.message, type: 'error' });
                }
              },
            },
            'Simpan kurs',
          ),
        );
        return row;
      })(),
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px' } },
        'Kurs hanya untuk konversi saldo virtual. Tidak ada transaksi nyata.',
      ),
    ),
  );
}

// -------------------------------------------------------------------- settings
async function renderSettings(panel) {
  panel.append(head('Pengaturan', 'Payout, batas, retensi, dan branding platform.'));
  const settings = await get('/api/v1/admin/settings');
  const fields = {};
  const group = (title, entries) => {
    const card = el('section', { class: 'card' }, el('h2', { class: 'card__title' }, title));
    const grid = el('div', { class: 'form-row' });
    for (const [key, label, type] of entries) {
      const value = settings[key];
      const input =
        type === 'select'
          ? el(
              'select',
              { class: 'input' },
              ...(key === 'defaultLanguage' ? ['id', 'en'] : ['profit', 'total']).map((option) =>
                el('option', { value: option, selected: String(value) === option }, option),
              ),
            )
          : el('input', {
              class: 'input',
              type: type ?? 'text',
              value: Array.isArray(value) ? value.join(',') : String(value ?? ''),
            });
      fields[key] = { input, type, isArray: Array.isArray(value) };
      grid.append(el('div', { class: 'field' }, el('label', {}, label), input));
    }
    card.append(grid);
    return card;
  };
  panel.append(
    group('Payout & durasi', [
      ['payoutRate', 'Payout default (0–3)', 'number'],
      ['payoutMode', 'Mode payout', 'select'],
      ['allowedDurations', 'Durasi diizinkan (detik, pisah koma)', 'text'],
      ['maxOpenTradesPerUser', 'Max trade terbuka per user', 'number'],
      ['globalMaxAmountUsd', 'Batas nominal global (USD)', 'number'],
    ]),
    group('Batas & retensi', [
      ['tradeRateLimitPerMin', 'Rate limit trade / menit', 'number'],
      ['loginRateLimitPerMin', 'Rate limit login / menit', 'number'],
      ['topupDailyCount', 'Top-up demo / hari', 'number'],
      ['tickRetentionDays', 'Retensi tick (hari)', 'number'],
      ['candleRetentionDays', 'Retensi candle (hari)', 'number'],
    ]),
    group('Branding & bahasa', [
      ['platformName', 'Nama platform', 'text'],
      ['themeAccent', 'Warna aksen (#rrggbb)', 'text'],
      ['defaultLanguage', 'Bahasa default', 'select'],
      ['defaultTimezone', 'Zona waktu', 'text'],
    ]),
  );
  const disclaimer = el('textarea', { class: 'input' }, settings.disclaimer);
  const terms = el('textarea', { class: 'input' }, settings.platformTerms);
  panel.append(
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card__title' }, 'Disclaimer & syarat'),
      el('div', { class: 'field' }, el('label', {}, 'Disclaimer (wajib tampil di UI)'), disclaimer),
      el('div', { class: 'field' }, el('label', {}, 'Syarat platform'), terms),
      el(
        'div',
        { class: 'alert alert--warn' },
        'Label SIMULASI tidak dapat dimatikan dan semua perubahan pengaturan dicatat di audit log.',
      ),
    ),
    el(
      'div',
      { style: { display: 'flex', gap: '8px' } },
      el(
        'button',
        {
          class: 'btn btn--primary',
          type: 'button',
          onClick: async () => {
            const payload = {};
            for (const [key, meta] of Object.entries(fields)) {
              const raw = meta.input.value;
              if (meta.isArray)
                payload[key] = String(raw)
                  .split(',')
                  .map((value) => Number(value.trim()))
                  .filter((value) => Number.isInteger(value) && value >= 5);
              else if (meta.type === 'number') payload[key] = Number(raw);
              else payload[key] = raw;
            }
            payload.disclaimer = disclaimer.value;
            payload.platformTerms = terms.value;
            try {
              await patch('/api/v1/admin/settings', payload);
              toast({ title: 'Pengaturan disimpan', type: 'win' });
            } catch (error) {
              toast({ title: 'Gagal menyimpan', message: error.message, type: 'error', timeout: 6000 });
            }
          },
        },
        'Simpan pengaturan',
      ),
      el(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          onClick: () => {
            for (const [key, meta] of Object.entries(fields)) {
              const fallback = settings.defaults?.[key];
              if (fallback === undefined) continue;
              meta.input.value = Array.isArray(fallback) ? fallback.join(',') : String(fallback);
            }
          },
        },
        'Kembalikan ke default',
      ),
    ),
  );
}

// ---------------------------------------------------------------------- content
async function renderContent(panel) {
  panel.append(head('Konten', 'Banner terjadwal dan editor halaman (FAQ, syarat, privasi, kontak).'));
  const bannersBox = el('section', { class: 'card' });
  const pagesBox = el('section', { class: 'card' });
  panel.append(bannersBox, pagesBox);

  async function loadBanners() {
    clear(bannersBox);
    const res = await get('/api/v1/admin/banners');
    const title = el('input', { class: 'input', placeholder: 'Judul banner' });
    const body = el('input', { class: 'input', placeholder: 'Isi singkat' });
    const link = el('input', { class: 'input', placeholder: '/faq atau https://…' });
    bannersBox.append(
      el('h2', { class: 'card__title' }, 'Banner'),
      res.banners.length
        ? table(
            [['Judul'], ['Aktif'], ['Jadwal'], ['Aksi']],
            res.banners.map((banner) => [
              el(
                'div',
                {},
                el('div', { style: { fontWeight: '600' } }, banner.title),
                el('div', { class: 'muted', style: { fontSize: '10.5px' } }, banner.body ?? ''),
              ),
              banner.live
                ? el('span', { class: 'pill pill--up' }, 'live')
                : el('span', { class: 'pill pill--muted' }, banner.active ? 'terjadwal' : 'nonaktif'),
              `${banner.startsAt ? dateTime(banner.startsAt) : '—'} → ${banner.endsAt ? dateTime(banner.endsAt) : '—'}`,
              el(
                'div',
                { style: { display: 'flex', gap: '4px' } },
                el(
                  'button',
                  {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    onClick: async () => {
                      await patch(`/api/v1/admin/banners/${banner.id}`, { active: !banner.active });
                      loadBanners();
                    },
                  },
                  banner.active ? 'Nonaktifkan' : 'Aktifkan',
                ),
                el(
                  'button',
                  {
                    class: 'btn btn--danger btn--sm',
                    type: 'button',
                    onClick: async () => {
                      await del(`/api/v1/admin/banners/${banner.id}`);
                      loadBanners();
                    },
                  },
                  'Hapus',
                ),
              ),
            ]),
          )
        : emptyState('Belum ada banner', 'Buat banner untuk pengumuman terjadwal.'),
      el(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '12px' } },
        title,
        body,
        link,
        el(
          'button',
          {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                await post('/api/v1/admin/banners', {
                  title: title.value,
                  body: body.value || null,
                  link: link.value || null,
                  active: true,
                });
                toast({ title: 'Banner dibuat', type: 'win' });
                loadBanners();
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          'Tambah banner',
        ),
      ),
    );
  }

  async function loadPages() {
    clear(pagesBox);
    const res = await get('/api/v1/admin/pages');
    pagesBox.append(el('h2', { class: 'card__title' }, 'Halaman'));
    for (const page of res.pages) {
      const title = el('input', { class: 'input', value: page.title });
      const body = el('textarea', { class: 'input', rows: '8' }, page.body);
      const preview = el('div', { class: 'content-page', style: { marginTop: '8px' } });
      pagesBox.append(
        el(
          'details',
          { style: { borderTop: '1px solid var(--border-soft)', paddingTop: '10px', marginTop: '10px' } },
          el(
            'summary',
            { style: { cursor: 'pointer', fontWeight: '600', marginBottom: '8px' } },
            `${page.slug} · ${page.title}`,
          ),
          el('div', { class: 'field' }, el('label', {}, 'Judul'), title),
          el('div', { class: 'field' }, el('label', {}, 'Isi (Markdown sederhana)'), body),
          el(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            el(
              'button',
              {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                onClick: async () => {
                  try {
                    await put(`/api/v1/admin/pages/${page.slug}`, { title: title.value, body: body.value });
                    toast({ title: 'Halaman disimpan', type: 'win' });
                  } catch (error) {
                    toast({ title: 'Gagal', message: error.message, type: 'error' });
                  }
                },
              },
              'Simpan',
            ),
            el(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                onClick: () => {
                  clear(preview);
                  preview.append(
                    el('h2', {}, title.value),
                    el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px' } }, body.value),
                  );
                },
              },
              'Pratinjau',
            ),
          ),
          preview,
        ),
      );
    }
  }

  await Promise.all([loadBanners(), loadPages()]);
}

// ----------------------------------------------------------------------- system
async function renderSystem(panel) {
  panel.append(head('Sistem', 'Kesehatan, job, backup SQLite, log, dan audit.'));
  const system = await get('/api/v1/admin/system');
  panel.append(
    el(
      'div',
      { class: 'grid grid--4' },
      statCard('Versi', system.version, `Node ${system.node}`),
      statCard('Uptime', `${Math.floor(system.uptimeSec / 60)}m`, `DB ${system.db.driver}`),
      statCard(
        'Ukuran DB',
        `${fmt((system.db.sizeBytes ?? 0) / 1024 / 1024, 2)} MB`,
        `disk bebas ${fmt(system.diskFreeMb ?? 0, 0)} MB`,
      ),
      statCard('WebSocket', fmt(system.ws.connections, 0), `${system.ws.dropped} drop`),
    ),
    el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'card__head' },
        el('h2', { class: 'card__title' }, 'Job terjadwal'),
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              await post('/api/v1/admin/backups', {});
              toast({ title: 'Backup dibuat', type: 'win' });
              renderSystem(panel);
            },
          },
          'Backup sekarang',
        ),
      ),
      table(
        [['Job'], ['Jadwal'], ['Terakhir'], ['Status'], ['Aksi']],
        system.jobs.map((job) => [
          el(
            'div',
            {},
            el('div', { style: { fontWeight: '600' } }, job.label),
            el('div', { class: 'muted', style: { fontSize: '10px' } }, job.name),
          ),
          `${Math.round(job.intervalMs / 1000)}s`,
          job.lastFinishedAt ? dateTime(job.lastFinishedAt) : 'belum',
          el(
            'span',
            {
              class: `pill ${job.lastStatus === 'ok' ? 'pill--up' : job.lastStatus === 'error' ? 'pill--down' : 'pill--muted'}`,
            },
            job.lastStatus,
          ),
          el(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              onClick: async () => {
                try {
                  await post(`/api/v1/admin/jobs/${job.name}/run`, {});
                  toast({ title: `Job ${job.name} dijalankan`, type: 'win' });
                } catch (error) {
                  toast({ title: 'Gagal', message: error.message, type: 'error' });
                }
              },
            },
            'Jalankan',
          ),
        ]),
      ),
    ),
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Backup SQLite'),
        system.backups.length
          ? el(
              'ul',
              { class: 'list-plain' },
              ...system.backups.map((backup) =>
                el(
                  'li',
                  {},
                  el(
                    'span',
                    {},
                    backup.filename,
                    el(
                      'div',
                      { class: 'muted', style: { fontSize: '10.5px' } },
                      `${fmt(backup.sizeBytes / 1024, 0)} KB · ${backup.kind}`,
                    ),
                  ),
                  el(
                    'span',
                    { style: { display: 'flex', gap: '4px' } },
                    el(
                      'a',
                      {
                        class: 'btn btn--ghost btn--sm',
                        href: `/api/v1/admin/backups/${backup.id}/download`,
                        download: '',
                      },
                      'Unduh',
                    ),
                    el(
                      'button',
                      {
                        class: 'btn btn--danger btn--sm',
                        type: 'button',
                        onClick: async () => {
                          await del(`/api/v1/admin/backups/${backup.id}`);
                          renderSystem(panel);
                        },
                      },
                      'Hapus',
                    ),
                  ),
                ),
              ),
            )
          : emptyState('Belum ada backup', 'Buat backup untuk mengunduh salinan database.'),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Peringatan'),
        system.alerts?.length
          ? el(
              'ul',
              { class: 'list-plain' },
              ...system.alerts.map((alert) =>
                el('li', {}, el('span', { class: 'pill pill--warn' }, alert.code), alert.message),
              ),
            )
          : emptyState('Tidak ada peringatan', 'Disk, job, dan koneksi normal.'),
      ),
    ),
    await renderLogs(),
    await renderAudit(),
  );
}

async function renderLogs() {
  const box = el('section', { class: 'card' });
  try {
    const res = await get('/api/v1/admin/logs?limit=100');
    box.append(
      el('h2', { class: 'card__title' }, 'Log aplikasi (tail)'),
      el(
        'div',
        { style: { maxHeight: '260px', overflow: 'auto' } },
        table(
          [['Waktu'], ['Level'], ['Pesan']],
          res.entries.map((entry) => [
            new Date(entry.time).toLocaleTimeString('id-ID'),
            el(
              'span',
              { class: `pill ${entry.level >= 50 ? 'pill--down' : entry.level >= 40 ? 'pill--warn' : 'pill--muted'}` },
              entry.levelLabel,
            ),
            entry.msg,
          ]),
        ),
      ),
    );
  } catch (error) {
    box.append(el('div', { class: 'alert alert--warn' }, error.message));
  }
  return box;
}

async function renderAudit() {
  const box = el('section', { class: 'card' });
  const search = el('input', { class: 'input', placeholder: 'Filter aksi (mis. market)' });
  const listBox = el('div', {});
  const load = async () => {
    clear(listBox);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (search.value.trim()) params.set('action', search.value.trim());
      const res = await get(`/api/v1/admin/audit?${params}`);
      listBox.append(
        table(
          [['Waktu'], ['Aksi'], ['Aktor'], ['Target']],
          res.entries.map((entry) => [
            new Date(entry.created_at).toLocaleString('id-ID'),
            entry.action,
            entry.actor_role,
            `${entry.target_type ?? ''} ${entry.target_id ?? ''}`.trim(),
          ]),
        ),
      );
    } catch (error) {
      listBox.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  };
  const exportButton = el(
    'a',
    { class: 'btn btn--ghost btn--sm', href: '/api/v1/admin/audit/export.csv', download: '' },
    'Ekspor audit',
  );
  box.append(
    el('div', { class: 'card__head' }, el('h2', { class: 'card__title' }, 'Audit log'), exportButton),
    el(
      'div',
      { class: 'admin-toolbar' },
      search,
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: load }, 'Filter'),
    ),
    listBox,
  );
  await load();
  return box;
}

// ------------------------------------------------------------------- payments
async function renderPayments(panel) {
  panel.append(head('Pembayaran', 'Status integrasi KlikQRIS, rekonsiliasi dan callback.'));
  const data = await get('/api/v1/admin/payments');
  const provider = data.provider ?? {};
  const statusRow = (label, value, tone = 'muted') =>
    el('li', {}, el('span', {}, label), el('span', { class: `pill pill--${tone}` }, value));

  const testButton = el(
    'button',
    {
      class: 'btn btn--primary btn--sm',
      type: 'button',
      onClick: async () => {
        testButton.disabled = true;
        try {
          const result = await post('/api/v1/admin/payments/test-connection', {});
          toast({
            title: result.ok ? 'Koneksi OK' : 'Koneksi gagal',
            message: result.message ?? (result.ok ? 'Kredensial diterima provider.' : 'Periksa kredensial di env.'),
            type: result.ok ? 'win' : 'error',
          });
        } catch (error) {
          toast({ title: 'Koneksi gagal', message: error.message, type: 'error' });
        } finally {
          testButton.disabled = false;
        }
      },
    },
    'Tes koneksi',
  );

  const reconcileButton = el(
    'button',
    {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      onClick: async () => {
        reconcileButton.disabled = true;
        try {
          const result = await post('/api/v1/admin/payments/reconcile', {});
          toast({
            title: 'Rekonsiliasi selesai',
            message: `${result.checked ?? 0} transaksi diperiksa · ${result.providerOnly ?? 0} hanya ada di provider.`,
            type: 'info',
          });
        } catch (error) {
          toast({ title: 'Rekonsiliasi gagal', message: error.message, type: 'error' });
        } finally {
          reconcileButton.disabled = false;
        }
      },
    },
    'Rekonsiliasi',
  );

  panel.append(
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'KlikQRIS'),
        el(
          'ul',
          { class: 'list-plain' },
          statusRow('Mode', provider.mode === 'live' ? 'live' : 'sandbox / demo', 'warn'),
          statusRow('API key', provider.apiKeySet ? 'terpasang' : 'belum', provider.apiKeySet ? 'up' : 'muted'),
          statusRow('Merchant', provider.merchantIdMasked ?? '—'),
          statusRow(
            'Webhook secret',
            provider.webhookSecretSet ? 'terpasang' : 'belum',
            provider.webhookSecretSet ? 'up' : 'muted',
          ),
          statusRow('Uang nyata', provider.liveMoney ? 'ya' : 'tidak (demo)', 'warn'),
          statusRow('Signature header', data.webhook?.signatureHeader ?? '—'),
          statusRow('Endpoint callback', data.webhook?.path ?? '/api/webhooks/klikqris'),
        ),
        el('div', { class: 'chip-row', style: { marginTop: '10px' } }, testButton, reconcileButton),
        el(
          'p',
          { class: 'muted', style: { fontSize: '11.5px' } },
          'Kredensial hanya dibaca dari environment server. Callback wajib bertanda tangan HMAC; tanpa secret, semua callback ditolak (fail closed).',
        ),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Ringkasan transaksi'),
        el(
          'ul',
          { class: 'list-plain' },
          statusRow('Deposit menunggu', String(data.stats?.deposits?.pending ?? 0)),
          statusRow('Deposit dibayar', String(data.stats?.deposits?.paid ?? 0), 'up'),
          statusRow('Deposit review', String(data.stats?.deposits?.review ?? 0), 'warn'),
          statusRow('Penarikan menunggu', String(data.stats?.withdrawals?.pending ?? 0)),
          statusRow('Penarikan selesai', String(data.stats?.withdrawals?.completed ?? 0), 'up'),
          statusRow('Callback diterima', String(data.stats?.callbacks ?? 0)),
          statusRow('Callback ditolak', String(data.stats?.rejectedCallbacks ?? 0), 'warn'),
        ),
      ),
    ),
    el(
      'section',
      { class: 'card', style: { marginTop: '12px' } },
      el('h2', { class: 'card__title' }, 'Callback terakhir'),
      (() => {
        const callbacks = (data.callbacks ?? []).slice(0, 20);
        if (!callbacks.length)
          return emptyState('Belum ada callback', 'Provider akan memanggil endpoint ini setelah pembayaran.');
        return table(
          [['Waktu'], ['Order'], ['Status'], ['Diterima'], ['Alasan']],
          callbacks.map((row) => [
            dateTime(row.createdAt ?? row.receivedAt),
            row.orderId ?? row.order_id ?? '—',
            row.status ?? '—',
            row.accepted
              ? el('span', { class: 'pill pill--up' }, 'ya')
              : el('span', { class: 'pill pill--warn' }, 'tidak'),
            row.reason ?? '—',
          ]),
        );
      })(),
    ),
  );
}

// ------------------------------------------------------------------- deposits
async function renderDeposits(panel) {
  panel.append(head('Deposit', 'Verifikasi deposit manual dan pantau transaksi QRIS.'));
  let status = 'all';
  const tableBox = el('div', {});
  const chips = el('div', { class: 'chip-row' });
  for (const option of ['all', 'review', 'pending', 'paid', 'rejected', 'expired']) {
    chips.append(
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(status === option),
          onClick: (event) => {
            status = option;
            [...event.currentTarget.parentElement.children].forEach((chip) =>
              chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
            );
            void load();
          },
        },
        option === 'all' ? 'Semua' : option,
      ),
    );
  }

  const review = (deposit, action) => {
    const reason = el('textarea', { class: 'input', rows: '3', placeholder: 'Alasan (wajib untuk menolak)' });
    const dialog = modal({
      title: `${action === 'approve' ? 'Setujui' : 'Tolak'} deposit ${deposit.id}`,
      body: el(
        'div',
        {},
        el('p', {}, `${deposit.currency} ${fmt(deposit.amount, 0)} · ${deposit.reference ?? deposit.orderId ?? '-'}`),
        action === 'reject'
          ? el('label', { class: 'field' }, el('span', {}, 'Alasan penolakan'), reason)
          : el('p', { class: 'muted' }, 'Saldo demo akan dikreditkan setelah disetujui.'),
      ),
      actions: [
        { label: 'Batal', className: 'btn--ghost' },
        {
          label: action === 'approve' ? 'Setujui' : 'Tolak',
          className: action === 'approve' ? 'btn--primary' : 'btn--danger',
          onClick: async () => {
            try {
              await post(`/api/v1/admin/deposits/${deposit.id}/review`, {
                action,
                ...(action === 'reject' ? { reason: reason.value.trim() } : {}),
              });
              toast({ title: 'Deposit diperbarui', type: 'win' });
              await load();
              return true;
            } catch (error) {
              toast({ title: 'Gagal', message: error.message, type: 'error' });
              return false;
            }
          },
        },
      ],
    });
    void dialog;
  };

  const load = async () => {
    clear(tableBox);
    const data = await get(`/api/v1/admin/deposits?status=${status}&limit=100`).catch((error) => {
      tableBox.append(el('div', { class: 'alert alert--error' }, error.message));
      return null;
    });
    if (!data) return;
    if (!data.items?.length) {
      tableBox.append(emptyState('Tidak ada deposit', 'Deposit baru akan muncul di sini.'));
      return;
    }
    tableBox.append(
      table(
        [['Dibuat'], ['User'], ['Metode'], ['Nominal'], ['Status'], ['Aksi']],
        data.items.map((row) => [
          dateTime(row.createdAt),
          row.userEmail ?? row.userId ?? '—',
          row.method === 'manual' ? 'manual' : 'QRIS',
          money(row.totalAmount ?? row.amount, row.currency),
          statusPill(row.status),
          row.status === 'review'
            ? el(
                'div',
                { class: 'chip-row' },
                el(
                  'button',
                  { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => review(row, 'approve') },
                  'Setujui',
                ),
                el(
                  'button',
                  { class: 'btn btn--danger btn--sm', type: 'button', onClick: () => review(row, 'reject') },
                  'Tolak',
                ),
              )
            : el('span', { class: 'muted small' }, row.orderId ?? '—'),
        ]),
      ),
    );
  };

  panel.append(chips, tableBox);
  await load();
}

// ---------------------------------------------------------------- withdrawals
async function renderWithdrawals(panel) {
  panel.append(
    head('Penarikan', 'Setujui, proses, dan selesaikan penarikan demo. Dana ditahan sampai selesai.'),
    el(
      'div',
      { class: 'alert alert--warn' },
      el('strong', {}, 'Manual. '),
      'Tidak ada transfer otomatis; setiap aksi dicatat di audit log.',
    ),
  );

  let status = 'pending';
  const tableBox = el('div', {});
  const chips = el('div', { class: 'chip-row' });
  for (const option of ['pending', 'review', 'approved', 'processing', 'completed', 'rejected', 'all']) {
    chips.append(
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(status === option),
          onClick: (event) => {
            status = option;
            [...event.currentTarget.parentElement.children].forEach((chip) =>
              chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
            );
            void load();
          },
        },
        option === 'all' ? 'Semua' : option,
      ),
    );
  }

  const act = (row, action) => {
    const reason = el('textarea', { class: 'input', rows: '2', placeholder: 'Alasan (wajib untuk menolak)' });
    const transferRef = el('input', { class: 'input', placeholder: 'Referensi transfer bank' });
    const dialog = modal({
      title: `${action} · ${row.id}`,
      body: el(
        'div',
        {},
        el('p', {}, `${money(row.amount, row.currency)} → ${row.destinationMasked}`),
        action === 'complete'
          ? el('label', { class: 'field' }, el('span', {}, 'Referensi transfer'), transferRef)
          : null,
        action === 'reject' ? el('label', { class: 'field' }, el('span', {}, 'Alasan'), reason) : null,
      ),
      actions: [
        { label: 'Batal', className: 'btn--ghost' },
        {
          label: 'Konfirmasi',
          className: action === 'reject' ? 'btn--danger' : 'btn--primary',
          onClick: async () => {
            try {
              await post(`/api/v1/admin/withdrawals/${row.id}/transition`, {
                action,
                ...(action === 'complete' ? { transferRef: transferRef.value.trim() } : {}),
                ...(action === 'reject' ? { reason: reason.value.trim() } : {}),
              });
              toast({ title: 'Status diperbarui', type: 'win' });
              await load();
              return true;
            } catch (error) {
              toast({ title: 'Gagal', message: error.message, type: 'error' });
              return false;
            }
          },
        },
      ],
    });
    void dialog;
  };

  const nextAction = (statusValue) => {
    if (statusValue === 'pending') return 'approve';
    if (statusValue === 'review') return 'approve';
    if (statusValue === 'approved') return 'process';
    if (statusValue === 'processing') return 'complete';
    return null;
  };

  const load = async () => {
    clear(tableBox);
    const data = await get(`/api/v1/admin/withdrawals?status=${status}&limit=100`).catch((error) => {
      tableBox.append(el('div', { class: 'alert alert--error' }, error.message));
      return null;
    });
    if (!data) return;
    if (!data.items?.length) {
      tableBox.append(emptyState('Tidak ada penarikan', 'Pengajuan pengguna akan muncul di sini.'));
      return;
    }
    tableBox.append(
      table(
        [['Dibuat'], ['User'], ['Nominal'], ['Tujuan'], ['Status'], ['Aksi']],
        data.items.map((row) => {
          const action = nextAction(row.status);
          return [
            dateTime(row.createdAt),
            row.userEmail ?? row.userId ?? '—',
            `${money(row.amount, row.currency)} (net ${money(row.net, row.currency)})`,
            row.destinationMasked,
            statusPill(row.status),
            el(
              'div',
              { class: 'chip-row' },
              action
                ? el(
                    'button',
                    { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => act(row, action) },
                    action,
                  )
                : null,
              ['pending', 'review', 'approved', 'processing'].includes(row.status)
                ? el(
                    'button',
                    { class: 'btn btn--danger btn--sm', type: 'button', onClick: () => act(row, 'reject') },
                    'reject',
                  )
                : null,
              row.transferRef ? el('span', { class: 'small mono' }, row.transferRef) : null,
            ),
          ];
        }),
      ),
    );
  };

  panel.append(chips, tableBox);
  await load();
}

// ------------------------------------------------------------------ currencies
async function renderCurrencies(panel) {
  panel.append(
    head('Mata uang', 'Aktifkan mata uang dan atur limit, biaya serta kurs demo.'),
    el(
      'div',
      { class: 'alert alert--warn' },
      el('strong', {}, 'Hati-hati. '),
      'Menonaktifkan mata uang tidak menghapus saldo. Perubahan limit dan kurs dicatat di audit log.',
    ),
  );

  const data = await get('/api/v1/admin/currencies');
  const box = el('div', {});
  const render = () => {
    clear(box);
    box.append(
      table(
        [
          ['Kode'],
          ['Nama'],
          ['Aktif'],
          ['Deposit'],
          ['Tarik'],
          ['Trading'],
          ['Limit deposit'],
          ['Limit tarik'],
          ['Biaya'],
          ['Kurs IDR'],
          ['Aksi'],
        ],
        data.currencies.map((currency) => [
          el('span', { class: 'mono' }, currency.code),
          currency.name,
          currency.active
            ? el('span', { class: 'pill pill--up' }, 'ya')
            : el('span', { class: 'pill pill--muted' }, 'tidak'),
          currency.depositEnabled ? 'ya' : '—',
          currency.withdrawalEnabled ? 'ya' : '—',
          currency.tradingEnabled ? 'ya' : '—',
          `${money(currency.minDeposit ?? 0, currency.code)} – ${money(currency.maxDeposit ?? 0, currency.code)}`,
          `${money(currency.minWithdrawal ?? 0, currency.code)} – ${money(currency.maxWithdrawal ?? 0, currency.code)}`,
          `${money(currency.withdrawalFee, currency.code)} + ${currency.withdrawalFeeBps / 100}%`,
          currency.fxRateToIdr ? fmt(currency.fxRateToIdr, 2) : '—',
          el(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              onClick: () => edit(currency),
            },
            'Ubah',
          ),
        ]),
      ),
    );
  };

  const edit = (currency) => {
    const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
    const toggle = (label, key) => {
      const input = el('input', { type: 'checkbox', checked: currency[key] });
      return el('label', { class: 'checkbox' }, input, el('span', {}, label));
    };
    const active = el('input', { type: 'checkbox', checked: currency.active });
    const deposit = el('input', { type: 'checkbox', checked: currency.depositEnabled });
    const withdrawal = el('input', { type: 'checkbox', checked: currency.withdrawalEnabled });
    const trading = el('input', { type: 'checkbox', checked: currency.tradingEnabled });
    const minDeposit = el('input', { class: 'input', type: 'number', value: String(currency.minDeposit ?? 0) });
    const maxDeposit = el('input', { class: 'input', type: 'number', value: String(currency.maxDeposit ?? 0) });
    const minWithdrawal = el('input', { class: 'input', type: 'number', value: String(currency.minWithdrawal ?? 0) });
    const maxWithdrawal = el('input', { class: 'input', type: 'number', value: String(currency.maxWithdrawal ?? 0) });
    const fee = el('input', { class: 'input', type: 'number', value: String(currency.withdrawalFee) });
    const feeBps = el('input', { class: 'input', type: 'number', value: String(currency.withdrawalFeeBps) });
    const rate = el('input', {
      class: 'input',
      type: 'number',
      step: '0.0001',
      value: String(currency.fxRateToIdr ?? ''),
    });
    const source = el('input', { class: 'input', value: currency.fxSource ?? '' });

    modal({
      title: `Ubah ${currency.code}`,
      body: el(
        'div',
        {},
        el(
          'div',
          { class: 'chip-row' },
          el('label', { class: 'checkbox' }, active, el('span', {}, 'Aktif')),
          toggle('Deposit', 'depositEnabled'),
          el('label', { class: 'checkbox' }, withdrawal, el('span', {}, 'Tarik')),
          el('label', { class: 'checkbox' }, trading, el('span', {}, 'Trading')),
        ),
        el('div', { class: 'form-row' }, field('Min deposit', minDeposit), field('Maks deposit', maxDeposit)),
        el('div', { class: 'form-row' }, field('Min tarik', minWithdrawal), field('Maks tarik', maxWithdrawal)),
        el('div', { class: 'form-row' }, field('Biaya flat', fee), field('Biaya (bps)', feeBps)),
        el('div', { class: 'form-row' }, field('Kurs ke IDR', rate), field('Sumber kurs', source)),
        el(
          'p',
          { class: 'small muted' },
          'Kurs demo tidak boleh dianggap kurs nyata. Sumber wajib diisi agar nilai tukar dapat diaudit.',
        ),
      ),
      actions: [
        { label: 'Batal', className: 'btn--ghost' },
        {
          label: 'Simpan',
          className: 'btn--primary',
          onClick: async () => {
            try {
              await patch(`/api/v1/admin/currencies/${currency.code}`, {
                active: active.checked,
                depositEnabled: deposit.checked,
                withdrawalEnabled: withdrawal.checked,
                tradingEnabled: trading.checked,
                minDeposit: Number(minDeposit.value) || null,
                maxDeposit: Number(maxDeposit.value) || null,
                minWithdrawal: Number(minWithdrawal.value) || null,
                maxWithdrawal: Number(maxWithdrawal.value) || null,
                withdrawalFee: Number(fee.value),
                withdrawalFeeBps: Number(feeBps.value),
                fxRateToIdr: Number(rate.value) || null,
                fxSource: source.value.trim() || null,
              });
              toast({ title: 'Mata uang diperbarui', type: 'win' });
              const fresh = await get('/api/v1/admin/currencies');
              data.currencies = fresh.currencies;
              render();
              return true;
            } catch (error) {
              toast({ title: 'Gagal', message: error.message, type: 'error' });
              return false;
            }
          },
        },
      ],
    });
  };

  render();
  panel.append(box);
}

// -------------------------------------------------------------- live chat inbox
async function renderChatInbox(panel) {
  panel.append(
    head('Live chat', 'Balas pengguna atau tinggalkan catatan internal.'),
    el(
      'div',
      { class: 'alert alert--warn' },
      el('strong', {}, 'SIMULASI. '),
      'Percakapan disimpan lokal; tidak ada layanan chat pihak ketiga.',
    ),
  );

  const listBox = el('div', { class: 'chat-list' });
  const threadBox = el('div', { class: 'chat-thread', 'aria-live': 'polite' });
  const input = el('textarea', { class: 'input', rows: '2', placeholder: 'Tulis balasan…' });
  const internal = el('input', { type: 'checkbox', id: 'chatInternal' });
  const send = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Kirim');
  const statusSelect = el(
    'select',
    {
      class: 'input',
      'aria-label': 'Status percakapan',
      onChange: async (event) => {
        if (!active) return;
        try {
          await post(`/api/v1/admin/chat/${active.id}/status`, { status: event.target.value });
          toast({ title: 'Status diperbarui', type: 'info' });
          await loadList();
        } catch (error) {
          toast({ title: 'Gagal', message: error.message, type: 'error' });
        }
      },
    },
    el('option', { value: 'open' }, 'open'),
    el('option', { value: 'pending' }, 'pending'),
    el('option', { value: 'closed' }, 'closed'),
  );
  const prioritySelect = el(
    'select',
    {
      class: 'input',
      'aria-label': 'Prioritas',
      onChange: async (event) => {
        if (!active) return;
        try {
          await post(`/api/v1/admin/chat/${active.id}/priority`, { priority: event.target.value });
          toast({ title: 'Prioritas diperbarui', type: 'info' });
          await loadList();
        } catch (error) {
          toast({ title: 'Gagal', message: error.message, type: 'error' });
        }
      },
    },
    el('option', { value: 'low' }, 'low'),
    el('option', { value: 'normal' }, 'normal'),
    el('option', { value: 'high' }, 'high'),
  );

  let conversations = [];
  let active = null;

  const form = el(
    'form',
    {
      class: 'chat-composer',
      onSubmit: async (event) => {
        event.preventDefault();
        if (!active || !input.value.trim()) return;
        send.disabled = true;
        try {
          await post(`/api/v1/admin/chat/${active.id}/messages`, {
            body: input.value.trim(),
            internal: internal.checked,
          });
          input.value = '';
          await loadThread();
          await loadList();
        } catch (error) {
          toast({ title: 'Gagal mengirim', message: error.message, type: 'error' });
        } finally {
          send.disabled = false;
        }
      },
    },
    input,
    el(
      'div',
      { class: 'chat-actions' },
      el('label', { class: 'checkbox' }, internal, el('span', {}, 'Catatan internal')),
      send,
    ),
  );

  const loadThread = async () => {
    if (!active) return;
    const data = await get(`/api/v1/admin/chat/${active.id}`).catch(() => ({ messages: [] }));
    clear(threadBox);
    for (const message of data.messages ?? []) {
      threadBox.append(
        el(
          'div',
          {
            class: `bubble ${message.internal ? 'bubble--internal' : `bubble--${message.senderRole === 'staff' ? 'staff' : 'user'}`}`,
          },
          el('div', {}, message.body),
          el(
            'div',
            { class: 'bubble__meta' },
            `${message.internal ? 'catatan internal' : message.senderRole} · ${dateTime(message.createdAt)}`,
          ),
        ),
      );
    }
    threadBox.scrollTop = threadBox.scrollHeight;
  };

  const loadList = async () => {
    const data = await get('/api/v1/admin/chat').catch(() => ({ conversations: [] }));
    conversations = data.conversations ?? [];
    clear(listBox);
    if (!conversations.length) {
      listBox.append(emptyState('Kotak masuk kosong', 'Pesan pengguna akan muncul di sini.'));
      return;
    }
    if (!active) active = conversations[0];
    for (const conversation of conversations) {
      listBox.append(
        el(
          'button',
          {
            type: 'button',
            class: `chat-item ${conversation.id === active.id ? 'is-active' : ''}`,
            onClick: async () => {
              active = conversation;
              await loadList();
              await loadThread();
            },
          },
          el(
            'div',
            { class: 'spread' },
            el('strong', {}, conversation.subject),
            el('span', { class: 'small muted' }, conversation.status),
          ),
          el(
            'div',
            { class: 'small muted' },
            `${conversation.userEmail ?? conversation.userId} · ${conversation.priority}`,
          ),
          el('div', { class: 'small muted' }, conversation.lastMessage ?? ''),
          conversation.unreadStaff > 0
            ? el('span', { class: 'pill pill--up' }, `${conversation.unreadStaff} baru`)
            : null,
        ),
      );
    }
    if (active) {
      statusSelect.value = active.status;
      prioritySelect.value = active.priority;
      await loadThread();
    }
  };

  panel.append(
    el(
      'div',
      { class: 'chat-layout' },
      listBox,
      el(
        'div',
        { class: 'chat-panel' },
        threadBox,
        form,
        el('div', { class: 'chip-row', style: { padding: '0 12px 12px' } }, statusSelect, prioritySelect),
      ),
    ),
  );
  await loadList();
}

// --------------------------------------------------------------- site & flags
async function renderSite(panel) {
  panel.append(head('Situs & fitur', 'Branding, teks beranda, mode maintenance dan feature flag.'));
  const data = await get('/api/v1/admin/site');
  const site = data.site ?? {};
  const flags = data.flags ?? {};

  const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
  const branding = site.branding ?? {};
  const landing = site.landing ?? {};
  const maintenance = site.maintenance ?? {};

  const name = el('input', { class: 'input', value: branding.name ?? '' });
  const description = el('input', { class: 'input', value: branding.description ?? '' });
  const heroTitle = el('input', { class: 'input', value: landing.heroTitle ?? '' });
  const heroSubtitle = el('textarea', { class: 'input', rows: '2' }, landing.heroSubtitle ?? '');
  const maintenanceOn = el('input', { type: 'checkbox', checked: Boolean(maintenance.enabled) });
  const maintenanceMessage = el('input', { class: 'input', value: maintenance.message ?? '' });

  const save = el(
    'button',
    {
      class: 'btn btn--primary',
      type: 'button',
      onClick: async () => {
        try {
          await patch('/api/v1/admin/site', {
            branding: { name: name.value.trim(), description: description.value.trim() },
            landing: { heroTitle: heroTitle.value.trim(), heroSubtitle: heroSubtitle.value.trim() },
            maintenance: { enabled: maintenanceOn.checked, message: maintenanceMessage.value.trim() },
          });
          toast({ title: 'Pengaturan situs disimpan', type: 'win' });
        } catch (error) {
          toast({ title: 'Gagal menyimpan', message: error.message, type: 'error' });
        }
      },
    },
    'Simpan',
  );

  const flagRows = Object.entries(flags).map(([key, value]) => {
    const toggle = el('input', {
      type: 'checkbox',
      checked: Boolean(value),
      onChange: async (event) => {
        try {
          await patch(`/api/v1/admin/site/flags/${key}`, { enabled: event.target.checked });
          toast({ title: `Flag ${key} diperbarui`, type: 'info' });
        } catch (error) {
          event.target.checked = !event.target.checked;
          toast({ title: 'Gagal', message: error.message, type: 'error' });
        }
      },
    });
    return el(
      'div',
      { class: 'spread' },
      el('span', { class: 'mono' }, key),
      el('label', { class: 'checkbox' }, toggle, el('span', {}, value ? 'aktif' : 'nonaktif')),
    );
  });

  panel.append(
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Branding & beranda'),
        field('Nama platform', name),
        field('Deskripsi', description),
        field('Judul hero', heroTitle),
        field('Subjudul hero', heroSubtitle),
        save,
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', { class: 'card__title' }, 'Maintenance'),
        el('label', { class: 'checkbox' }, maintenanceOn, el('span', {}, 'Aktifkan mode maintenance')),
        field('Pesan maintenance', maintenanceMessage),
        el('p', { class: 'small muted' }, 'Saat aktif, API publik mengembalikan 503 kecuali untuk staf.'),
        el('h2', { class: 'card__title', style: { marginTop: '16px' } }, 'Feature flag'),
        ...flagRows,
      ),
    ),
  );
}

// ---------------------------------------------------------------- permissions
async function renderPermissions(panel) {
  panel.append(head('Peran & izin', 'Matriks izin yang ditegakkan server-side pada setiap endpoint admin.'));
  const res = await get('/api/v1/admin/permissions');
  panel.append(
    el(
      'section',
      { class: 'card' },
      table(
        [['Izin'], ...res.roles.map((role) => [role])],
        res.matrix.map((row) => [
          el('span', { class: 'mono' }, row.permission),
          ...res.roles.map((role) =>
            row.roles[role] ? el('span', { class: 'pill pill--up' }, 'ya') : el('span', { class: 'muted' }, '—'),
          ),
        ]),
      ),
    ),
  );
}

export { SECTIONS };
void emptyState;
void statusPill;
void marketLogo;
void durationLabel;
