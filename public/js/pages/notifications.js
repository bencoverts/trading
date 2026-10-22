import { get, post } from '../api.js';
import { $, clear, el, emptyState, relativeTime, toast } from '../ui.js';

export async function notificationsPage() {
  const root = $('#view');
  clear(root);
  const list = el('div', {});
  const head = el(
    'div',
    { class: 'page-head' },
    el('div', {}, el('h1', {}, 'Notifikasi'), el('p', {}, 'Pemberitahuan sistem, hasil trade, dan pengumuman admin.')),
    el(
      'div',
      { style: { display: 'flex', gap: '8px' } },
      el(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: async () => {
            try {
              await post('/api/v1/notifications/read', { id: 'all' });
              await load();
            } catch (error) {
              toast({ title: 'Gagal', message: error.message, type: 'error' });
            }
          },
        },
        'Tandai semua dibaca',
      ),
    ),
  );
  root.append(head, list);

  async function load() {
    clear(list);
    list.append(el('div', { class: 'skeleton', style: { height: '120px' } }));
    try {
      const res = await get('/api/v1/notifications?limit=50');
      clear(list);
      if (!res.items.length) {
        list.append(emptyState('Belum ada notifikasi', 'Notifikasi hasil trade dan pengumuman akan muncul di sini.'));
        return;
      }
      const card = el('section', { class: 'card' });
      for (const item of res.items) {
        card.append(
          el(
            'div',
            { class: 'trade-row' },
            el(
              'div',
              {},
              el(
                'div',
                { style: { fontWeight: item.readAt ? '400' : '600' } },
                item.title,
                item.readAt ? null : el('span', { class: 'pill pill--warn', style: { marginLeft: '6px' } }, 'baru'),
              ),
              item.body ? el('div', { class: 'muted', style: { fontSize: '12px' } }, item.body) : null,
              el('div', { class: 'trade-row__meta' }, relativeTime(item.createdAt)),
            ),
            el(
              'div',
              { class: 'right' },
              item.link ? el('a', { class: 'btn btn--ghost btn--sm', href: item.link, 'data-link': '' }, 'Buka') : null,
              item.readAt
                ? null
                : el(
                    'button',
                    {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      onClick: async () => {
                        await post('/api/v1/notifications/read', { id: item.id });
                        await load();
                      },
                    },
                    'Tandai',
                  ),
            ),
          ),
        );
      }
      list.append(card);
    } catch (error) {
      clear(list);
      list.append(el('div', { class: 'alert alert--error' }, error.message));
    }
  }

  await load();
}
