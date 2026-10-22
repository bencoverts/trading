/**
 * WebSocket client with:
 *  - subscribe/unsubscribe per market+timeframe
 *  - coalesced tick rendering (requestAnimationFrame)
 *  - exponential backoff reconnect + sequence resume
 *  - app-level ping to detect half-open sockets
 */
export class MarketSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.subs = new Set();
    this.seq = new Map();
    this.attempt = 0;
    this.closedByUser = false;
    this.pingTimer = null;
    this.lastMessage = 0;
    this.reconnectTimer = null;
    this.token = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws${query}`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.lastMessage = Date.now();
      this.handlers.onStatus?.('online');
      for (const key of this.subs) {
        const [market, timeframe] = key.split('|');
        ws.send(JSON.stringify({ type: 'subscribe', market, timeframe }));
      }
      for (const [market, seq] of this.seq) {
        if (seq > 0) ws.send(JSON.stringify({ type: 'resume', market, lastSeq: seq }));
      }
      this.startPing();
    });

    ws.addEventListener('message', (event) => {
      this.lastMessage = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if ((msg.type === 'tick' || msg.type === 'candle' || msg.type === 'candle_closed') && msg.market) {
        const seq = Number(msg.seq ?? 0);
        if (seq > (this.seq.get(msg.market) ?? 0)) this.seq.set(msg.market, seq);
      }
      this.handlers.onMessage?.(msg);
    });

    ws.addEventListener('close', () => {
      this.stopPing();
      this.ws = null;
      this.handlers.onStatus?.('offline');
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.attempt);
    this.attempt += 1;
    this.handlers.onStatus?.('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', id: Date.now() });
      if (Date.now() - this.lastMessage > 60_000) {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }
    }, 25_000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  subscribe(market, timeframe) {
    this.subs.add(`${market}|${timeframe}`);
    this.send({ type: 'subscribe', market, timeframe });
  }

  unsubscribe(market, timeframe) {
    this.subs.delete(`${market}|${timeframe}`);
    this.send({ type: 'unsubscribe', market, timeframe });
  }

  clearSubscriptions() {
    for (const key of this.subs) {
      const [market, timeframe] = key.split('|');
      this.send({ type: 'unsubscribe', market, timeframe });
    }
    this.subs.clear();
  }

  authenticate(token) {
    this.token = token;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'auth', token });
  }

  close() {
    this.closedByUser = true;
    this.stopPing();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
