import { get } from '../api.js';
import { state } from '../store.js';
import { $, clear, el, emptyState, toast } from '../ui.js';

/** Tiny, safe Markdown-ish renderer (headings, lists, bold, paragraphs). */
function renderBody(text) {
  const container = el('div', {});
  const lines = String(text ?? '').split(/\r?\n/);
  let list = null;
  const flush = () => {
    if (list) {
      container.append(list);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      container.append(el('h3', {}, line.slice(4)));
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      container.append(el('h2', {}, line.slice(3)));
      continue;
    }
    if (line.startsWith('# ')) {
      flush();
      container.append(el('h2', {}, line.slice(2)));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      list ??= el('ul', {});
      const item = el('li', {});
      appendInline(item, line.replace(/^[-*]\s+/, ''));
      list.append(item);
      continue;
    }
    flush();
    const paragraph = el('p', {});
    appendInline(paragraph, line);
    container.append(paragraph);
  }
  flush();
  return container;
}

function appendInline(node, text) {
  let index = 0;
  const pattern = /\*\*(.+?)\*\*/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > index) node.append(text.slice(index, match.index));
    node.append(el('strong', {}, match[1]));
    index = pattern.lastIndex;
  }
  if (index < text.length) node.append(text.slice(index));
}

const SHORTCUTS = [
  ['B', 'Buka trade NAIK (BELI)', 'Trading'],
  ['S', 'Buka trade TURUN (JUAL)', 'Trading'],
  ['L', 'Kembali ke harga live di chart', 'Trading'],
  ['T', 'Ganti timeframe berikutnya', 'Trading'],
  ['?', 'Buka halaman bantuan shortcut ini', 'Global'],
  ['Esc', 'Tutup dialog / bottom sheet', 'Global'],
];

const PAYMENT_TEXT = {
  deposit: {
    title: 'Deposit — Segera hadir',
    body: 'Modul deposit (QRIS, transfer bank, kartu) sengaja tidak diaktifkan. Platform ini adalah simulasi dengan saldo virtual, jadi tidak ada pembayaran sungguhan yang bisa dilakukan.',
  },
  withdraw: {
    title: 'Penarikan — Segera hadir',
    body: 'Penarikan dana tidak tersedia karena tidak ada dana nyata di platform ini. Semua saldo adalah angka virtual untuk latihan.',
  },
};

export async function contentPage(ctx, { slug, kind }) {
  const root = $('#view');
  clear(root);
  const container = el('article', { class: 'content-page' });
  root.append(container);

  if (slug === 'payments') {
    const info = PAYMENT_TEXT[kind] ?? PAYMENT_TEXT.deposit;
    container.append(
      el('h1', {}, info.title),
      el(
        'div',
        { class: 'alert alert--warn' },
        el('strong', {}, 'Simulasi.'),
        el(
          'span',
          {},
          'Tidak ada uang sungguhan, tidak ada rekening tujuan, dan tidak ada data pembayaran yang dikumpulkan.',
        ),
      ),
      el('p', {}, info.body),
      el('h2', {}, 'Apa yang bisa dilakukan sekarang?'),
      el(
        'ul',
        {},
        el('li', {}, 'Menambah saldo demo lewat menu Akun → Dompet demo (dibatasi harian).'),
        el('li', {}, 'Mereset seluruh saldo demo ke nilai awal (dengan jeda waktu).'),
        el('li', {}, 'Berlatih membuka trade dengan durasi 5 detik sampai 8 jam.'),
      ),
      el(
        'p',
        {},
        el('a', { href: '/faq', 'data-link': '' }, 'Baca FAQ'),
        ' · ',
        el('a', { href: '/account?tab=wallets', 'data-link': '' }, 'Buka dompet demo'),
      ),
    );
    return;
  }

  if (slug === 'shortcuts') {
    container.append(
      el('h1', {}, 'Shortcut keyboard'),
      el(
        'p',
        {},
        'Shortcut aktif saat fokus tidak berada di kolom input. Tekan ? kapan pun untuk membuka halaman ini.',
      ),
    );
    const table = el('table', { class: 'data' });
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Tombol'), el('th', {}, 'Aksi'), el('th', {}, 'Halaman'))));
    const body = el('tbody', {});
    for (const [key, action, where] of SHORTCUTS) {
      body.append(
        el('tr', {}, el('td', {}, el('kbd', {}, key)), el('td', {}, action), el('td', { class: 'muted' }, where)),
      );
    }
    table.append(body);
    container.append(el('div', { class: 'table-wrap' }, table));
    container.append(
      el('h2', {}, 'Catatan aksesibilitas'),
      el(
        'ul',
        {},
        el('li', {}, 'Semua tombol dapat dijangkau dengan Tab dan diaktifkan dengan Enter atau Spasi.'),
        el('li', {}, 'Dialog dan bottom sheet menutup dengan Esc dan mengembalikan fokus.'),
        el('li', {}, 'Pergerakan animasi dikurangi otomatis bila sistem meminta reduced motion.'),
      ),
    );
    return;
  }

  try {
    const res = await get(`/api/v1/pages/${slug}`);
    container.append(el('h1', {}, res.page.title || slug));
    if (res.page.updatedAt) {
      container.append(
        el(
          'p',
          { class: 'muted', style: { fontSize: '11.5px' } },
          `Terakhir diperbarui ${new Date(res.page.updatedAt).toLocaleString('id-ID')}`,
        ),
      );
    }
    container.append(renderBody(res.page.body));
    if (slug === 'faq') {
      container.append(
        el('h2', {}, 'Pertanyaan cepat'),
        el(
          'dl',
          {},
          el('dt', {}, 'Apakah saya bisa deposit?'),
          el('dd', {}, 'Tidak. Tidak ada deposit, penarikan, QRIS, transfer bank, atau akun live di platform ini.'),
          el('dt', {}, 'Dari mana harga berasal?'),
          el(
            'dd',
            {},
            'Server simulasi kami membuat harga sendiri. Tidak ada koneksi ke bursa atau penyedia data pihak ketiga.',
          ),
          el('dt', {}, 'Bisakah admin mengubah hasil trade saya?'),
          el(
            'dd',
            {},
            'Tidak. Admin hanya bisa mengubah parameter simulasi (tren, volatilitas, mood, pause) dan semuanya tercatat di riwayat market.',
          ),
        ),
      );
    }
    if (slug === 'contact') {
      container.append(
        el(
          'div',
          { class: 'alert' },
          el('strong', {}, 'Kontak demo: '),
          'tidak ada saluran dukungan nyata. Platform ini dijalankan untuk keperluan demonstrasi teknis.',
        ),
        el('p', {}, 'Jika kamu menemukan bug, catat langkah reproduksi dan kirimkan ke pengelola repositori.'),
      );
    }
  } catch (error) {
    container.append(
      el('h1', {}, slug === 'faq' ? 'FAQ' : slug),
      el('div', { class: 'alert alert--error' }, error.message),
      el('p', {}, 'Halaman konten dapat diubah admin melalui panel admin → Konten.'),
    );
  }
  void ctx;
  void emptyState;
  void toast;
  void state;
}

export function notFoundPage(ctx, router) {
  const root = $('#view');
  clear(root);
  root.append(
    el(
      'div',
      { class: 'content-page' },
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'empty__icon', 'aria-hidden': 'true' }, '404'),
        el('h1', {}, 'Halaman tidak ditemukan'),
        el('p', {}, `Alamat ${location.pathname} tidak ada di aplikasi demo ini.`),
        el(
          'div',
          { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '12px' } },
          el('a', { class: 'btn btn--primary', href: '/', 'data-link': '' }, 'Kembali ke beranda'),
          el('a', { class: 'btn btn--ghost', href: '/trading', 'data-link': '' }, 'Buka trading'),
        ),
      ),
    ),
  );
  void ctx;
  void router;
}
