/**
 * WebSocket fan-out load check.
 *
 *   node test/load/ws-load.mjs [clients] [seconds]
 *
 * Connects N clients to /ws, subscribes them to a market, and reports: connect
 * successes, messages received, message rate, and the p50/p95 delay between the
 * server timestamp and local receipt. Point it at a running server with
 * WS_URL (default ws://127.0.0.1:3000/ws) and SYMBOL (default DOGE).
 */
import { WebSocket } from 'ws';

const clients = Number(process.argv[2] ?? 500);
const seconds = Number(process.argv[3] ?? 10);
const url = process.env.WS_URL ?? 'ws://127.0.0.1:3000/ws';
const symbol = process.env.SYMBOL ?? 'DOGE';

const connected = [];
const latencies = [];
let messages = 0;
let errors = 0;

const started = Date.now();
console.log(`[ws-load] connecting ${clients} clients to ${url} …`);

const sockets = await Promise.all(
  Array.from(
    { length: clients },
    (_, index) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, { perMessageDeflate: false });
        const timer = setTimeout(() => {
          errors += 1;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(ws);
        }, 15_000);
        ws.on('open', () => {
          clearTimeout(timer);
          connected.push(Date.now());
          ws.send(JSON.stringify({ type: 'subscribe', symbol, timeframe: '1m' }));
          resolve(ws);
        });
        ws.on('message', (raw) => {
          messages += 1;
          try {
            const message = JSON.parse(raw.toString());
            if (message.type === 'tick' && typeof message.time === 'number') {
              latencies.push(Date.now() - message.time);
            }
          } catch {
            /* ignore malformed frames */
          }
        });
        ws.on('error', () => {
          errors += 1;
        });
        void index;
      }),
  ),
);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

for (const ws of sockets) ws.close();
const elapsed = (Date.now() - started) / 1000;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const connectTimes = connected.map((time) => time - started).sort((a, b) => a - b);

console.log('[ws-load] result', {
  clients,
  connected: connected.length,
  errors,
  seconds: Number(elapsed.toFixed(1)),
  messages,
  messagesPerSecond: Math.round(messages / elapsed),
  ticks: latencies.length,
  tickDelayMs: { p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? null },
  connectMs: { p50: connectTimes[Math.floor(connectTimes.length / 2)] ?? null, max: connectTimes.at(-1) ?? null },
  rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
});

if (connected.length < clients) process.exitCode = 1;
