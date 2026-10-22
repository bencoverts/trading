import { api, del, get, patch, post } from '../api.js';
import { getLanguage, setLanguage, t, translateDom } from '../i18n.js';
import { saveLocalPrefs, setState, state } from '../store.js';
import { $, clear, el, emptyState, fmt, money, toast } from '../ui.js';

const CURRENCY_NAMES = { USD: 'US Dollar', IDR: 'Rupiah', USDT: 'Tether (demo)' };

export async function accountPage(ctx, { refreshSession, renderHeader } = {}) {
  const root = $('#view');
  clear(root);
  if (!state.user) {
    window.router.go('/login');
    return;
  }
  let profile;
  try {
    profile = await get('/api/v1/account');
  } catch (error) {
    root.append(el('div', { class: 'alert alert--error' }, error.message));
    return;
  }

  const content = el('div', {});
  const sections = {
    profile: () => renderProfile(profile, { refreshSession }),
    wallets: () => renderWallets(profile, { refreshSession, renderHeader }),
    security: () => renderSecurity({ refreshSession }),
    preferences: () => renderPreferences({ refreshSession }),
  };

  const tabRow = el('div', { class: 'tabs', role: 'tablist' });
  const initial = new URLSearchParams(location.search).get('tab') ?? 'profile';
  for (const [id, label] of [
    ['profile', t('account.profile')],
    ['wallets', t('account.wallets')],
    ['security', t('account.security')],
    ['preferences', t('account.preferences')],
  ]) {
    tabRow.append(
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(id === initial),
          onClick: (event) => {
            [...tabRow.children].forEach((button) =>
              button.setAttribute('aria-selected', String(button === event.currentTarget)),
            );
            clear(content);
            content.append(sections[id]());
          },
        },
        label,
      ),
    );
  }

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Akun demo'),
        el(
          'p',
          {},
          `${state.user.email} · ${state.user.username}${state.user.staffRole ? ` · staf: ${state.user.staffRole}` : ''}`,
        ),
      ),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        el('span', { class: 'pill pill--warn' }, 'SIMULASI'),
        el(
          'button',
          { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => window.__logout?.() },
          t('nav.logout'),
        ),
      ),
    ),
    tabRow,
    content,
  );
  clear(content);
  content.append(sections[initial in sections ? initial : 'profile']());
  void ctx;
}

function card(title, ...children) {
  return el('section', { class: 'card', style: { marginBottom: 'var(--space-3)' } }, el('h2', {}, title), ...children);
}

function renderProfile(profile, { refreshSession }) {
  const form = el('form', {});
  const displayName = el('input', {
    class: 'input',
    name: 'displayName',
    value: profile.user.displayName ?? '',
    maxlength: '40',
  });
  const language = el(
    'select',
    { class: 'input', name: 'language' },
    el('option', { value: 'id', selected: profile.user.language === 'id' }, 'Bahasa Indonesia'),
    el('option', { value: 'en', selected: profile.user.language === 'en' }, 'English'),
  );
  const timezone = el('input', { class: 'input', name: 'timezone', value: profile.user.timezone ?? 'Asia/Jakarta' });
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, t('action.save'));

  form.append(
    el(
      'div',
      { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Nama tampilan'), displayName),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Email'),
        el('input', { class: 'input', value: profile.user.email, disabled: true }),
      ),
    ),
    el(
      'div',
      { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Bahasa'), language),
      el('div', { class: 'field' }, el('label', {}, 'Zona waktu'), timezone),
    ),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const res = await patch('/api/v1/account', {
        displayName: displayName.value || null,
        language: language.value,
        timezone: timezone.value,
      });
      setState({ user: res.user });
      if (language.value !== getLanguage()) {
        setLanguage(language.value);
        translateDom();
      }
      await refreshSession?.();
      toast({ title: 'Profil disimpan', type: 'win' });
    } catch (error) {
      toast({ title: 'Gagal menyimpan', message: error.message, type: 'error' });
    } finally {
      submit.disabled = false;
    }
  });

  const verified = profile.user.emailVerified;
  const verify = el(
    'div',
    { class: `alert ${verified ? 'alert--up' : 'alert--warn'}` },
    el('strong', {}, verified ? 'Email terverifikasi' : 'Email belum terverifikasi'),
    !verified
      ? el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                const res = await post('/api/v1/auth/resend-verification', {});
                toast({
                  title: 'Tautan verifikasi dibuat',
                  message: res.devVerificationLink ?? 'Cek konsol server (mode demo).',
                  type: 'info',
                  timeout: 7000,
                });
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          'Kirim ulang',
        )
      : null,
  );

  const avatar = el('form', {
    style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: 'var(--space-3)' },
  });
  const fileInput = el('input', {
    class: 'input',
    type: 'file',
    name: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });
  avatar.append(fileInput, el('button', { class: 'btn btn--ghost btn--sm', type: 'submit' }, 'Unggah avatar'));
  avatar.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!fileInput.files?.length) return;
    const body = new FormData();
    body.append('file', fileInput.files[0]);
    try {
      await api('/api/v1/account/avatar', { method: 'POST', body });
      await refreshSession?.();
      toast({ title: 'Avatar diperbarui', type: 'win' });
    } catch (error) {
      toast({ title: 'Upload gagal', message: error.message, type: 'error' });
    }
  });

  return el(
    'div',
    {},
    card('Profil', form),
    card(
      'Status akun',
      verify,
      avatar,
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px', marginTop: '12px' } },
        'Tidak ada data pembayaran yang disimpan karena platform ini tidak memiliki deposit, penarikan, atau akun live.',
      ),
    ),
  );
}

function renderWallets(profile, { refreshSession, renderHeader }) {
  const wallets = profile.wallets;
  const grid = el('div', { class: 'grid grid--3' });
  const amountInput = el('input', {
    class: 'input',
    type: 'number',
    min: '0',
    step: 'any',
    placeholder: 'Nominal (unit utama)',
  });
  const currency = el(
    'select',
    { class: 'input' },
    ...wallets.map((wallet) =>
      el('option', { value: wallet.currency }, `${wallet.currency} · ${CURRENCY_NAMES[wallet.currency] ?? ''}`),
    ),
  );

  for (const wallet of wallets) {
    grid.append(
      el(
        'div',
        { class: 'wallet-card' },
        el('div', { class: 'wallet-card__ccy' }, `${wallet.currency} · VIRTUAL`),
        el('div', { class: 'wallet-card__value' }, money(wallet.balance, wallet.currency)),
        el(
          'div',
          { class: 'wallet-card__actions' },
          el(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              onClick: () => {
                currency.value = wallet.currency;
                amountInput.focus();
              },
            },
            'Top-up demo',
          ),
        ),
      ),
    );
  }

  const topup = async () => {
    const amount = Number(amountInput.value);
    if (!amount || amount <= 0) {
      toast({ title: 'Nominal belum diisi', type: 'error' });
      return;
    }
    try {
      const res = await post('/api/v1/wallet/topup', { currency: currency.value, amount });
      setState({ wallets: res.wallets });
      await refreshSession?.();
      renderHeader?.();
      toast({ title: 'Saldo demo ditambah', message: `+${money(amount, currency.value)} (uang virtual)`, type: 'win' });
    } catch (error) {
      toast({ title: 'Top-up ditolak', message: error.message, type: 'error' });
    }
  };

  const convert = el(
    'div',
    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-3)' } },
    el('span', { class: 'muted', style: { fontSize: '12px' } }, `Kurs demo: 1 USD = ${fmt(profile.rates.IDR, 0)} IDR`),
    el(
      'button',
      {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onClick: async () => {
          const from = currency.value;
          const target = from === 'USD' ? 'IDR' : 'USD';
          try {
            const res = await post('/api/v1/wallet/convert', { from, to: target, amount: 10 });
            setState({ wallets: res.wallets });
            await refreshSession?.();
            toast({
              title: 'Konversi demo berhasil',
              message: `10 ${from} → ${fmt(res.to.balance - (res.to.balance ?? 0), 2)} ${target}`,
              type: 'win',
            });
          } catch (error) {
            toast({ title: 'Konversi gagal', message: error.message, type: 'error' });
          }
        },
      },
      'Konversi 10 ' + currency.value + ' → ' + (currency.value === 'USD' ? 'IDR' : 'USD'),
    ),
  );

  const reset = el('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Reset Saldo Demo');
  reset.addEventListener('click', async () => {
    if (!confirm('Reset semua saldo demo ke nilai awal? Semua trade terbuka dibatalkan dengan pengembalian penuh.'))
      return;
    try {
      const res = await post('/api/v1/account/reset', {});
      setState({ wallets: res.wallets });
      await refreshSession?.();
      toast({ title: 'Saldo demo direset', message: `${res.voidedTrades} trade dibatalkan`, type: 'win' });
    } catch (error) {
      toast({ title: 'Reset gagal', message: error.message, type: 'error' });
    }
  });

  return el(
    'div',
    {},
    card(
      'Dompet virtual',
      grid,
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px', marginTop: '12px' } },
        'Top-up dan reset hanya menambah saldo virtual dengan batas harian dan jeda waktu. Tidak ada pembayaran nyata.',
      ),
      el(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: 'var(--space-3)' } },
        currency,
        amountInput,
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: topup }, 'Top-up demo'),
      ),
      convert,
      reset,
    ),
    card(
      'Batasan demo',
      el(
        'ul',
        { class: 'list-plain' },
        el(
          'li',
          {},
          el('span', {}, 'Top-up maksimal per transaksi'),
          el(
            'span',
            { class: 'mono' },
            Object.entries(profile.limits.topupMax)
              .map(([c, v]) => `${c} ${fmt(v, c === 'IDR' ? 0 : 2)}`)
              .join(' · '),
          ),
        ),
        el(
          'li',
          {},
          el('span', {}, 'Batas transaksi top-up / hari'),
          el('span', { class: 'mono' }, String(profile.limits.topupDailyCount)),
        ),
        el(
          'li',
          {},
          el('span', {}, 'Stake per trade'),
          el(
            'span',
            { class: 'mono' },
            `${fmt(profile.limits.minAmount.USD, 2)} – ${fmt(profile.limits.maxAmount.USD, 2)} USD`,
          ),
        ),
        el(
          'li',
          {},
          el('span', {}, 'Trade terbuka saat ini'),
          el('span', { class: 'mono' }, `${profile.openTrades} / ${profile.limits.maxOpenTradesPerUser}`),
        ),
        el(
          'li',
          {},
          el('span', {}, 'Kurs demo'),
          el('span', { class: 'mono' }, `1 USD = ${fmt(profile.rates.IDR, 0)} IDR`),
        ),
      ),
    ),
  );
}

function renderSecurity({ refreshSession }) {
  const sessionsBox = el('div', {});
  const passwordForm = el('form', {});
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    minlength: '8',
    required: true,
  });
  const save = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Ubah kata sandi');
  passwordForm.append(
    el(
      'div',
      { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Kata sandi saat ini'), current),
      el('div', { class: 'field' }, el('label', {}, 'Kata sandi baru'), next),
    ),
    save,
  );
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await post('/api/v1/account/password', { currentPassword: current.value, newPassword: next.value });
      await get('/api/v1/auth/csrf').catch(() => null);
      await refreshSession?.();
      toast({ title: 'Kata sandi diperbarui', message: 'Semua perangkat lain dikeluarkan.', type: 'win' });
      loadSessions();
    } catch (error) {
      toast({ title: 'Gagal', message: error.message, type: 'error' });
    } finally {
      save.disabled = false;
    }
  });

  async function loadSessions() {
    clear(sessionsBox);
    sessionsBox.append(el('div', { class: 'skeleton', style: { height: '60px' } }));
    try {
      const res = await get('/api/v1/auth/sessions');
      clear(sessionsBox);
      for (const session of res.sessions) {
        sessionsBox.append(
          el(
            'div',
            { class: 'session-row' },
            el(
              'div',
              {},
              el(
                'div',
                {},
                session.device ?? 'Perangkat',
                session.current ? el('span', { class: 'pill pill--up', style: { marginLeft: '6px' } }, 'ini') : null,
              ),
              el(
                'div',
                { class: 'muted', style: { fontSize: '11px' } },
                `${session.ip ?? '—'} · aktif ${new Date(session.lastSeenAt).toLocaleString('id-ID')}`,
              ),
            ),
            session.current
              ? null
              : el(
                  'button',
                  {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    onClick: async () => {
                      try {
                        await del(`/api/v1/auth/sessions/${session.id}`);
                        loadSessions();
                        toast({ title: 'Sesi dikeluarkan', type: 'win' });
                      } catch (error) {
                        toast({ title: 'Gagal', message: error.message, type: 'error' });
                      }
                    },
                  },
                  'Keluarkan',
                ),
          ),
        );
      }
      sessionsBox.append(
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            style: { marginTop: '10px' },
            onClick: async () => {
              try {
                await post('/api/v1/auth/logout-all', {});
                loadSessions();
                toast({ title: 'Perangkat lain dikeluarkan', type: 'win' });
              } catch (error) {
                toast({ title: 'Gagal', message: error.message, type: 'error' });
              }
            },
          },
          'Keluarkan perangkat lain',
        ),
      );
    } catch (error) {
      clear(sessionsBox);
      sessionsBox.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  }
  loadSessions();

  // --------------------------------------------------------------- 2FA
  const twofaBox = el('div', {});
  const renderTwofa = () => {
    clear(twofaBox);
    if (state.user?.twoFactorEnabled) {
      const password = el('input', { class: 'input', type: 'password', placeholder: 'Kata sandi' });
      const code = el('input', { class: 'input', placeholder: 'Kode 6 digit', maxlength: '6' });
      twofaBox.append(
        el('div', { class: 'alert alert--up' }, '2FA aktif untuk akun ini.'),
        el(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
          password,
          code,
          el(
            'button',
            {
              class: 'btn btn--danger btn--sm',
              type: 'button',
              onClick: async () => {
                try {
                  await post('/api/v1/auth/2fa/disable', { password: password.value, code: code.value });
                  await refreshSession?.();
                  renderTwofa();
                  toast({ title: '2FA dimatikan', type: 'win' });
                } catch (error) {
                  toast({ title: 'Gagal', message: error.message, type: 'error' });
                }
              },
            },
            'Matikan 2FA',
          ),
        ),
      );
      return;
    }
    twofaBox.append(
      el(
        'p',
        { class: 'muted', style: { fontSize: '12px' } },
        'Tambahkan lapisan keamanan dengan aplikasi authenticator (TOTP).',
      ),
      el(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: async () => {
            try {
              const setup = await post('/api/v1/auth/2fa/setup', {});
              clear(twofaBox);
              const code = el('input', { class: 'input', placeholder: 'Kode 6 digit', maxlength: '6' });
              twofaBox.append(
                el('p', {}, '1. Tambahkan secret ini di aplikasi authenticator:'),
                el(
                  'pre',
                  {
                    class: 'mono',
                    style: { background: 'var(--bg-sunken)', padding: '8px', borderRadius: '6px', overflowX: 'auto' },
                  },
                  setup.secret,
                ),
                el('p', { class: 'muted', style: { fontSize: '11px', wordBreak: 'break-all' } }, setup.otpauthUrl),
                el('p', {}, '2. Masukkan kode 6 digit untuk mengaktifkan:'),
                el(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  code,
                  el(
                    'button',
                    {
                      class: 'btn btn--primary btn--sm',
                      type: 'button',
                      onClick: async () => {
                        try {
                          const res = await post('/api/v1/auth/2fa/enable', { code: code.value });
                          await refreshSession?.();
                          clear(twofaBox);
                          twofaBox.append(
                            el('div', { class: 'alert alert--up' }, '2FA aktif. Simpan kode pemulihan ini sekarang:'),
                            el(
                              'pre',
                              {
                                class: 'mono',
                                style: { background: 'var(--bg-sunken)', padding: '8px', borderRadius: '6px' },
                              },
                              res.recoveryCodes.join('\n'),
                            ),
                          );
                        } catch (error) {
                          toast({ title: 'Kode tidak valid', message: error.message, type: 'error' });
                        }
                      },
                    },
                    'Aktifkan',
                  ),
                ),
              );
            } catch (error) {
              toast({ title: 'Gagal', message: error.message, type: 'error' });
            }
          },
        },
        'Aktifkan 2FA',
      ),
    );
  };
  renderTwofa();

  return el(
    'div',
    {},
    card('Kata sandi', passwordForm),
    card('Sesi aktif', sessionsBox),
    card('Autentikasi dua faktor', twofaBox),
  );
}

function renderPreferences({ refreshSession }) {
  const form = el('form', {});
  const currency = el(
    'select',
    { class: 'input' },
    ...['USD', 'IDR', 'USDT'].map((code) =>
      el('option', { value: code, selected: state.user.displayCurrency === code }, `${code} · ${CURRENCY_NAMES[code]}`),
    ),
  );
  const theme = el(
    'select',
    { class: 'input' },
    el('option', { value: 'dark', selected: state.theme === 'dark' }, 'Gelap'),
    el('option', { value: 'light', selected: state.theme === 'light' }, 'Terang'),
  );
  const sound = el('input', { type: 'checkbox', checked: state.soundEnabled });
  const language = el(
    'select',
    { class: 'input' },
    el('option', { value: 'id', selected: state.language === 'id' }, 'Bahasa Indonesia'),
    el('option', { value: 'en', selected: state.language === 'en' }, 'English'),
  );

  form.append(
    el(
      'div',
      { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Mata uang tampilan'), currency),
      el('div', { class: 'field' }, el('label', {}, 'Tema'), theme),
    ),
    el(
      'div',
      { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Bahasa'), language),
      el(
        'label',
        { class: 'checkbox', style: { marginTop: '26px' } },
        sound,
        el('span', {}, 'Suara notifikasi hasil trade'),
      ),
    ),
    el('button', { class: 'btn btn--primary', type: 'submit' }, t('action.save')),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await patch('/api/v1/account', { displayCurrency: currency.value });
      state.theme = theme.value;
      state.soundEnabled = sound.checked;
      document.documentElement.dataset.theme = theme.value;
      saveLocalPrefs();
      setLanguage(language.value);
      translateDom();
      await refreshSession?.();
      toast({ title: 'Preferensi disimpan', type: 'win' });
    } catch (error) {
      toast({ title: 'Gagal', message: error.message, type: 'error' });
    }
  });

  return el(
    'div',
    {},
    card(
      'Preferensi',
      form,
      el(
        'p',
        { class: 'muted', style: { fontSize: '11.5px' } },
        'Mata uang tidak bisa diganti selama masih ada trade terbuka (dikunci server).',
      ),
    ),
    card(
      'Data & privasi',
      el(
        'p',
        { class: 'muted', style: { fontSize: '12px' } },
        'Aplikasi ini menyimpan sesi, trade, dan ledger demo di server. Tidak ada data pembayaran atau KYC.',
      ),
      el('p', {}, el('a', { href: '/privacy', 'data-link': '' }, 'Baca kebijakan privasi demo')),
      emptyState('Ekspor data', 'Gunakan halaman Riwayat untuk mengekspor CSV trade kamu.'),
    ),
  );
}

export { CURRENCY_NAMES };
void api;
