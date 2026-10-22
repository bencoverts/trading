/**
 * Live chat (support) for signed-in users.
 * Messages are persisted server-side; the socket only tells us that something
 * changed, the thread is always re-read from the API so a dropped frame can
 * never leave the UI inconsistent.
 */

import { get, post, idempotencyKey } from '../api.js';
import { state, setState } from '../store.js';
import { $, clear, dateTime, el, emptyState, toast } from '../ui.js';

export async function liveChatPage() {
  if (!state.user) {
    window.router.go('/login');
    return;
  }
  const root = $('#view');
  clear(root);

  const listBox = el('div', { class: 'chat-list', role: 'list' });
  const threadBox = el('div', { class: 'chat-thread', 'aria-live': 'polite' });
  const composer = el('form', { class: 'chat-composer' });
  const statusNote = el('div', { class: 'small muted' });
  let conversations = [];
  let activeId = null;
  let enabled = true;
  let pollTimer = null;

  const input = el('textarea', {
    class: 'input',
    rows: '2',
    placeholder: 'Tulis pesan… (Enter untuk kirim, Shift+Enter baris baru)',
    'aria-label': 'Pesan',
    onKeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        composer.requestSubmit();
      }
    },
  });
  const sendButton = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Kirim');
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp',
    hidden: true,
    id: 'chatFile',
  });
  const attachButton = el('label', { class: 'btn btn--ghost btn--sm', for: 'chatFile' }, 'Lampirkan');

  const scrollToEnd = () => {
    threadBox.scrollTop = threadBox.scrollHeight;
  };

  const sendMessage = async (attachmentUrl) => {
    const body = input.value.trim();
    if (!body && !attachmentUrl) return;
    if (!activeId) {
      const created = await post(
        '/api/v1/chat',
        { subject: 'Bantuan pengguna' },
        { idempotency: idempotencyKey('chat') },
      );
      activeId = created.conversation.id;
    }
    sendButton.disabled = true;
    try {
      await post(
        `/api/v1/chat/${activeId}/messages`,
        { body, clientId: idempotencyKey('msg'), ...(attachmentUrl ? { attachmentUrl } : {}) },
        { idempotency: idempotencyKey('msg') },
      );
      input.value = '';
      await loadThread();
    } catch (error) {
      toast({ title: 'Pesan gagal dikirim', message: error.message, type: 'error' });
    } finally {
      sendButton.disabled = false;
    }
  };

  composer.append(input, el('div', { class: 'chat-actions' }, attachButton, fileInput, sendButton));
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > (state.config?.uploads?.maxBytes ?? 524_288)) {
      toast({ title: 'File terlalu besar', message: 'Maksimal 512 KB.', type: 'error' });
      return;
    }
    if (!activeId) {
      const created = await post(
        '/api/v1/chat',
        { subject: 'Bantuan pengguna' },
        { idempotency: idempotencyKey('chat') },
      );
      activeId = created.conversation.id;
    }
    const form = new FormData();
    form.append('file', file);
    try {
      const uploaded = await post(`/api/v1/chat/${activeId}/upload`, form, { idempotency: idempotencyKey('upload') });
      await sendMessage(uploaded.url ?? uploaded.path);
      toast({ title: 'Lampiran terkirim', type: 'info' });
    } catch (error) {
      toast({ title: 'Upload gagal', message: error.message, type: 'error' });
    } finally {
      fileInput.value = '';
    }
  });

  const renderList = () => {
    clear(listBox);
    if (!conversations.length) {
      listBox.append(
        emptyState('Belum ada percakapan', 'Mulai chat untuk bertanya soal demo, deposit, atau penarikan.'),
      );
      return;
    }
    for (const conversation of conversations) {
      listBox.append(
        el(
          'button',
          {
            type: 'button',
            class: `chat-item ${conversation.id === activeId ? 'is-active' : ''}`,
            role: 'listitem',
            onClick: () => {
              activeId = conversation.id;
              renderList();
              void loadThread();
            },
          },
          el(
            'div',
            { class: 'spread' },
            el('strong', {}, conversation.subject),
            el('span', { class: 'small muted' }, conversation.status),
          ),
          el('div', { class: 'small muted' }, conversation.lastMessage ?? 'Belum ada pesan'),
          el('div', { class: 'small muted' }, dateTime(conversation.lastMessageAt ?? conversation.createdAt)),
          conversation.unreadUser > 0
            ? el('span', { class: 'pill pill--up' }, `${conversation.unreadUser} baru`)
            : null,
        ),
      );
    }
  };

  const loadThread = async () => {
    if (!activeId) {
      clear(threadBox);
      threadBox.append(
        emptyState(
          'Pilih atau mulai percakapan',
          'Tim support (demo) akan membalas dari panel admin. Tidak ada data pribadi yang diperlukan.',
          enabled
            ? el(
                'button',
                {
                  type: 'button',
                  class: 'btn btn--primary',
                  onClick: async () => {
                    try {
                      const created = await post(
                        '/api/v1/chat',
                        { subject: 'Bantuan pengguna' },
                        { idempotency: idempotencyKey('chat') },
                      );
                      activeId = created.conversation.id;
                      await loadList();
                      await loadThread();
                    } catch (error) {
                      toast({ title: 'Gagal memulai chat', message: error.message, type: 'error' });
                    }
                  },
                },
                'Mulai percakapan',
              )
            : null,
        ),
      );
      return;
    }
    try {
      const data = await get(`/api/v1/chat/${activeId}/messages`);
      clear(threadBox);
      if (!data.messages?.length) {
        threadBox.append(el('p', { class: 'small muted center' }, 'Belum ada pesan. Sampaikan pertanyaanmu di bawah.'));
      }
      for (const message of data.messages) {
        threadBox.append(
          el(
            'div',
            { class: `bubble bubble--${message.senderRole}` },
            message.body ? el('div', {}, message.body) : null,
            message.attachmentUrl
              ? el(
                  'a',
                  { href: message.attachmentUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small' },
                  'Lihat lampiran',
                )
              : null,
            el(
              'div',
              { class: 'bubble__meta' },
              `${message.senderRole === 'staff' ? 'Support' : 'Kamu'} · ${dateTime(message.createdAt)}`,
            ),
          ),
        );
      }
      scrollToEnd();
    } catch (error) {
      clear(threadBox);
      threadBox.append(el('p', { class: 'alert alert--error' }, error.message));
    }
  };

  const loadList = async () => {
    const data = await get('/api/v1/chat').catch((error) => {
      toast({ title: 'Gagal memuat chat', message: error.message, type: 'error' });
      return { conversations: [], enabled: false };
    });
    conversations = data.conversations ?? [];
    enabled = data.enabled !== false;
    if (!activeId && conversations.length) activeId = conversations[0].id;
    renderList();
  };

  const newButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      disabled: !enabled,
      onClick: async () => {
        try {
          const created = await post(
            '/api/v1/chat',
            { subject: 'Bantuan pengguna' },
            { idempotency: idempotencyKey('chat') },
          );
          activeId = created.conversation.id;
          await loadList();
          await loadThread();
        } catch (error) {
          toast({ title: 'Gagal memulai chat', message: error.message, type: 'error' });
        }
      },
    },
    'Percakapan baru',
  );

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'Live Chat'),
        el('p', { class: 'muted' }, 'Tanya tim support soal akun demo, deposit, atau penarikan.'),
      ),
      newButton,
    ),
    el(
      'div',
      { class: 'alert alert--warn' },
      el('strong', {}, 'SIMULASI'),
      el('span', {}, 'Chat ini dilayani staf demo dan tidak terhubung ke layanan pihak ketiga.'),
    ),
    el('div', { class: 'chat-layout' }, listBox, el('div', { class: 'chat-panel' }, threadBox, composer, statusNote)),
  );

  if (!enabled) {
    statusNote.textContent = 'Live chat sedang dinonaktifkan oleh admin.';
    input.disabled = true;
    sendButton.disabled = true;
  }

  window.__activePage = {
    ...(window.__activePage ?? {}),
    destroy: () => {
      if (pollTimer) clearInterval(pollTimer);
      setState({});
    },
    onSocket: (message) => {
      if (message.type === 'chat:message' || message.type === 'chat:new') {
        void loadList();
        if (message.conversationId === activeId || message.type === 'chat:new') void loadThread();
      }
    },
  };

  await loadList();
  await loadThread();
  // socket events are the primary path; this is a safety net for reconnects
  pollTimer = setInterval(() => {
    void loadList();
    if (state.connection !== 'live') void loadThread();
  }, 12_000);
}
