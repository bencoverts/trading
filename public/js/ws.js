/**
 * WebSocket client with the v3 protocol:
 *   subscribe/unsubscribe/resume, tick, candle, candle_closed, market_status,
 *   trade:opened, trade:settled, balance, notification, hello, pong, error.
 * Auto-reconnects with exponential backoff and resubscribes automatically.
 */

export function createSocket({ onMessage, onStatus } = {}) {
  let socket = null;
  let attempts = 0;
  let heartbeat = null;
  let closedByUser = false;
  const subscriptions = new Set(); // "SYMBOL|tf"
  const lastSeq = new Map();
  let lastPingSent = 0;

  const url = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  };

  function connect() {
    onStatus?.('connecting');
    socket = new WebSocket(url());

    socket.addEventListener('open', () => {
      attempts = 0;
      onStatus?.('live');
      for (const key of subscriptions) {
        const [symbol, timeframe] = key.split('|');
        socket.send(JSON.stringify({ type: 'subscribe', symbol, timeframe }));
      }
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        lastPingSent = Date.now();
        socket.send(JSON.stringify({ type: 'ping', id: lastPingSent }));
      }, 25_000);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'pong') {
        const latency = lastPingSent ? Date.now() - lastPingSent : null;
        if (latency !== null) onMessage?.({ type: 'latency', ms: latency });
        return;
      }
      if (typeof message.seq === 'number' && message.symbol) lastSeq.set(message.symbol, message.seq);
      onMessage?.(message);
    });

    socket.addEventListener('close', () => {
      clearInterval(heartbeat);
      onStatus?.('offline');
      if (closedByUser) return;
      attempts += 1;
      const delay = Math.min(15_000, 600 * 2 ** Math.min(attempts, 5));
      setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => onStatus?.('offline'));
  }

  connect();

  return {
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    subscribe(symbol, timeframe) {
      const key = `${symbol}|${timeframe}`;
      subscriptions.clear();
      subscriptions.add(key);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe', symbol, timeframe }));
      }
    },
    unsubscribe() {
      subscriptions.clear();
    },
    resume(symbol) {
      const seq = lastSeq.get(symbol);
      if (seq === undefined || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'resume', symbol, lastSeq: seq }));
    },
    auth(token) {
      if (socket?.readyState === WebSocket.OPEN && token) socket.send(JSON.stringify({ type: 'auth', token }));
    },
    close() {
      closedByUser = true;
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}
