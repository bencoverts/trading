import { post } from '../api.js';
import { el, toast } from '../ui.js';
import { authShell, errorBox } from './login.js';
import { loadSession, setDisplayCurrency, setWallets } from '../state.js';
import { navigate } from '../router.js';

export async function registerPage({ outlet }) {
  const errorSlot = el('div', {});
  const linkSlot = el('div', {});
  const form = el(
    'div',
    { class: 'stack' },
    el('label', { class: 'field' }, el('span', {}, 'Email'), el('input', { name: 'email', type: 'email', required: '', autocomplete: 'email' })),
    el('label', { class: 'field' }, el('span', {}, 'Username'), el('input', { name: 'username', required: '', minlength: '3', maxlength: '24', autocomplete: 'username', pattern: '[A-Za-z0-9_.\\-]+' })),
    el('label', { class: 'field' }, el('span', {}, 'Password'), el('input', { name: 'password', type: 'password', required: '', minlength: '8', autocomplete: 'new-password' })),
    el('p', { class: 'hint' }, 'Demo wallets in USD, IDR and USDT are created automatically. No real money involved.'),
    errorSlot,
    el('button', { class: 'btn primary block', type: 'submit' }, 'Create demo account'),
  );
  const shell = authShell('Create account', 'Virtual demo balances only. Email verification is optional in this build.', form, el('div', { class: 'auth-foot' }, el('a', { href: '/login', 'data-link': '' }, 'Already have an account? Sign in')));
  outlet.append(shell, linkSlot);

  shell.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    const data = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const res = await post('/api/v1/auth/register', {
        email: String(data.get('email') || '').trim(),
        username: String(data.get('username') || '').trim(),
        password: String(data.get('password') || ''),
      });
      setWallets(res.wallets ?? []);
      setDisplayCurrency(res.user.displayCurrency);
      await loadSession();
      toast('Account created with demo balances');
      if (res.devVerificationLink) {
        const link = res.devVerificationLink;
        linkSlot.replaceChildren(
          el(
            'div',
            { class: 'panel dev-panel' },
            el('strong', {}, 'Dev mail: verification link'),
            el('p', { class: 'muted' }, 'In this build the verification link is printed to the browser and server console.'),
            el('a', { href: new URL(link).pathname + new URL(link).search }, 'Verify this email'),
          ),
        );
      }
      navigate('/trading');
    } catch (err) {
      errorSlot.append(errorBox(err.message + (err.details?.length ? ` (${err.details.map((d) => d.message).join(', ')})` : '')));
      button.disabled = false;
    }
  });
}
