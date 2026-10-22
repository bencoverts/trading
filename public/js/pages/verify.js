import { post } from '../api.js';
import { el, toast } from '../ui.js';
import { authShell, errorBox } from './login.js';
import { navigate } from '../router.js';

export async function verifyPage({ outlet, query }) {
  const token = query.get('token') || '';
  const slot = el('div', { class: 'stack' });
  const shell = authShell(
    'Verify email',
    'Confirming the address attached to your demo account.',
    slot,
    el('div', { class: 'auth-foot' }, el('a', { href: '/trading', 'data-link': '' }, 'Go to trading')),
  );
  outlet.append(shell);

  if (!token) {
    slot.append(
      errorBox('No token in the link.'),
      el('label', { class: 'field' }, el('span', {}, 'Verification token'), el('input', { name: 'token', id: 'tokenInput' })),
      el('button', { class: 'btn primary block', type: 'button', onClick: () => verify(document.getElementById('tokenInput').value) }, 'Verify'),
    );
    return;
  }
  await verify(token);

  async function verify(value) {
    slot.replaceChildren(el('p', { class: 'hint' }, 'Verifying…'));
    try {
      const res = await post('/api/v1/auth/verify-email', { token: value });
      toast('Email verified');
      slot.replaceChildren(
        el('p', { class: 'hint' }, `Email verified for ${res.user.email}.`),
        el('button', { class: 'btn primary block', type: 'button', onClick: () => navigate('/trading') }, 'Continue'),
      );
    } catch (err) {
      slot.replaceChildren(errorBox(err.message));
    }
  }
}
