/** DOM helpers, formatting, toasts, modals, sheets and small shared widgets. */

import { t } from './i18n.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Creates an element. Text children are inserted with textContent (never innerHTML). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html')
      node.innerHTML = value; // only for our own static icon markup
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const fmt = (value, decimals = 2) =>
  Number(value ?? 0).toLocaleString('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export function money(amount, currency = 'USD', decimals) {
  const digits = decimals ?? (currency === 'IDR' ? 0 : 2);
  const symbols = { USD: '$', IDR: 'Rp', USDT: '₮' };
  return `${symbols[currency] ?? ''} ${fmt(amount, digits)}`.trim();
}

export function relativeTime(ms) {
  const diff = Number(ms) - Date.now();
  const abs = Math.abs(diff);
  const units = [
    [86_400_000, 'h'],
    [3_600_000, 'j'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size);
      return diff >= 0 ? `dalam ${value}${label}` : `${value}${label} lalu`;
    }
  }
  return 'baru saja';
}

export function dateTime(ms, timezone) {
  try {
    return new Date(Number(ms)).toLocaleString('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone || undefined,
    });
  } catch {
    return new Date(Number(ms)).toLocaleString('id-ID');
  }
}

export function durationLabel(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}j`;
  return `${Math.round(seconds / 86_400)}h`;
}

export function initials(name = '') {
  return (
    name
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

/** Market logo with an automatic letter placeholder. */
export function marketLogo(market, size = '') {
  if (market?.logoUrl) {
    const img = el('img', { src: market.logoUrl, alt: '', loading: 'lazy' });
    return el('span', { class: `logo ${size}`.trim() }, img);
  }
  return el('span', { class: `logo ${size}`.trim(), 'aria-hidden': 'true' }, initials(market?.symbol ?? ''));
}

export function skeleton(lines = 3) {
  return el(
    'div',
    { class: 'card', 'aria-busy': 'true' },
    el('div', { class: 'skeleton', style: { height: '16px', width: '40%', marginBottom: '12px' } }),
    ...Array.from({ length: lines }, (_unused, index) =>
      el('div', { class: 'skeleton', style: { height: '12px', width: `${90 - index * 12}%`, marginBottom: '8px' } }),
    ),
  );
}

export function emptyState(title, hint, action) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty__icon', 'aria-hidden': 'true' }, '◌'),
    el('h3', {}, title),
    hint ? el('p', {}, hint) : null,
    action ?? null,
  );
}

export function errorState(error, onRetry) {
  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'alert alert--error' },
      el('strong', {}, t('common.error')),
      el('span', {}, error?.message ?? String(error)),
    ),
    onRetry
      ? el(
          'button',
          { class: 'btn btn--ghost btn--sm', style: { marginTop: '12px' }, onClick: onRetry },
          t('action.retry'),
        )
      : null,
  );
}

// ------------------------------------------------------------------ toasts
let toastHost = null;
export function toast({ title, message, type = 'info', timeout = 4200 } = {}) {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return;
  const icons = { win: '✓', lose: '✕', draw: '＝', error: '!', info: 'i' };
  const node = el(
    'div',
    { class: `toast toast--${type}`, role: 'status' },
    el('span', { 'aria-hidden': 'true', style: { fontSize: '14px', fontWeight: '700' } }, icons[type] ?? 'i'),
    el('div', { class: 'toast__body' }, el('b', {}, title ?? ''), message ? el('span', {}, message) : null),
    el('button', { type: 'button', 'aria-label': 'Tutup', onClick: () => node.remove() }, '×'),
  );
  toastHost.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
}

// ------------------------------------------------------------------ modal
export function modal({ title, body, actions = [], onClose, labelledBy }) {
  const host = document.getElementById('modalHost');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const dialog = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy ?? 'modal-title' },
    el('h2', { id: labelledBy ?? 'modal-title' }, title),
  );
  const content = el('div', {});
  for (const child of [body].flat(3)) {
    if (!child) continue;
    content.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  dialog.append(content);
  const actionsNode = el('div', { class: 'modal__actions' });
  for (const action of actions) {
    actionsNode.append(
      el(
        'button',
        {
          class: `btn ${action.className ?? 'btn--ghost'}`,
          type: 'button',
          onClick: () => {
            if (action.onClick?.() === false) return;
            close();
          },
        },
        action.label,
      ),
    );
  }
  dialog.append(actionsNode);
  backdrop.append(dialog);
  host.append(backdrop);

  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  dialog.querySelector('input, select, textarea, button')?.focus();
  return { close, root: dialog };
}

export function confirmDialog({ title, message, confirmLabel = 'Ya', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const { close } = modal({
      title,
      body: el('p', {}, message ?? ''),
      actions: [
        {
          label: t('action.cancel'),
          className: 'btn--ghost',
          onClick: () => {
            settled = true;
            resolve(false);
          },
        },
        {
          label: confirmLabel,
          className: danger ? 'btn--danger' : 'btn--primary',
          onClick: () => {
            settled = true;
            resolve(true);
          },
        },
      ],
      onClose: () => {
        if (!settled) resolve(false);
        void close;
      },
    });
  });
}

// ------------------------------------------------------------------ sheet (mobile trade panel)
export function openSheet(title, content, { onClose } = {}) {
  const host = document.getElementById('sheetHost');
  clear(host);
  const backdrop = el('div', { class: 'sheet-backdrop', style: { display: 'block' } });
  const sheet = el(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'sheet__handle', 'aria-hidden': 'true' }),
  );
  const contentNode = el('div', {});
  contentNode.append(content);
  sheet.append(contentNode);
  host.append(backdrop, sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));

  const close = () => {
    sheet.classList.remove('is-open');
    backdrop.remove();
    setTimeout(() => {
      sheet.remove();
      onClose?.();
    }, 220);
  };
  backdrop.addEventListener('click', close);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  return { close, sheet };
}

// ------------------------------------------------------------------ tabs
export function tabs(items, initial, onChange) {
  const nav = el('div', { class: 'tabs', role: 'tablist' });
  const buttons = items.map((item) =>
    el(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': String(item.id === initial),
        onClick: () => select(item.id),
      },
      item.label,
    ),
  );
  buttons.forEach((button) => nav.append(button));
  const select = (id) => {
    buttons.forEach((button, index) => button.setAttribute('aria-selected', String(items[index].id === id)));
    onChange?.(id);
  };
  return { nav, select };
}

export function statusPill(status) {
  const map = {
    active: ['pill--up', 'aktif'],
    paused: ['pill--warn', 'pause'],
    inactive: ['pill--muted', 'nonaktif'],
    draft: ['pill--muted', 'draft'],
    deleted: ['pill--down', 'dihapus'],
    closed: ['pill--muted', 'closed'],
  };
  const [cls, label] = map[status] ?? ['pill--muted', status ?? '—'];
  return el('span', { class: `pill ${cls}` }, label);
}

export function resultPill(result) {
  if (!result) return el('span', { class: 'pill pill--muted' }, '—');
  const cls = result === 'win' ? 'pill--up' : result === 'lose' ? 'pill--down' : 'pill--warn';
  const label = result === 'win' ? t('common.win') : result === 'lose' ? t('common.lose') : t('common.draw');
  return el('span', { class: `pill ${cls}` }, label);
}

/** Attaches a debounce helper used by search inputs. */
export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
