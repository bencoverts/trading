import { post } from '../api.js';
import { el, toast } from '../ui.js';
import { authShell, errorBox } from './login.js';
import { navigate } from '../router.js';

export async function resetPage({ outlet, query }) {
  const token = query.get('token') || '';
  const errorSlot = el('div', {});
  const form = el(
    'div',
    { class: 'stack' },
    token
      ? el('p', { class: 'hint' }, 'Reset token detected. Choose a new password (min 8 characters).')
      : el('label', { class: 'field' }, el('span', {}, 'Reset token'), el('input', { name: 'token', required: '', value: token })),
    el('label', { class: 'field' }, el('span', {}, 'New password'), el('input', { name: 'password', type: 'password', required: '', minlength: '8', autocomplete: 'new-password' })),
    errorSlot,
    el('button', { class: 'btn primary block', type: 'submit' }, 'Update password'),
  );
  const shell = authShell('Reset password', 'This link is single use and expires after one hour.', form, el('div', { class: 'auth-foot' }, el('a', { href: '/login', 'data-link': '' }, 'Back to sign in')));
  outlet.append(shell);

  shell.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    const data = new FormData(event.currentTarget);
    try {
      await post('/api/v1/auth/reset-password', {
        token: String(data.get('token') || token),
        password: String(data.get('password') || ''),
      });
      toast('Password updated, please sign in');
      navigate('/login');
    } catch (err) {
      errorSlot.append(errorBox(err.message));
    }
  });
}
