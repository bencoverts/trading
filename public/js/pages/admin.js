import { get, patch, post } from '../api.js';
import { el, money, price, toast, dateTime, openModal, badge, resultBadge, duration } from '../ui.js';
import { isAdmin, loadConfig, store } from '../state.js';

const TABS = [
  ['dashboard', 'Dashboard'],
  ['markets', 'Markets'],
  ['trades', 'Trades'],
  ['users', 'Users'],
  ['settings', 'Settings'],
  ['audit', 'Audit log'],
];

export async function adminPage({ outlet }) {
  if (!isAdmin()) return;
  await loadConfig(true);

  let tab = 'dashboard';
  const tabBar = el('div', { class: 'tabs admin-tabs' });
  const body = el('div', { class: 'admin-body' });

  outlet.append(
    el(
      'div',
      { class: 'page admin-page' },
      el('div', { class: 'panel-head' },
        el('h1', {}, 'Admin console'),
        el('span', { class: 'muted small' }, 'All prices and balances are simulated. Every change is written to the audit log.'),
      ),
      tabBar,
      body,
    ),
  );

  function renderTabs() {
    tabBar.replaceChildren(
      ...TABS.map(([id, label]) =>
        el('button', { class: `tab ${tab === id ? 'active' : ''}`, type: 'button', onClick: () => void open(id) }, label),
      ),
    );
  }

  async function open(id) {
    tab = id;
    renderTabs();
    body.replaceChildren(el('div', { class: 'panel muted' }, 'Loading…'));
    try {
      if (id === 'dashboard') await dashboard();
      else if (id === 'markets') await markets();
      else if (id === 'trades') await trades();
      else if (id === 'users') await users();
      else if (id === 'settings') await settings();
      else await audit();
    } catch (err) {
      body.replaceChildren(el('div', { class: 'panel error-panel' }, err.message));
    }
  }

  // ------------------------------------------------------------- dashboard
  async function dashboard() {
    const stats = await get('/api/v1/admin/stats');
    const card = (label, value, hint) =>
      el('div', { class: 'stat-card' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value), hint ? el('div', { class: 'muted small' }, hint) : null);
    body.replaceChildren(
      el('div', { class: 'stat-grid' },
        card('Users', String(stats.users.total), `${stats.users.verified} verified · ${stats.users.blocked} blocked`),
        card('Trades', String(stats.trades.total), `${stats.trades.open} open`),
        card('Settled volume', String(stats.trades.volumeMinor) + ' minor', 'sum of closed stakes'),
        card('Total payout', String(stats.trades.payoutMinor) + ' minor', 'paid to traders'),
        card('Simulated profit', String(stats.trades.simulatedProfitMinor) + ' minor', 'volume − payout (mixed currencies)'),
        card('Open exposure', String(stats.trades.openExposureMinor) + ' minor', 'stakes still at risk'),
        card('Win / Lose / Draw', `${stats.trades.wins} / ${stats.trades.losses} / ${stats.trades.draws}`, 'settled trades'),
        card('Demo top-ups', `${stats.demoTopups.count}`, `${stats.demoTopups.totalMinor} minor`),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, 'Wallet totals (per currency, minor units)'),
        el('div', { class: 'kv-list' }, ...stats.wallets.map((w) => el('div', { class: 'kv' }, el('span', {}, w.currency), el('b', {}, String(w.totalMinor))))),
      ),
      el('p', { class: 'hint small' }, 'Minor units: USD/USDT are cents (100 = 1.00), IDR has no decimals. Mixed-currency totals are informational only — a real implementation would report per currency.'),
    );
  }

  // --------------------------------------------------------------- markets
  async function markets() {
    const res = await get('/api/v1/admin/markets');
    body.replaceChildren(
      el('div', { class: 'market-admin-grid' }, ...res.markets.map((m) => marketCard(m))),
    );
  }

  function marketCard(m) {
    const status = el('span', {});
    const refresh = () => {
      status.replaceChildren(m.paused ? badge('PAUSED', 'warn') : badge('OPEN', 'win'));
    };
    const save = async (payload, note) => {
      try {
        const res2 = await patch(`/api/v1/admin/markets/${m.symbol}`, payload);
        Object.assign(m, res2.market);
        refresh();
        toast(`${m.symbol} updated${note ? ` · ${note}` : ''}`, 'win');
      } catch (err) {
        toast(err.message, 'lose');
      }
    };
    refresh();

    const volatility = el('input', { type: 'range', min: '0.1', max: '4', step: '0.1', value: String(m.volatility) });
    const volatilityValue = el('span', { class: 'muted small' }, m.volatility.toFixed(1));
    volatility.addEventListener('input', () => (volatilityValue.textContent = Number(volatility.value).toFixed(1)));

    return el(
      'div',
      { class: 'panel market-card' },
      el('div', { class: 'panel-head' }, el('h2', {}, m.symbol), status),
      el('div', { class: 'muted small' }, m.name),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Live price'), el('b', {}, price(m.engine?.lastPrice, m.priceDecimals))),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Ticks (uptime)'), el('b', {}, String(m.engine?.seq ?? 0))),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Mood (live)'), el('b', {}, m.engine?.mood ?? '–')),
      el('label', { class: 'lbl' }, 'Trend'),
      el('div', { class: 'seg' },
        ...['up', 'down', 'neutral'].map((t) =>
          el('button', { class: `seg-btn ${m.trend === t ? 'active' : ''}`, type: 'button', onClick: () => void save({ trend: t }, `trend ${t}`) }, t),
        ),
      ),
      el('label', { class: 'lbl' }, 'Mood (volatility profile)'),
      el('div', { class: 'seg' },
        ...['sepi', 'normal', 'cepat', 'liar'].map((mo) =>
          el('button', { class: `seg-btn ${m.mood === mo ? 'active' : ''}`, type: 'button', onClick: () => void save({ mood: mo }, `mood ${mo}`) }, mo),
        ),
      ),
      el('label', { class: 'lbl' }, 'Volatility multiplier ', volatilityValue),
      volatility,
      el('button', { class: 'btn small', type: 'button', onClick: () => void save({ volatility: Number(volatility.value) }, 'volatility') }, 'Apply volatility'),
      el('div', { class: 'row gap' },
        m.paused
          ? el('button', { class: 'btn small', type: 'button', onClick: () => void save({ paused: false }, 'resumed') }, 'Resume market')
          : el('button', { class: 'btn small danger-ghost', type: 'button', onClick: () => void pauseMarket(m, save) }, 'Pause market'),
        m.active
          ? el('button', { class: 'btn small ghost', type: 'button', onClick: () => void save({ active: false, paused: true }, 'closed') }, 'Close market')
          : el('button', { class: 'btn small', type: 'button', onClick: () => void save({ active: true }, 'opened') }, 'Open market'),
      ),
    );
  }

  async function pauseMarket(m, save) {
    const confirmed = await openModal({
      title: `Pause ${m.symbol}?`,
      confirmLabel: 'Pause market',
      danger: true,
      render: () => el('p', {}, 'New trades are rejected while paused. Existing trades still settle normally. The reason is stored in the audit log.'),
    });
    if (confirmed) await save({ paused: true, pauseReason: 'paused by admin' }, 'paused');
  }

  // ---------------------------------------------------------------- trades
  async function trades() {
    const filters = { status: '', market: '', result: '' };
    const table = el('div', { class: 'table-wrap' });
    const load = async () => {
      const params = new URLSearchParams({ limit: '100' });
      if (filters.status) params.set('status', filters.status);
      if (filters.market) params.set('market', filters.market);
      if (filters.result) params.set('result', filters.result);
      const res = await get(`/api/v1/admin/trades?${params}`);
      table.replaceChildren(renderTradesTable(res.trades, load));
    };
    body.replaceChildren(
      el('div', { class: 'toolbar' },
        select(['', 'open', 'closed'], filters.status, (v) => { filters.status = v; void load(); }, 'Status'),
        select(['', ...store.markets.map((m) => m.symbol)], filters.market, (v) => { filters.market = v; void load(); }, 'Market'),
        select(['', 'win', 'lose', 'draw'], filters.result, (v) => { filters.result = v; void load(); }, 'Result'),
        el('button', { class: 'btn small', type: 'button', onClick: () => void load() }, 'Refresh'),
      ),
      table,
    );
    await load();
  }

  function renderTradesTable(trades, refresh) {
    if (!trades.length) return el('div', { class: 'empty' }, 'No trades match these filters.');
    return el(
      'table',
      { class: 'data-table' },
      el('thead', {}, el('tr', {},
        ...['Time', 'User', 'Market', 'Dir', 'Amount', 'Duration', 'Entry', 'Close', 'Result', 'Payout', 'Status', ''].map((h) => el('th', {}, h)),
      )),
      el('tbody', {},
        ...trades.map((t) =>
          el('tr', {},
            el('td', { class: 'muted small' }, dateTime(t.createdAt)),
            el('td', {}, t.username),
            el('td', {}, t.market),
            el('td', {}, el('span', { class: `dir ${t.direction}` }, t.direction === 'up' ? 'BUY' : 'SELL')),
            el('td', {}, money(t.amount, t.currency)),
            el('td', {}, duration(t.durationSec)),
            el('td', {}, price(t.entryPrice, 4)),
            el('td', {}, t.closePrice === null ? '–' : price(t.closePrice, 4)),
            el('td', {}, resultBadge(t.result)),
            el('td', {}, t.payout === null ? '–' : money(t.payout, t.currency)),
            el('td', {}, t.status === 'open' ? badge('OPEN', 'open') : badge('CLOSED', '')),
            el('td', {},
              t.status === 'open'
                ? el('button', { class: 'btn small ghost', type: 'button', onClick: () => void settle(t, refresh) }, 'Settle')
                : '',
            ),
          ),
        ),
      ),
    );
  }

  async function settle(trade, refresh) {
    const priceInput = el('input', { type: 'number', step: 'any', placeholder: 'leave empty = current server price' });
    const reason = el('textarea', { rows: '3', maxlength: '300', minlength: '5', placeholder: 'Reason (required, stored in the audit log)' });
    const confirmed = await openModal({
      title: `Manual settlement · ${trade.market}`,
      confirmLabel: 'Settle trade',
      danger: true,
      render: () =>
        el('div', { class: 'stack' },
          el('p', { class: 'hint small' }, `Entry ${trade.entryPrice} · ${trade.direction === 'up' ? 'BUY' : 'SELL'} · ${money(trade.amount, trade.currency)}. Settlement uses the server price unless you override it.`),
          el('label', { class: 'field' }, el('span', {}, 'Close price override (optional)'), priceInput),
          el('label', { class: 'field' }, el('span', {}, 'Reason'), reason),
        ),
    });
    if (!confirmed) return;
    if (reason.value.trim().length < 5) {
      toast('A reason of at least 5 characters is required', 'lose');
      return;
    }
    try {
      await post(`/api/v1/admin/trades/${trade.id}/settle`, {
        reason: reason.value.trim(),
        ...(priceInput.value ? { closePrice: Number(priceInput.value) } : {}),
      });
      toast('Trade settled manually', 'win');
      await refresh();
    } catch (err) {
      toast(err.message, 'lose');
    }
  }

  // ----------------------------------------------------------------- users
  async function users() {
    const search = el('input', { type: 'search', placeholder: 'Search email or username' });
    const table = el('div', { class: 'table-wrap' });
    const load = async () => {
      const res = await get(`/api/v1/admin/users?search=${encodeURIComponent(search.value)}&limit=100`);
      table.replaceChildren(renderUsers(res.users, res.total));
    };
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void load();
    });
    body.replaceChildren(
      el('div', { class: 'toolbar' }, search, el('button', { class: 'btn small', type: 'button', onClick: () => void load() }, 'Search')),
      table,
    );
    await load();

    function renderUsers(list, total) {
      return el('div', {},
        el('p', { class: 'muted small' }, `${total} user(s)`),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {}, ...['Username', 'Email', 'Role', 'Balances', 'Open', 'Status', ''].map((h) => el('th', {}, h)))),
          el('tbody', {},
            ...list.map((u) =>
              el('tr', {},
                el('td', {}, u.username),
                el('td', { class: 'muted' }, u.email),
                el('td', {}, u.role),
                el('td', {}, u.wallets.map((w) => money(w.balance, w.currency)).join(' · ')),
                el('td', {}, String(u.openTrades)),
                el('td', {}, u.blocked ? badge('BLOCKED', 'lose') : u.emailVerified ? badge('verified', 'win') : badge('unverified', 'warn')),
                el('td', { class: 'row gap' },
                  el('button', { class: 'btn small ghost', type: 'button', onClick: () => void userDetail(u) }, 'Detail'),
                  el('button', { class: 'btn small ghost', type: 'button', onClick: () => void adjust(u) }, 'Balance'),
                  el('button', { class: `btn small ${u.blocked ? '' : 'danger-ghost'}`, type: 'button', onClick: () => void toggleBlock(u) }, u.blocked ? 'Unblock' : 'Block'),
                ),
              ),
            ),
          ),
        ),
      );
    }

    async function userDetail(u) {
      const res = await get(`/api/v1/admin/users/${u.id}`);
      await openModal({
        title: `User · ${res.user.username}`,
        confirmLabel: 'Close',
        render: () => {
          const open = res.trades.filter((t) => t.status === 'open');
          return el('div', { class: 'stack' },
            el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Email'), el('b', {}, res.user.email)),
            el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Role'), el('span', {}, res.user.role)),
            el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Created'), el('span', {}, dateTime(res.user.createdAt))),
            el('div', { class: 'kv-list' }, ...res.wallets.map((w) => el('div', { class: 'kv' }, el('span', {}, w.currency), el('b', {}, money(w.balance, w.currency))))),
            el('h3', { class: 'section-title' }, `Open trades (${open.length})`),
            el('div', { class: 'kv-list' }, ...open.map((t) => el('div', { class: 'kv' }, el('span', {}, `${t.market} ${t.direction} ${duration(t.durationSec)}`), el('b', {}, money(t.amount, t.currency))))),
            el('h3', { class: 'section-title' }, 'Recent audit entries'),
            el('div', { class: 'kv-list small' }, ...res.audit.slice(0, 10).map((a) => el('div', { class: 'kv' }, el('span', { class: 'muted' }, `${a.action} · ${dateTime(a.created_at)}`), el('span', {}, a.actor_role)))),
          );
        },
        cancelLabel: 'Close',
      });
    }

    async function adjust(u) {
      const currency = el('select', {}, ...['USD', 'IDR', 'USDT'].map((c) => el('option', { value: c }, c)));
      const delta = el('input', { type: 'number', step: 'any', placeholder: 'e.g. 100 or -25' });
      const reason = el('input', { type: 'text', placeholder: 'Reason (required, audited)' });
      const confirmed = await openModal({
        title: `Adjust demo balance · ${u.username}`,
        confirmLabel: 'Apply adjustment',
        render: () => el('div', { class: 'stack' },
          el('label', { class: 'field' }, el('span', {}, 'Currency'), currency),
          el('label', { class: 'field' }, el('span', {}, 'Delta (major units, may be negative)'), delta),
          el('label', { class: 'field' }, el('span', {}, 'Reason'), reason),
        ),
      });
      if (!confirmed) return;
      try {
        await post(`/api/v1/admin/users/${u.id}/wallet`, {
          currency: currency.value,
          delta: Number(delta.value),
          reason: reason.value.trim() || 'admin adjustment',
        });
        toast('Balance updated', 'win');
        await load();
      } catch (err) {
        toast(err.message, 'lose');
      }
    }

    async function toggleBlock(u) {
      const confirm2 = await openModal({
        title: `${u.blocked ? 'Unblock' : 'Block'} ${u.username}?`,
        confirmLabel: u.blocked ? 'Unblock' : 'Block',
        danger: !u.blocked,
        render: () => el('div', { class: 'stack' },
          el('p', {}, u.blocked ? 'The account can sign in again.' : 'All sessions are revoked and trading/signing in is refused until unblocked.'),
        ),
      });
      if (!confirm2) return;
      try {
        await post(`/api/v1/admin/users/${u.id}/block`, { blocked: !u.blocked, reason: u.blocked ? null : 'blocked by admin' });
        toast('User updated', 'win');
        await load();
      } catch (err) {
        toast(err.message, 'lose');
      }
    }
  }

  // -------------------------------------------------------------- settings
  async function settings() {
    const res = await get('/api/v1/admin/settings');
    const s = res.settings;
    const field = (label, node) => el('label', { class: 'field' }, el('span', {}, label), node);
    const num = (value) => el('input', { type: 'number', step: 'any', value: String(value) });
    const payoutRate = num(s.payoutRate);
    const payoutMode = el('select', {}, ...['profit', 'total'].map((m) => el('option', { value: m, ...(s.payoutMode === m ? { selected: '' } : {}) }, m)));
    const maxOpen = num(s.maxOpenTrades);
    const topupCount = num(s.topupDailyCount);
    const durationInput = el('input', { type: 'text', value: s.allowedDurations.join(', ') });
    const rates = {};
    const minAmounts = {};
    const maxAmounts = {};
    const initial = {};
    const topupMax = {};
    for (const c of ['USD', 'IDR', 'USDT']) {
      rates[c] = num(s.rates[c]);
      minAmounts[c] = num(minorToMajor(s.minAmount[c], c));
      maxAmounts[c] = num(minorToMajor(s.maxAmount[c], c));
      initial[c] = num(minorToMajor(s.initialBalance[c], c));
      topupMax[c] = num(minorToMajor(s.topupMax[c], c));
    }
    const errSlot = el('div', {});

    const save = async () => {
      errSlot.replaceChildren();
      const allowed = durationInput.value
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
      try {
        await patch('/api/v1/admin/settings', {
          payoutRate: Number(payoutRate.value),
          payoutMode: payoutMode.value,
          maxOpenTrades: Number(maxOpen.value),
          topupDailyCount: Number(topupCount.value),
          allowedDurations: allowed,
          rates: Object.fromEntries(Object.entries(rates).map(([c, n]) => [c, Number(n.value)])),
          minAmount: Object.fromEntries(Object.entries(minAmounts).map(([c, n]) => [c, Number(n.value)])),
          maxAmount: Object.fromEntries(Object.entries(maxAmounts).map(([c, n]) => [c, Number(n.value)])),
          initialBalance: Object.fromEntries(Object.entries(initial).map(([c, n]) => [c, Number(n.value)])),
          topupMax: Object.fromEntries(Object.entries(topupMax).map(([c, n]) => [c, Number(n.value)])),
        });
        await loadConfig(true);
        toast('Settings saved (audited)', 'win');
      } catch (err) {
        errSlot.append(el('div', { class: 'form-error' }, err.message));
        toast(err.message, 'lose');
      }
    };

    body.replaceChildren(
      el('div', { class: 'settings-grid' },
        el('section', { class: 'panel' },
          el('h3', {}, 'Trading'),
          field('Payout rate (0.85 = 85% profit)', payoutRate),
          field('Payout mode', payoutMode),
          field('Max open trades per user', maxOpen),
          field('Allowed durations (seconds, comma separated)', durationInput),
          field('Demo top-ups per day', topupCount),
          errSlot,
          el('button', { class: 'btn primary', type: 'button', onClick: () => void save() }, 'Save settings'),
        ),
        el('section', { class: 'panel' },
          el('h3', {}, 'Demo FX rates (units per 1 USD)'),
          ...Object.entries(rates).map(([c, n]) => (c === 'USD' ? el('div', { class: 'kv' }, el('span', {}, 'USD'), el('b', {}, '1 (base)')) : field(c, n))),
          el('h3', { class: 'section-title' }, 'Starting demo balance'),
          ...Object.entries(initial).map(([c, n]) => field(c, n)),
        ),
        el('section', { class: 'panel' },
          el('h3', {}, 'Amount limits (major units)'),
          ...['USD', 'IDR', 'USDT'].flatMap((c) => [field(`min ${c}`, minAmounts[c]), field(`max ${c}`, maxAmounts[c])]),
          el('h3', { class: 'section-title' }, 'Top-up cap per transaction'),
          ...Object.entries(topupMax).map(([c, n]) => field(c, n)),
        ),
      ),
    );
  }

  function minorToMajor(minor, currency) {
    return currency === 'IDR' ? minor : minor / 100;
  }

  // ----------------------------------------------------------------- audit
  async function audit() {
    const actionInput = el('input', { type: 'search', placeholder: 'Filter by action prefix, e.g. admin.' });
    const table = el('div', { class: 'table-wrap' });
    const load = async () => {
      const res = await get(`/api/v1/admin/audit?limit=200&action=${encodeURIComponent(actionInput.value)}`);
      table.replaceChildren(
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {}, ...['Time', 'Actor', 'Role', 'Action', 'Target', 'Meta'].map((h) => el('th', {}, h)))),
          el('tbody', {},
            ...res.entries.map((e) =>
              el('tr', {},
                el('td', { class: 'muted small' }, dateTime(e.created_at)),
                el('td', { class: 'small' }, e.actor_user_id ? e.actor_user_id.slice(0, 8) : '—'),
                el('td', {}, e.actor_role),
                el('td', {}, el('code', {}, e.action)),
                el('td', { class: 'small' }, `${e.target_type ?? ''} ${e.target_id ? e.target_id.slice(0, 12) : ''}`),
                el('td', { class: 'small muted meta-cell' }, e.meta ? JSON.stringify(e.meta).slice(0, 160) : ''),
              ),
            ),
          ),
        ),
      );
    };
    body.replaceChildren(
      el('div', { class: 'toolbar' }, actionInput, el('button', { class: 'btn small', type: 'button', onClick: () => void load() }, 'Filter')),
      table,
    );
    await load();
  }

  function select(options, value, onChange, label) {
    return el('label', { class: 'inline-field' },
      el('span', { class: 'muted small' }, label),
      el('select', { onChange: (e) => onChange(e.target.value) },
        ...options.map((o) => el('option', { value: o, ...(o === value ? { selected: '' } : {}) }, o === '' ? 'all' : o)),
      ),
    );
  }

  renderTabs();
  await open('dashboard');
}
