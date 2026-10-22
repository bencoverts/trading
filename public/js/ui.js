/** DOM helpers, money formatting, toast and modal. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const CURRENCY_META = {
  USD: { decimals: 2, symbol: '$' },
  IDR: { decimals: 0, symbol: 'Rp' },
  USDT: { decimals: 2, symbol: '₮' },
};

export function money(amount, currency = 'USD') {
  const meta = CURRENCY_META[currency] ?? CURRENCY_META.USD;
  const value = Number(amount) || 0;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  }).format(value);
  return `${meta.symbol} ${formatted}`;
}

export function price(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '–';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function pct(value) {
  if (value === null || value === undefined) return '–';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function clock(ms) {
  if (!ms) return '–';
  return new Date(Number(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(ms) {
  if (!ms) return '–';
  return new Date(Number(ms)).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round((s / 3600) * 10) / 10}h`;
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`.trim() }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

/**
 * Modal dialog. Returns a promise resolving to the confirm value or null.
 * `render` receives { close, resolve } and returns DOM content.
 */
export function openModal({ title, render, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modalHost');
    const close = (value) => {
      backdrop.remove();
      resolve(value);
    };
    const body = el('div', { class: 'modal-body' });
    const footer = el(
      'div',
      { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn ghost', onClick: () => close(null) }, cancelLabel),
      el('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}`, id: 'modalConfirm' }, confirmLabel),
    );
    const form = el(
      'form',
      {
        class: 'modal-card',
        onSubmit: (e) => {
          e.preventDefault();
          close(body.dataset.value === 'false' ? false : true);
        },
      },
      el('h2', {}, title),
      body,
      footer,
    );
    const backdrop = el('div', { class: 'modal-backdrop', onClick: (e) => e.target === backdrop && close(null) }, form);
    host.append(backdrop);
    const content = render?.({ close, body });
    if (content) body.append(content);
    const firstInput = form.querySelector('input, select, textarea, button');
    firstInput?.focus();
  });
}

export function badge(text, kind = '') {
  return el('span', { class: `badge ${kind}`.trim() }, text);
}

export function resultBadge(result) {
  if (result === 'win') return badge('WIN', 'win');
  if (result === 'lose') return badge('LOSE', 'lose');
  if (result === 'draw') return badge('DRAW', 'draw');
  return badge('OPEN', 'open');
}
