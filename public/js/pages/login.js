import { post } from '../api.js';
import { $, el, toast } from '../ui.js';
import { loadSession, setDisplayCurrency } from '../state.js';
import { navigate } from '../router.js';

export function authShell(title, subtitle, form, footer) {
  return el(
    'div',
    { class: 'auth-wrap' },
    el(
      'form',
      { class: 'panel auth-card' },
      el('div', { class: 'auth-head' }, el('span', { class: 'badge sim' }, 'SIMULASI'), el('h1', {}, title), el('p', { class: 'muted' }, subtitle)),
      form,
      footer,
    ),
  );
}

export function errorBox(message) {
  const node = el('div', { class: 'form-error', role: 'alert' }, message);
  return node;
}

export async function loginPage({ outlet, query }) {
  const next = query.get('next') || '/trading';
  const errorSlot = el('div', {});
  const form = el(
    'div',
    { class: 'stack' },
    el('label', { class: 'field' }, el('span', {}, 'Email or username'), el('input', { name: 'identifier', required: '', autocomplete: 'username', placeholder: 'you@example.com' })),
    el('label', { class: 'field' }, el('span', {}, 'Password'), el('input', { name: 'password', type: 'password', required: '', autocomplete: 'current-password' })),
    errorSlot,
    el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'),
  );
  const shell = authShell(
    'Sign in',
    'Use your demo account. All balances are virtual.',
    form,
    el(
      'div',
      { class: 'auth-foot' },
      el('a', { href: '/register', 'data-link': '' }, 'Create account'),
      el('span', { class: 'dot' }, '·'),
      el('a', { href: '/forgot-password', 'data-link': '' }, 'Forgot password?'),
    ),
  );
  outlet.append(shell);
  const formEl = shell.querySelector('form');
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    const data = new FormData(formEl);
    const button = formEl.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const res = await post('/api/v1/auth/login', {
        identifier: String(data.get('identifier') || '').trim(),
        password: String(data.get('password') || ''),
      });
      if (res.wallets) {
        const { setWallets } = await import('../state.js');
        setWallets(res.wallets);
      }
      setDisplayCurrency(res.user.displayCurrency);
      await loadSession();
      toast(`Welcome back, ${res.user.username}`);
      navigate(next.startsWith('/') ? next : '/trading');
    } catch (err) {
      errorSlot.append(errorBox(err.message));
      button.disabled = false;
    }
  });
}
