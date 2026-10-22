import { get, post } from '../api.js';
import { t } from '../i18n.js';
import { $, clear, el, errorState, toast } from '../ui.js';

/**
 * All authentication screens share one module: login, register, forgot,
 * reset and verify-email. The server is authoritative for every rule; this
 * page only shows the outcome.
 */
export async function authPage(ctx, { mode, refreshSession } = {}) {
  const root = $('#view');
  clear(root);
  if (mode === 'verify') return renderVerify(ctx, { refreshSession });
  if (mode === 'reset') return renderReset(ctx, { refreshSession });

  const titles = {
    login: [t('auth.loginTitle'), 'Gunakan akun demo. Tidak ada data pembayaran yang diminta.'],
    register: [t('auth.registerTitle'), 'Saldo awal virtual otomatis diberikan. Tidak perlu kartu atau rekening.'],
    forgot: ['Lupa kata sandi', 'Masukkan email akun demo kamu.'],
  };
  const [heading, sub] = titles[mode] ?? titles.login;

  const form = el('form', { novalidate: true });
  const errorBox = el('div', { class: 'hidden' });

  const submit = el(
    'button',
    { class: 'btn btn--primary btn--block', type: 'submit' },
    mode === 'login' ? 'Masuk' : mode === 'register' ? 'Buat akun demo' : 'Kirim tautan reset',
  );

  if (mode === 'login') {
    form.append(
      field('identifier', t('auth.identifier'), { type: 'text', autocomplete: 'username', required: true }),
      field('password', t('auth.password'), { type: 'password', autocomplete: 'current-password', required: true }),
      field('totpCode', `${t('auth.twoFactor')} (opsional)`, {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        placeholder: '123456',
      }),
    );
  } else if (mode === 'register') {
    form.append(
      field('email', t('auth.email'), { type: 'email', autocomplete: 'email', required: true }),
      field('username', t('auth.username'), {
        type: 'text',
        autocomplete: 'username',
        required: true,
        pattern: '[A-Za-z0-9_.-]{3,24}',
      }),
      field('password', t('auth.password'), {
        type: 'password',
        autocomplete: 'new-password',
        required: true,
        minlength: '8',
      }),
      el(
        'label',
        { class: 'checkbox' },
        el('input', { type: 'checkbox', name: 'acceptTerms', required: true }),
        el(
          'span',
          {},
          t('auth.acceptTerms'),
          ' — ',
          el('a', { href: '/terms', 'data-link': '', class: 'dim' }, 'lihat syarat'),
        ),
      ),
    );
  } else {
    form.append(field('email', t('auth.email'), { type: 'email', autocomplete: 'email', required: true }));
  }

  form.append(errorBox, submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    clear(errorBox);
    const data = Object.fromEntries(new FormData(form).entries());
    data.acceptTerms = Boolean(data.acceptTerms);
    submit.disabled = true;
    submit.textContent = 'Memproses…';
    try {
      if (mode === 'login') {
        const res = await post('/api/v1/auth/login', {
          identifier: data.identifier,
          password: data.password,
          ...(data.totpCode ? { totpCode: String(data.totpCode).trim() } : {}),
        });
        if (res?.totpRequired) {
          errorBox.classList.remove('hidden');
          errorBox.append(
            el(
              'div',
              { class: 'alert alert--warn' },
              'Kode 2FA diperlukan. Masukkan kode dari aplikasi authenticator lalu kirim ulang.',
            ),
          );
          return;
        }
        await refreshSession();
        toast({
          title: 'Berhasil masuk',
          message: `Selamat datang, ${res.user.displayName ?? res.user.username}.`,
          type: 'win',
        });
        ctx.navigate?.('/trading');
        window.router.go('/trading');
      } else if (mode === 'register') {
        const res = await post('/api/v1/auth/register', {
          email: data.email,
          username: data.username,
          password: data.password,
          acceptTerms: data.acceptTerms,
          language: 'id',
        });
        await refreshSession();
        if (res.devVerificationLink) {
          toast({
            title: 'Akun demo dibuat',
            message: 'Tautan verifikasi email tercetak di server (mode demo) dan tersedia di halaman akun.',
            type: 'win',
            timeout: 7000,
          });
        }
        window.router.go('/trading');
      } else {
        const res = await post('/api/v1/auth/forgot-password', { email: data.email });
        clear(form);
        form.append(
          el('div', { class: 'alert' }, res.message ?? 'Kalau email terdaftar, tautan reset sudah dibuat.'),
          res.devResetLink
            ? el(
                'p',
                { class: 'dim', style: { fontSize: '12px' } },
                'Mode demo: ',
                el('a', { href: res.devResetLink.replace(location.origin, ''), 'data-link': '' }, 'buka tautan reset'),
              )
            : null,
          el(
            'a',
            { class: 'btn btn--ghost btn--block', style: { marginTop: '12px' }, href: '/login', 'data-link': '' },
            'Kembali ke halaman masuk',
          ),
        );
      }
    } catch (error) {
      errorBox.classList.remove('hidden');
      clear(errorBox);
      errorBox.append(errorState(error));
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Masuk' : mode === 'register' ? 'Buat akun demo' : 'Kirim tautan reset';
    }
  });

  root.append(
    el(
      'div',
      { class: 'auth-shell' },
      el(
        'div',
        { class: 'card' },
        el('h1', {}, heading),
        el('p', { class: 'sub' }, sub),
        form,
        el(
          'div',
          { class: 'auth-links' },
          el(
            'a',
            { href: mode === 'login' ? '/login' : '/login', 'data-link': '' },
            mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk',
          ),
          el('a', { href: '/forgot-password', 'data-link': '' }, t('auth.forgot')),
        ),
      ),
      el(
        'p',
        { class: 'muted center', style: { fontSize: '11.5px' } },
        'Dengan masuk kamu setuju ini adalah demo: tidak ada uang sungguhan dan tidak ada deposit/penarikan.',
      ),
    ),
  );
  void get;
}

function field(name, label, attrs = {}) {
  const id = `f_${name}`;
  return el(
    'div',
    { class: 'field' },
    el('label', { for: id }, label),
    el('input', { class: 'input', id, name, ...attrs }),
  );
}

async function renderVerify(ctx, { refreshSession }) {
  const root = $('#view');
  const token = new URLSearchParams(location.search).get('token');
  root.append(
    el(
      'div',
      { class: 'auth-shell' },
      el(
        'div',
        { class: 'card' },
        el('h1', {}, 'Verifikasi email'),
        el('p', { class: 'sub' }, 'Memproses tautan verifikasi…'),
      ),
    ),
  );
  if (!token) {
    root.firstChild.firstChild.append(
      el('div', { class: 'alert alert--warn' }, 'Token verifikasi tidak ditemukan di tautan.'),
    );
    return;
  }
  try {
    await post('/api/v1/auth/verify-email', { token });
    await refreshSession();
    toast({ title: 'Email terverifikasi', type: 'win' });
    window.router.go('/account');
  } catch (error) {
    root.firstChild.firstChild.append(errorState(error));
  }
  void ctx;
}

async function renderReset(ctx, { refreshSession }) {
  const root = $('#view');
  clear(root);
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const form = el(
    'form',
    { novalidate: true },
    field('password', 'Kata sandi baru', {
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      minlength: '8',
    }),
    field('password2', 'Ulangi kata sandi baru', {
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      minlength: '8',
    }),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Simpan kata sandi'),
  );
  const errorBox = el('div', { class: 'hidden' });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.password !== data.password2) {
      errorBox.classList.remove('hidden');
      errorBox.append(el('div', { class: 'alert alert--error' }, 'Kata sandi tidak sama.'));
      return;
    }
    try {
      await post('/api/v1/auth/reset-password', { token, password: data.password });
      await refreshSession?.();
      toast({ title: 'Kata sandi diperbarui', message: 'Silakan masuk dengan kata sandi baru.', type: 'win' });
      window.router.go('/login');
    } catch (error) {
      errorBox.classList.remove('hidden');
      clear(errorBox);
      errorBox.append(errorState(error));
    }
  });
  root.append(
    el(
      'div',
      { class: 'auth-shell' },
      el(
        'div',
        { class: 'card' },
        el('h1', {}, 'Atur kata sandi baru'),
        el(
          'p',
          { class: 'sub' },
          token
            ? 'Tautan reset hanya bisa dipakai sekali.'
            : 'Token reset tidak ditemukan. Minta tautan baru dari halaman lupa kata sandi.',
        ),
        form,
        errorBox,
      ),
    ),
  );
  void ctx;
}
