/**
 * Deposit / withdrawal / payment-status pages.
 *
 * All money lives on the server: nothing here keeps a balance, and no provider
 * call is ever made from the browser. The QRIS payload comes from our own API
 * and is displayed as text so the QRIS app (or the provider's hosted page, when
 * the user chooses to open it) is the only place payment happens.
 */

import { get, post, idempotencyKey } from '../api.js';
import { state, setState, walletFor } from '../store.js';
import { $, clear, dateTime, el, emptyState, fmt, money, statusPill, toast } from '../ui.js';

const SIM_BANNER = () =>
  el(
    'div',
    { class: 'alert alert--warn' },
    el('strong', {}, 'SIMULASI'),
    el(
      'span',
      {},
      'Deposit ini tidak memindahkan uang nyata. Nominal demo dikreditkan setelah pembayaran diverifikasi.',
    ),
  );

const depositStatusLabel = {
  pending: 'Menunggu pembayaran',
  paid: 'Dibayar',
  expired: 'Kedaluwarsa',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  review: 'Menunggu review admin',
  rejected: 'Ditolak',
};

const withdrawalStatusLabel = {
  pending: 'Menunggu',
  review: 'Review',
  approved: 'Disetujui',
  processing: 'Diproses',
  completed: 'Selesai',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
};

const redirectToLogin = () => {
  window.router.go('/login');
  return null;
};

async function loadCurrencies() {
  const data = await get('/api/v1/currencies').catch(() => ({ all: [], currencies: [] }));
  return data;
}

// ------------------------------------------------------------------ deposit

export async function depositPage() {
  if (!state.user) return redirectToLogin();
  const root = $('#view');
  clear(root);

  const currencies = await loadCurrencies();
  const depositable = (currencies.all ?? []).filter((c) => c.depositEnabled);
  const methods = await get('/api/v1/deposits/methods').catch(() => null);
  const site = await get('/api/v1/site').catch(() => null);
  const depositsEnabled = site?.flags?.deposits !== false;

  let method = methods?.provider?.configured ? 'klikqris' : 'manual';
  let currency = depositable[0]?.code ?? 'IDR';
  let amount = depositable[0]?.minDeposit ?? 50_000;

  const resultBox = el('div', { class: 'mt-3' });
  const historyBox = el('div', { class: 'mt-3' });

  const currencySelect = el(
    'select',
    {
      class: 'input',
      id: 'depositCurrency',
      onChange: (event) => {
        currency = event.target.value;
        renderSummary();
      },
    },
    ...depositable.map((c) => el('option', { value: c.code, selected: c.code === currency }, `${c.code} · ${c.name}`)),
  );

  const amountInput = el('input', {
    class: 'input',
    id: 'depositAmount',
    type: 'number',
    min: 1,
    step: currency === 'IDR' ? 1000 : 0.01,
    value: String(amount),
    inputmode: 'decimal',
    onInput: (event) => {
      amount = Number(event.target.value);
      renderSummary();
    },
  });

  const chips = el('div', { class: 'chip-row' });
  const presets = [50_000, 100_000, 250_000, 500_000, 1_000_000];
  for (const preset of presets) {
    chips.append(
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          onClick: () => {
            amount = preset;
            amountInput.value = String(preset);
            renderSummary();
          },
        },
        `+${fmt(preset, 0)}`,
      ),
    );
  }

  const summary = el('div', { class: 'trade-summary' });
  const renderSummary = () => {
    const row = depositable.find((c) => c.code === currency);
    clear(summary);
    summary.append(
      el(
        'div',
        { class: 'spread' },
        el('span', {}, 'Kurs demo'),
        el('strong', {}, `1 ${currency} = ${currency === 'IDR' ? '1' : (row?.fxRateToIdr ?? 0)} IDR`),
      ),
      el(
        'div',
        { class: 'spread' },
        el('span', {}, 'Minimum'),
        el('strong', {}, money(row?.minDeposit ?? 0, currency)),
      ),
      el(
        'div',
        { class: 'spread' },
        el('span', {}, 'Maksimum'),
        el('strong', {}, money(row?.maxDeposit ?? 0, currency)),
      ),
      el('div', { class: 'spread' }, el('span', {}, 'Biaya deposit'), el('strong', {}, 'Gratis')),
      el(
        'p',
        { class: 'small muted' },
        'Kode unik ditambahkan oleh penyedia QRIS; total yang harus dibayar selalu ditampilkan sebelum kamu membayar.',
      ),
    );
  };
  renderSummary();

  const methodToggle = el(
    'div',
    { class: 'chip-row', role: 'tablist', 'aria-label': 'Metode deposit' },
    ...(methods?.methods ?? []).map((item) =>
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          role: 'tab',
          'aria-selected': String(item.id === 'manual' ? method === 'manual' : method === 'klikqris'),
          disabled: !item.enabled,
          title: item.requiresConfiguration ? 'Kredensial KlikQRIS belum diisi di server' : '',
          onClick: () => {
            method = item.id === 'manual' ? 'manual' : 'klikqris';
            [...methodToggle.children].forEach((chip) =>
              chip.setAttribute(
                'aria-selected',
                String(chip === methodToggle.children[methodToggle.children.indexOf(chip)]),
              ),
            );
            [...methodToggle.children].forEach((chip, index) => {
              const target = (methods?.methods ?? [])[index];
              const active = target.id === 'manual' ? method === 'manual' : method === 'klikqris';
              chip.setAttribute('aria-selected', String(active));
            });
            renderManual();
          },
        },
        item.label,
      ),
    ),
  );

  const referenceInput = el('input', {
    class: 'input',
    id: 'depositReference',
    placeholder: 'Contoh: TRX-2026-0001',
    autocomplete: 'off',
  });
  const noteInput = el('textarea', { class: 'input', id: 'depositNote', rows: '3', placeholder: 'Catatan (opsional)' });
  const manualFields = el(
    'div',
    { class: 'mt-3' },
    el('label', { class: 'field' }, el('span', {}, 'ID transaksi / referensi transfer'), referenceInput),
    el('label', { class: 'field' }, el('span', {}, 'Catatan'), noteInput),
    el(
      'p',
      { class: 'small muted' },
      'Deposit manual masuk ke status review. Admin memverifikasi bukti transfer sebelum saldo demo ditambah.',
    ),
  );
  const renderManual = () => {
    manualFields.hidden = method !== 'manual';
  };
  renderManual();

  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Lanjutkan deposit');
  const form = el(
    'form',
    {
      class: 'card',
      onSubmit: async (event) => {
        event.preventDefault();
        if (!depositsEnabled) {
          toast({ title: 'Deposit nonaktif', message: 'Fitur deposit dimatikan oleh admin.', type: 'error' });
          return;
        }
        submit.disabled = true;
        submit.textContent = 'Memproses…';
        try {
          if (method === 'manual') {
            const created = await post(
              '/api/v1/deposits/manual',
              { currency, amount, reference: referenceInput.value.trim(), note: noteInput.value.trim() || undefined },
              { idempotency: idempotencyKey('dep-manual') },
            );
            renderManualResult(created.deposit);
            toast({ title: 'Deposit dibuat', message: 'Menunggu verifikasi admin.', type: 'info' });
          } else {
            const created = await post(
              '/api/v1/deposits',
              { currency, amount },
              { idempotency: idempotencyKey('dep-qris') },
            );
            renderQris(created.deposit);
            toast({ title: 'QRIS dibuat', message: 'Selesaikan pembayaran sebelum kedaluwarsa.', type: 'info' });
          }
          void loadHistory();
        } catch (error) {
          toast({ title: 'Deposit gagal', message: error.message, type: 'error' });
        } finally {
          submit.disabled = false;
          submit.textContent = 'Lanjutkan deposit';
        }
      },
    },
    el('div', { class: 'form-row' }, el('label', { class: 'field' }, el('span', {}, 'Mata uang'), currencySelect)),
    el('label', { class: 'field' }, el('span', {}, `Nominal (${currency})`), amountInput),
    chips,
    summary,
    el('h3', { class: 'mt-3' }, 'Metode pembayaran'),
    methodToggle,
    manualFields,
    submit,
    el(
      'p',
      { class: 'small muted center mt-3' },
      'Dengan melanjutkan kamu setuju bahwa ini akun demo tanpa uang nyata.',
    ),
  );

  let pollTimer = null;
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
  window.__activePage = {
    destroy: stopPolling,
  };

  const renderQris = (deposit) => {
    stopPolling();
    clear(resultBox);
    const poll = async () => {
      try {
        const data = await post(
          `/api/v1/deposits/${deposit.id}/check`,
          {},
          { idempotency: idempotencyKey('dep-check') },
        );
        if (data.deposit.status !== 'pending') {
          stopPolling();
          resultBox.replaceChildren(depositCard(data.deposit, { expanded: true }));
          await loadHistory();
          void refreshWallets();
          if (data.deposit.status === 'paid') {
            toast({
              title: 'Deposit terverifikasi',
              message: `Saldo ${money(data.deposit.totalAmount ?? data.deposit.amount, data.deposit.currency)} ditambahkan.`,
              type: 'win',
            });
          }
        }
      } catch {
        /* 429 cooldown or provider hiccup: try again on the next tick */
      }
    };
    const qrisText = el(
      'code',
      { class: 'mono qris-code' },
      deposit.qrisUrl ?? deposit.orderId ?? '(payload tidak tersedia)',
    );
    resultBox.append(
      el(
        'div',
        { class: 'card deposit-result' },
        el('div', { class: 'page-head' }, el('h2', {}, 'Bayar QRIS'), statusPill(deposit.status)),
        el('p', {}, 'Total yang harus dibayar'),
        el('div', { class: 'price-headline' }, money(deposit.totalAmount ?? deposit.amount, deposit.currency)),
        deposit.uniqueAmount
          ? el('p', { class: 'small muted' }, `Termasuk kode unik ${fmt(deposit.uniqueAmount, 0)} ${deposit.currency}`)
          : null,
        el('p', { class: 'small muted' }, `Order ${deposit.orderId ?? deposit.id}`),
        el('p', { class: 'small muted' }, deposit.expiresAt ? `Kedaluwarsa ${dateTime(deposit.expiresAt)}` : ''),
        el('div', { class: 'mt-3' }, el('span', { class: 'small muted' }, 'Payload QRIS'), qrisText),
        el(
          'div',
          { class: 'chip-row mt-3' },
          el(
            'button',
            {
              type: 'button',
              class: 'chip',
              onClick: async () => {
                try {
                  await globalThis.navigator.clipboard.writeText(qrisText.textContent ?? '');
                  toast({ title: 'Disalin', type: 'info' });
                } catch {
                  toast({ title: 'Tidak bisa menyalin', message: 'Salin manual dari kotak di atas.', type: 'error' });
                }
              },
            },
            'Salin payload',
          ),
          el('button', { type: 'button', class: 'chip', onClick: () => void poll() }, 'Cek status sekarang'),
        ),
        el(
          'p',
          { class: 'small muted' },
          'Buka aplikasi QRIS / mobile banking, lalu pindai payload di atas. Halaman ini memperbarui status secara otomatis. Saldo hanya bertambah setelah verifikasi server.',
        ),
      ),
    );
    pollTimer = setInterval(() => void poll(), 6_000);
  };

  const renderManualResult = (deposit) => {
    clear(resultBox);
    resultBox.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'page-head' }, el('h2', {}, 'Deposit menunggu review'), statusPill(deposit.status)),
        el('p', {}, `${money(deposit.amount, deposit.currency)} · referensi ${deposit.reference ?? '-'}`),
        el(
          'p',
          { class: 'small muted' },
          'Admin akan memverifikasi lalu menyetujui. Kamu akan menerima notifikasi saat saldo demo ditambahkan.',
        ),
      ),
    );
  };

  const depositCard = (deposit, { expanded = false } = {}) =>
    el(
      'div',
      { class: 'card deposit-row' },
      el(
        'div',
        { class: 'spread' },
        el(
          'div',
          {},
          el('strong', {}, money(deposit.totalAmount ?? deposit.amount, deposit.currency)),
          el(
            'div',
            { class: 'small muted' },
            `${deposit.method === 'manual' ? 'Transfer manual' : 'QRIS'} · ${dateTime(deposit.createdAt)}`,
          ),
          deposit.orderId ? el('div', { class: 'small muted mono' }, deposit.orderId) : null,
        ),
        el(
          'div',
          { class: 'right' },
          statusPill(deposit.status),
          el('div', { class: 'small muted' }, depositStatusLabel[deposit.status] ?? deposit.status),
        ),
      ),
      expanded && deposit.status === 'pending'
        ? el(
            'div',
            { class: 'chip-row mt-3' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                onClick: () => {
                  renderQris(deposit);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                },
              },
              'Lihat QR / status',
            ),
          )
        : null,
      deposit.status === 'pending'
        ? el(
            'div',
            { class: 'chip-row mt-3' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                onClick: async () => {
                  try {
                    const data = await post(
                      `/api/v1/deposits/${deposit.id}/check`,
                      {},
                      { idempotency: idempotencyKey('dep-check') },
                    );
                    toast({
                      title: 'Status diperbarui',
                      message: depositStatusLabel[data.deposit.status] ?? data.deposit.status,
                      type: 'info',
                    });
                    await loadHistory();
                    void refreshWallets();
                  } catch (error) {
                    toast({ title: 'Gagal memeriksa status', message: error.message, type: 'error' });
                  }
                },
              },
              'Cek status',
            ),
          )
        : null,
    );

  const loadHistory = async () => {
    const data = await get('/api/v1/deposits').catch(() => ({ deposits: [] }));
    clear(historyBox);
    if (!data.deposits?.length) {
      historyBox.append(emptyState('Belum ada deposit', 'Buat deposit pertamamu untuk mencoba alur pembayaran demo.'));
      return;
    }
    historyBox.append(...data.deposits.slice(0, 12).map((deposit) => depositCard(deposit)));
  };

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Deposit Demo'),
        el('p', { class: 'muted' }, 'Isi saldo demo lewat QRIS atau transfer manual yang diverifikasi admin.'),
      ),
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
    ),
    SIM_BANNER(),
    !depositsEnabled
      ? el(
          'div',
          { class: 'alert alert--error' },
          el('strong', {}, 'Deposit dinonaktifkan'),
          el('span', {}, 'Admin mematikan fitur deposit untuk sementara.'),
        )
      : null,
    depositable.length
      ? form
      : el(
          'div',
          { class: 'card' },
          emptyState(
            'Belum ada mata uang untuk deposit',
            'Admin perlu mengaktifkan deposit pada minimal satu mata uang.',
          ),
        ),
    resultBox,
    el('h2', { class: 'mt-4' }, 'Riwayat deposit'),
    historyBox,
  );
  await loadHistory();
}

async function refreshWallets() {
  try {
    const me = await get('/api/v1/auth/me');
    if (me.wallets) setState({ wallets: me.wallets });
  } catch {
    /* header refresh is best-effort */
  }
}

// ----------------------------------------------------------------- withdraw

export async function withdrawPage() {
  if (!state.user) return redirectToLogin();
  const root = $('#view');
  clear(root);

  const currencies = await loadCurrencies();
  const withdrawable = (currencies.all ?? []).filter((c) => c.withdrawalEnabled);
  const site = await get('/api/v1/site').catch(() => null);
  const enabled = site?.flags?.withdrawals !== false;

  let currency = withdrawable[0]?.code ?? 'IDR';
  let method = 'bank_transfer';
  let amount = withdrawable[0]?.minWithdrawal ?? 50_000;

  const quoteBox = el('div', { class: 'trade-summary' });
  const historyBox = el('div', {});
  const balanceLine = el('p', { class: 'muted' });
  const methodBox = el('div', { class: 'mt-3' });

  const fields = {
    bank: el('input', { class: 'input', id: 'wdBank', placeholder: 'BCA / Mandiri / BRI', autocomplete: 'off' }),
    accountNumber: el('input', {
      class: 'input',
      id: 'wdAccount',
      placeholder: 'Nomor rekening',
      inputmode: 'numeric',
      autocomplete: 'off',
    }),
    accountName: el('input', {
      class: 'input',
      id: 'wdName',
      placeholder: 'Nama pemilik rekening',
      autocomplete: 'off',
    }),
    provider: el('input', { class: 'input', id: 'wdProvider', placeholder: 'GoPay / OVO / DANA', autocomplete: 'off' }),
    phone: el('input', {
      class: 'input',
      id: 'wdPhone',
      placeholder: '08xxxxxxxxxx',
      inputmode: 'tel',
      autocomplete: 'off',
    }),
  };

  const bankFields = el(
    'div',
    {},
    el('label', { class: 'field' }, el('span', {}, 'Bank'), fields.bank),
    el('label', { class: 'field' }, el('span', {}, 'Nomor rekening'), fields.accountNumber),
    el('label', { class: 'field' }, el('span', {}, 'Nama pemilik'), fields.accountName),
  );
  const ewalletFields = el(
    'div',
    {},
    el('label', { class: 'field' }, el('span', {}, 'Penyedia e-wallet'), fields.provider),
    el('label', { class: 'field' }, el('span', {}, 'Nomor HP terdaftar'), fields.phone),
  );

  const renderMethod = () => {
    clear(methodBox);
    methodBox.append(method === 'bank_transfer' ? bankFields : ewalletFields);
  };

  const currencySelect = el(
    'select',
    {
      class: 'input',
      id: 'wdCurrency',
      onChange: (event) => {
        currency = event.target.value;
        amount = withdrawable.find((c) => c.code === currency)?.minWithdrawal ?? amount;
        amountInput.value = String(amount);
        renderBalance();
        void refreshQuote();
      },
    },
    ...withdrawable.map((c) => el('option', { value: c.code, selected: c.code === currency }, `${c.code} · ${c.name}`)),
  );

  const amountInput = el('input', {
    class: 'input',
    id: 'wdAmount',
    type: 'number',
    min: 1,
    step: currency === 'IDR' ? 1000 : 0.01,
    value: String(amount),
    inputmode: 'decimal',
    onInput: (event) => {
      amount = Number(event.target.value);
      void refreshQuote();
    },
  });

  const renderBalance = () => {
    const wallet = walletFor(currency);
    balanceLine.textContent = `Tersedia ${money(wallet.available ?? wallet.balance ?? 0, currency)} · tertahan ${money(wallet.locked ?? 0, currency)}`;
  };

  const quoteState = { fee: 0, net: 0, error: null };
  const refreshQuote = async () => {
    if (!amount || amount <= 0) return;
    try {
      const quote = await get(`/api/v1/withdrawals/quote?currency=${encodeURIComponent(currency)}&amount=${amount}`);
      quoteState.fee = quote.fee ?? 0;
      quoteState.net = quote.net ?? 0;
      quoteState.error = null;
    } catch {
      quoteState.error = 'Nominal tidak valid';
    }
    clear(quoteBox);
    quoteBox.append(
      el('div', { class: 'spread' }, el('span', {}, 'Nominal'), el('strong', {}, money(amount, currency))),
      el('div', { class: 'spread' }, el('span', {}, 'Biaya'), el('strong', {}, money(quoteState.fee, currency))),
      el(
        'div',
        { class: 'spread' },
        el('span', {}, 'Diterima'),
        el('strong', { class: 'up' }, money(quoteState.net, currency)),
      ),
      el(
        'p',
        { class: 'small muted' },
        'Saldo ditahan (locked) saat pengajuan. Dana baru benar-benar didebit setelah admin menyelesaikan transfer.',
      ),
    );
  };

  const methodToggle = el(
    'div',
    { class: 'chip-row', role: 'tablist', 'aria-label': 'Metode penarikan' },
    ...[
      ['bank_transfer', 'Transfer bank'],
      ['ewallet', 'E-wallet'],
    ].map(([value, label]) =>
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          role: 'tab',
          'aria-selected': String(method === value),
          onClick: (event) => {
            method = value;
            [...event.currentTarget.parentElement.children].forEach((chip) =>
              chip.setAttribute('aria-selected', String(chip === event.currentTarget)),
            );
            renderMethod();
          },
        },
        label,
      ),
    ),
  );

  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Ajukan penarikan');
  const resultBox = el('div', { class: 'mt-3' });

  const form = el(
    'form',
    {
      class: 'card',
      onSubmit: async (event) => {
        event.preventDefault();
        if (!enabled) {
          toast({ title: 'Penarikan nonaktif', type: 'error' });
          return;
        }
        const destination =
          method === 'bank_transfer'
            ? {
                bank: fields.bank.value.trim(),
                accountNumber: fields.accountNumber.value.replace(/\s+/g, ''),
                accountName: fields.accountName.value.trim(),
              }
            : { provider: fields.provider.value.trim(), phone: fields.phone.value.replace(/\s+/g, '') };
        submit.disabled = true;
        submit.textContent = 'Mengajukan…';
        try {
          const created = await post(
            '/api/v1/withdrawals',
            { currency, method, amount, destination },
            { idempotency: idempotencyKey('wd') },
          );
          clear(resultBox);
          resultBox.append(
            el(
              'div',
              { class: 'card' },
              el(
                'div',
                { class: 'page-head' },
                el('h3', {}, 'Pengajuan dibuat'),
                statusPill(created.withdrawal.status),
              ),
              el(
                'p',
                {},
                `${money(created.withdrawal.amount, created.withdrawal.currency)} · diterima ${money(created.withdrawal.net, created.withdrawal.currency)}`,
              ),
              el('p', { class: 'small muted' }, `Tujuan ${created.withdrawal.destinationMasked}`),
              el(
                'p',
                { class: 'small muted' },
                'Admin memproses manual. Kamu bisa membatalkan selama status masih menunggu.',
              ),
            ),
          );
          toast({ title: 'Penarikan diajukan', message: 'Dana ditahan sampai admin memproses.', type: 'info' });
          await refreshWallets();
          renderBalance();
          await loadHistory();
        } catch (error) {
          toast({ title: 'Penarikan gagal', message: error.message, type: 'error' });
        } finally {
          submit.disabled = false;
          submit.textContent = 'Ajukan penarikan';
        }
      },
    },
    el('label', { class: 'field' }, el('span', {}, 'Mata uang'), currencySelect),
    balanceLine,
    el('label', { class: 'field' }, el('span', {}, 'Nominal'), amountInput),
    quoteBox,
    methodToggle,
    methodBox,
    submit,
    el(
      'p',
      { class: 'small muted center mt-3' },
      'Penarikan hanya diproses manual oleh admin demo. Tidak ada uang nyata yang dikirim.',
    ),
  );

  const loadHistory = async () => {
    const data = await get('/api/v1/withdrawals').catch(() => ({ withdrawals: [] }));
    clear(historyBox);
    if (!data.withdrawals?.length) {
      historyBox.append(emptyState('Belum ada penarikan', 'Pengajuan penarikan pertamamu akan muncul di sini.'));
      return;
    }
    for (const row of data.withdrawals) {
      historyBox.append(
        el(
          'div',
          { class: 'card deposit-row' },
          el(
            'div',
            { class: 'spread' },
            el(
              'div',
              {},
              el('strong', {}, money(row.amount, row.currency)),
              el(
                'div',
                { class: 'small muted' },
                `${row.method === 'ewallet' ? 'E-wallet' : 'Bank'} · ${row.destinationMasked} · ${dateTime(row.createdAt)}`,
              ),
              el(
                'div',
                { class: 'small muted' },
                `Diterima ${money(row.net, row.currency)} · biaya ${money(row.fee, row.currency)}`,
              ),
              row.reason ? el('div', { class: 'small muted' }, `Catatan: ${row.reason}`) : null,
              row.transferRef ? el('div', { class: 'small mono' }, `Ref transfer ${row.transferRef}`) : null,
            ),
            el(
              'div',
              { class: 'right' },
              statusPill(row.status),
              el('div', { class: 'small muted' }, withdrawalStatusLabel[row.status] ?? row.status),
              row.canCancel
                ? el(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn--ghost btn--sm mt-2',
                      onClick: async () => {
                        try {
                          await post(
                            `/api/v1/withdrawals/${row.id}/cancel`,
                            {},
                            { idempotency: idempotencyKey('wd-cancel') },
                          );
                          toast({
                            title: 'Penarikan dibatalkan',
                            message: 'Dana yang ditahan dikembalikan.',
                            type: 'info',
                          });
                          await refreshWallets();
                          renderBalance();
                          await loadHistory();
                        } catch (error) {
                          toast({ title: 'Gagal membatalkan', message: error.message, type: 'error' });
                        }
                      },
                    },
                    'Batalkan',
                  )
                : null,
            ),
          ),
        ),
      );
    }
  };

  renderMethod();
  renderBalance();
  void refreshQuote();

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Penarikan Demo'),
        el('p', { class: 'muted' }, 'Ajukan penarikan demo; admin memproses manual dan saldo ditahan selama menunggu.'),
      ),
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
    ),
    SIM_BANNER(),
    !enabled
      ? el(
          'div',
          { class: 'alert alert--error' },
          el('strong', {}, 'Penarikan dinonaktifkan'),
          el('span', {}, 'Admin mematikan fitur penarikan untuk sementara.'),
        )
      : null,
    withdrawable.length
      ? form
      : el(
          'div',
          { class: 'card' },
          emptyState(
            'Belum ada mata uang untuk penarikan',
            'Admin perlu mengaktifkan penarikan pada minimal satu mata uang.',
          ),
        ),
    resultBox,
    el('h2', { class: 'mt-4' }, 'Riwayat penarikan'),
    historyBox,
  );
  await loadHistory();
}

// ------------------------------------------------------------ payment status

export async function paymentStatusPage() {
  if (!state.user) return redirectToLogin();
  const root = $('#view');
  clear(root);

  const [methods, deposits, withdrawals] = await Promise.all([
    get('/api/v1/deposits/methods').catch(() => null),
    get('/api/v1/deposits').catch(() => ({ deposits: [] })),
    get('/api/v1/withdrawals').catch(() => ({ withdrawals: [] })),
  ]);

  const provider = methods?.provider;
  const statusRow = (label, value, tone = '') =>
    el('div', { class: 'spread' }, el('span', { class: 'muted' }, label), el('strong', { class: tone }, value));

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Status Pembayaran'),
        el('p', { class: 'muted' }, 'Ringkasan koneksi penyedia dan status transaksi demo.'),
      ),
      el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
    ),
    el(
      'div',
      { class: 'grid grid--2' },
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Penyedia QRIS'),
        statusRow('Provider', provider?.provider === 'klikqris' ? 'KlikQRIS' : (provider?.provider ?? 'tidak ada')),
        statusRow('Mode', provider?.mode === 'live' ? 'live' : 'sandbox / demo'),
        statusRow(
          'Kredensial API',
          provider?.apiKeySet ? 'terpasang' : 'belum diisi',
          provider?.apiKeySet ? 'up' : 'down',
        ),
        statusRow('Merchant', provider?.merchantIdMasked ?? '—'),
        statusRow(
          'Webhook secret',
          provider?.webhookSecretSet ? 'terpasang' : 'belum diisi',
          provider?.webhookSecretSet ? 'up' : 'down',
        ),
        statusRow('Uang nyata', provider?.liveMoney ? 'aktif' : 'tidak — demo saja'),
        el(
          'p',
          { class: 'small muted' },
          'Kredensial hanya ada di environment server. Halaman ini tidak pernah menampilkan API key penuh.',
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Status transaksi'),
        statusRow('Deposit menunggu', String((deposits.deposits ?? []).filter((d) => d.status === 'pending').length)),
        statusRow(
          'Deposit terverifikasi',
          String((deposits.deposits ?? []).filter((d) => d.status === 'paid').length),
          'up',
        ),
        statusRow(
          'Penarikan diproses',
          String(
            (withdrawals.withdrawals ?? []).filter((w) =>
              ['pending', 'review', 'approved', 'processing'].includes(w.status),
            ).length,
          ),
        ),
        statusRow(
          'Penarikan selesai',
          String((withdrawals.withdrawals ?? []).filter((w) => w.status === 'completed').length),
          'up',
        ),
        el(
          'p',
          { class: 'small muted' },
          'Endpoint /api/v1/payments/* lama sudah dipensiunkan. Gunakan halaman Deposit dan Penarikan untuk alur yang sebenarnya.',
        ),
      ),
    ),
    el(
      'div',
      { class: 'card mt-3' },
      el('h2', {}, 'Transaksi terakhir'),
      ...((deposits.deposits ?? [])
        .slice(0, 6)
        .map((deposit) =>
          el(
            'div',
            { class: 'spread' },
            el(
              'span',
              {},
              `Deposit ${deposit.method === 'manual' ? 'manual' : 'QRIS'} · ${dateTime(deposit.createdAt)}`,
            ),
            el(
              'span',
              { class: 'right' },
              `${money(deposit.totalAmount ?? deposit.amount, deposit.currency)} `,
              statusPill(deposit.status),
            ),
          ),
        ) ?? []),
      ...((withdrawals.withdrawals ?? [])
        .slice(0, 6)
        .map((row) =>
          el(
            'div',
            { class: 'spread' },
            el('span', {}, `Penarikan · ${dateTime(row.createdAt)}`),
            el('span', { class: 'right' }, `${money(row.amount, row.currency)} `, statusPill(row.status)),
          ),
        ) ?? []),
    ),
  );
}

// --------------------------------------------------------------- transactions

export async function transactionsPage() {
  if (!state.user) return redirectToLogin();
  const root = $('#view');
  clear(root);

  const data = await get('/api/v1/transactions?limit=60').catch(() => ({ ledger: [], deposits: [], withdrawals: [] }));
  let kind = 'all';

  const ledgerTable = el('div', { class: 'table-wrap' });
  const render = () => {
    clear(ledgerTable);
    const rows = [];
    if (kind !== 'withdrawal') {
      for (const item of data.deposits ?? []) {
        rows.push([
          dateTime(item.createdAt),
          item.method === 'manual' ? 'Deposit manual' : 'Deposit QRIS',
          money(item.totalAmount ?? item.amount, item.currency),
          statusPill(item.status),
          item.orderId ?? item.reference ?? '—',
        ]);
      }
    }
    if (kind !== 'deposit') {
      for (const item of data.withdrawals ?? []) {
        rows.push([
          dateTime(item.createdAt),
          'Penarikan',
          money(item.amount, item.currency),
          statusPill(item.status),
          item.transferRef ?? item.destinationMasked,
        ]);
      }
    }
    rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
    if (!rows.length) {
      ledgerTable.append(emptyState('Belum ada transaksi', 'Riwayat deposit dan penarikan demo akan tampil di sini.'));
      return;
    }
    const table = el('table', { class: 'data' });
    table.append(
      el(
        'thead',
        {},
        el('tr', {}, ...['Waktu', 'Jenis', 'Nominal', 'Status', 'Referensi'].map((label) => el('th', {}, label))),
      ),
      el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((cell) => el('td', {}, cell))))),
    );
    ledgerTable.append(table);
  };

  const chips = el(
    'div',
    { class: 'chip-row' },
    ...[
      ['all', 'Semua'],
      ['deposit', 'Deposit'],
      ['withdrawal', 'Penarikan'],
    ].map(([value, label]) =>
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(kind === value),
          onClick: (event) => {
            kind = value;
            [...event.currentTarget.parentElement.children].forEach((chip) =>
              chip.setAttribute('aria-pressed', String(chip === event.currentTarget)),
            );
            render();
          },
        },
        label,
      ),
    ),
  );

  render();
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Transaksi'),
        el('p', { class: 'muted' }, 'Semua perpindahan saldo demo tercatat di ledger.'),
      ),
    ),
    el(
      'div',
      { class: 'alert alert--warn' },
      el('strong', {}, 'SIMULASI'),
      el('span', {}, 'Tidak ada uang nyata yang berpindah di halaman ini.'),
    ),
    chips,
    ledgerTable,
  );

  const ledger = data.ledger ?? [];
  if (ledger.length) {
    root.append(
      el('h2', { class: 'mt-4' }, 'Buku besar (ledger)'),
      el(
        'div',
        { class: 'table-wrap' },
        (() => {
          const table = el('table', { class: 'data' });
          table.append(
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                ...['Waktu', 'Jenis', 'Arah', 'Nominal', 'Saldo setelah'].map((label) => el('th', {}, label)),
              ),
            ),
            el(
              'tbody',
              {},
              ...ledger.map((row) =>
                el(
                  'tr',
                  {},
                  el('td', {}, dateTime(row.createdAt)),
                  el('td', {}, row.kind),
                  el('td', {}, row.direction === 'credit' ? 'masuk' : 'keluar'),
                  el('td', {}, money(row.amount, row.currency)),
                  el('td', {}, money(row.balanceAfter, row.currency)),
                ),
              ),
            ),
          );
          return table;
        })(),
      ),
    );
  }
}
