import { get, patch, post } from '../api.js';
import { el, money, toast, dateTime, openModal, badge } from '../ui.js';
import { loadSession, setDisplayCurrency, setWallets, store, totalInDisplay } from '../state.js';

export async function accountPage({ outlet }) {
  const account = await loadSession();
  if (!account) return;
  setDisplayCurrency(account.user.displayCurrency);

  const summary = el('div', { class: 'wallet-grid' });
  const txList = el('div', { class: 'tx-list' });
  const profileSlot = el('div', {});
  const messageSlot = el('div', {});

  const layout = el(
    'div',
    { class: 'page-grid' },
    el(
      'section',
      { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h1', {}, 'Account'), badge('DEMO', 'sim')),
      profileSlot,
      el('h3', { class: 'section-title' }, 'Demo wallet summary'),
      summary,
      el('p', { class: 'hint small' }, 'Conversion uses admin-set demo FX rates and only affects the display and demo balances. No real funds exist.'),
      el('div', { class: 'row gap' },
        el('button', { class: 'btn', type: 'button', onClick: () => void topUpModal() }, 'Instant DEMO top-up'),
        el('button', { class: 'btn danger-ghost', type: 'button', onClick: () => void resetDemo() }, 'Reset demo balance'),
      ),
      messageSlot,
      el('h3', { class: 'section-title' }, 'Demo top-up history'),
      txList,
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, 'Security'),
      changePasswordForm(),
      el('h3', { class: 'section-title' }, 'Payment methods'),
      el(
        'div',
        { class: 'notice' },
        el('strong', {}, 'Not available'),
        el('p', { class: 'muted small' }, 'Real-money deposits, withdrawals, QRIS and bank transfers are not implemented. The payments endpoints return 501 "belum tersedia". Only the instant DEMO top-up above exists.'),
      ),
    ),
  );
  outlet.append(layout);

  function renderProfile() {
    const u = account.user;
    profileSlot.replaceChildren(
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Username'), el('b', {}, u.username)),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Email'), el('b', {}, u.email), u.emailVerified ? badge('verified', 'win') : badge('unverified', 'warn')),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Role'), el('span', {}, u.role)),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Member since'), el('span', {}, dateTime(u.createdAt))),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Open trades'), el('span', {}, String(account.openTrades))),
      el(
        'div',
        { class: 'kv' },
        el('span', { class: 'muted' }, 'Display currency'),
        el(
          'select',
          {
            onChange: async (event) => {
              try {
                await patch('/api/v1/account', { displayCurrency: event.target.value });
                account.user.displayCurrency = event.target.value;
                setDisplayCurrency(event.target.value);
                renderWallets();
                toast(`Display currency: ${event.target.value}`);
              } catch (err) {
                toast(err.message, 'lose');
              }
            },
          },
          ...(store.config?.currencies ?? ['USD', 'IDR', 'USDT']).map((c) =>
            el('option', { value: c, ...(c === u.displayCurrency ? { selected: '' } : {}) }, c),
          ),
        ),
      ),
    );
  }

  function renderWallets() {
    const total = totalInDisplay();
    summary.replaceChildren(
      ...account.wallets.map((w) =>
        el(
          'div',
          { class: `wallet-card ${w.currency === store.displayCurrency ? 'active' : ''}` },
          el('div', { class: 'wc-currency' }, w.currency),
          el('div', { class: 'wc-amount' }, money(w.balance, w.currency)),
          el('div', { class: 'muted small' }, `≈ ${money(convert(w.balance, w.currency, store.displayCurrency), store.displayCurrency)} in ${store.displayCurrency}`),
        ),
      ),
      el('div', { class: 'wallet-card total' },
        el('div', { class: 'wc-currency' }, `Total (${store.displayCurrency})`),
        el('div', { class: 'wc-amount' }, money(total, store.displayCurrency)),
        el('div', { class: 'muted small' }, 'admin FX rates (demo)'),
      ),
    );
  }

  function convert(value, from, to) {
    const rates = account.rates ?? { USD: 1, IDR: 16_000, USDT: 1 };
    const usd = value / (rates[from] ?? 1);
    return Math.round(usd * (rates[to] ?? 1) * 100) / 100;
  }

  async function loadTransactions() {
    try {
      const res = await get('/api/v1/wallet/transactions?limit=20');
      txList.replaceChildren(
        ...(res.transactions.length
          ? res.transactions.map((t) =>
              el('div', { class: 'kv' },
                el('span', {}, `${t.kind} · ${dateTime(t.createdAt)}`),
                el('b', { class: 'up' }, `+${money(t.amount, t.currency)}`),
              ),
            )
          : [el('p', { class: 'muted small' }, 'No demo top-ups yet.')]),
      );
    } catch {
      txList.replaceChildren(el('p', { class: 'muted small' }, 'Could not load history.'));
    }
  }

  async function refresh() {
    const fresh = await get('/api/v1/account');
    Object.assign(account, fresh);
    setWallets(fresh.wallets);
    renderProfile();
    renderWallets();
    await loadTransactions();
  }

  renderProfile();
  renderWallets();
  await loadTransactions();

  async function topUpModal() {
    const limits = account.limits.topupMax;
    let currency = store.displayCurrency;
    let value = limits[currency] ? Math.min(limits[currency], currency === 'IDR' ? 100_000 : 100) : 10;
    const errorSlot = el('div', {});
    const input = el('input', { type: 'number', min: '0', step: 'any', value: String(value), class: 'amount-input' });
    const result = await openModal({
      title: 'Instant DEMO top-up',
      confirmLabel: 'Add demo funds',
      render: ({ body, close }) => {
        const confirm = el('button', { class: 'btn primary block', type: 'button', hidden: '', onClick: () => close(true) }, 'Done');
        errorSlot.replaceChildren();
        const form = el('div', { class: 'stack' },
          el('p', { class: 'hint small' }, `Virtual money only. Cap per top-up: ${money(limits[currency], currency)} · ${account.limits.topupDailyCount} top-ups per day.`),
          el('div', { class: 'amount-row' },
            el('select', { onChange: (e) => { currency = e.target.value; input.max = String(limits[currency]); input.value = String(Math.min(limits[currency], currency === 'IDR' ? 100_000 : 100)); } },
              ...Object.keys(limits).map((c) => el('option', { value: c, ...(c === currency ? { selected: '' } : {}) }, c)),
            ),
            input,
          ),
          errorSlot,
        );
        return form;
      },
    });
    if (!result) return;
    try {
      const res = await post('/api/v1/wallet/topup', { currency, amount: Number(input.value) });
      setWallets(res.wallets);
      await refresh();
      toast(res.message ?? 'Demo balance topped up', 'win');
    } catch (err) {
      messageSlot.replaceChildren(el('div', { class: 'form-error' }, err.message));
      toast(err.message, 'lose');
    }
  }

  async function resetDemo() {
    const confirmed = await openModal({
      title: 'Reset demo balance?',
      confirmLabel: 'Reset balance',
      danger: true,
      render: () =>
        el('div', { class: 'stack' },
          el('p', {}, 'Every demo wallet is restored to the admin-configured starting balance. Open trades are voided at entry price (stake refunded).'),
          el('p', { class: 'muted small' }, 'This is a simulation-only action; it is recorded in the audit log.'),
        ),
    });
    if (!confirmed) return;
    try {
      const res = await post('/api/v1/account/reset');
      setWallets(res.wallets);
      await refresh();
      toast('Demo balances reset', 'win');
    } catch (err) {
      toast(err.message, 'lose');
    }
  }

  function changePasswordForm() {
    const slot = el('div', {});
    const form = el(
      'form',
      { class: 'stack small-form' },
      el('label', { class: 'field' }, el('span', {}, 'Current password'), el('input', { type: 'password', name: 'currentPassword', required: '', autocomplete: 'current-password' })),
      el('label', { class: 'field' }, el('span', {}, 'New password (min 8 characters)'), el('input', { type: 'password', name: 'newPassword', minlength: '8', required: '', autocomplete: 'new-password' })),
      slot,
      el('button', { class: 'btn', type: 'submit' }, 'Change password'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      slot.replaceChildren();
      const data = new FormData(form);
      try {
        await post('/api/v1/account/password', {
          currentPassword: String(data.get('currentPassword') || ''),
          newPassword: String(data.get('newPassword') || ''),
        });
        form.reset();
        toast('Password updated', 'win');
      } catch (err) {
        slot.append(el('div', { class: 'form-error' }, err.message));
      }
    });
    return form;
  }
}
