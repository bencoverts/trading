import { post } from '../api.js';
import { el } from '../ui.js';
import { authShell, errorBox } from './login.js';

export async function forgotPage({ outlet }) {
  const slot = el('div', {});
  const errorSlot = el('div', {});
  const form = el(
    'div',
    { class: 'stack' },
    el('label', { class: 'field' }, el('span', {}, 'Account email'), el('input', { name: 'email', type: 'email', required: '', autocomplete: 'email' })),
    errorSlot,
    slot,
    el('button', { class: 'btn primary block', type: 'submit' }, 'Send reset link'),
  );
  const shell = authShell(
    'Forgot password',
    'We will send a reset link. Without an email provider the link is shown here (dev mode).',
    form,
    el('div', { class: 'auth-foot' }, el('a', { href: '/login', 'data-link': '' }, 'Back to sign in')),
  );
  outlet.append(shell);

  shell.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    slot.replaceChildren();
    const data = new FormData(event.currentTarget);
    try {
      const res = await post('/api/v1/auth/forgot-password', { email: String(data.get('email') || '').trim() });
      slot.append(el('p', { class: 'hint' }, res.message));
      if (res.devResetLink) {
        const url = new URL(res.devResetLink);
        slot.append(
          el(
            'div',
            { class: 'dev-panel' },
            el('strong', {}, 'Dev mail: reset link'),
            el('a', { href: url.pathname + url.search, 'data-link': '' }, 'Choose a new password'),
          ),
        );
      }
    } catch (err) {
      errorSlot.append(errorBox(err.message));
    }
  });
}
