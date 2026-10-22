#!/usr/bin/env node
/**
 * Minimal Node.js client for the demo trading backend.
 *
 * It demonstrates the full contract:
 *   1. register/login           POST /api/auth/*
 *   2. subscribe to a stream    WS  {type:"subscribe"}
 *   3. receive live ticks       WS  {type:"tick"} / {type:"candle"}
 *   4. open a BUY trade         POST /api/trades (Idempotency-Key)
 *   5. receive the result       WS  {type:"trade:settled"}
 *
 * Usage:
 *   node examples/client.js --url http://localhost:3000 --duration 5 --amount 10
 *   node examples/client.js --email me@example.com --password 'mypassword'
 *
 * Requires the dev server to be running (`npm run dev`). Demo only: no real money.
 */
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = (arg('url', process.env.BASE_URL || 'http://localhost:3000')).replace(/\/$/, '');
const EMAIL = arg('email', process.env.EMAIL || `demo-${Date.now()}@example.com`);
const PASSWORD = arg('password', process.env.PASSWORD || 'demo-password-123');
const AMOUNT = Number(arg('amount', '10'));
const DURATION = Number(arg('duration', '5'));
const TIMEFRAME = arg('tf', '5s');
const SYMBOL = arg('symbol', 'ASIA50');

const log = (...parts) => console.log('[client]', ...parts);

async function http(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(payload)}`);
  }
  return { payload, status: res.status };
}

async function signIn() {
  try {
    const { payload } = await http('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
    log('logged in as', payload.user.email, 'balance', payload.account.balance);
    return payload;
  } catch {
    const { payload } = await http('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
    log('registered', payload.user.email, 'balance', payload.account.balance);
    return payload;
  }
}

async function main() {
  const market = (await http('/api/market')).payload;
  log('market:', market.symbolName, 'durations', market.trading.allowedDurations.join('/'), 'payout', market.trading.payoutRate);
  if (!market.trading.allowedDurations.includes(DURATION)) {
    throw new Error(`duration ${DURATION}s is not allowed, use one of ${market.trading.allowedDurations}`);
  }

  const { token, user } = await signIn();
  const wsBase = BASE.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);

  let trade = null;
  let opened = false;
  let loggedCandle = false;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for trade:settled')), (DURATION + 30) * 1000);
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'hello':
          log('connected, server seq', msg.seq);
          ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOL, timeframe: TIMEFRAME }));
          break;

        case 'subscribed':
          log('subscribed to', msg.symbol, msg.timeframe);
          break;

        case 'tick':
          if (!opened) {
            opened = true;
            log('first tick:', msg.price, 'at', new Date(msg.time).toISOString());
            const { payload, status } = await http('/api/trades', {
              method: 'POST',
              token,
              headers: { 'Idempotency-Key': crypto.randomUUID() },
              body: { symbol: SYMBOL, direction: 'up', amount: AMOUNT, durationSec: DURATION },
            });
            trade = payload.trade;
            log(`BUY ${AMOUNT} for ${DURATION}s opened (HTTP ${status}) id=${trade.id} entry=${trade.entryPrice} expiry=${new Date(trade.expiryTime).toISOString()}`);
          }
          break;

        case 'candle':
          if (!loggedCandle && msg.tf === TIMEFRAME) {
            loggedCandle = true;
            log(`candle update ${msg.tf} O ${msg.o} H ${msg.h} L ${msg.l} C ${msg.c}`);
          }
          break;

        case 'candle_closed':
          if (msg.tf === TIMEFRAME) {
            log(`candle_closed ${msg.tf} O ${msg.candle.o} H ${msg.candle.h} L ${msg.candle.l} C ${msg.candle.c}`);
          }
          break;

        case 'trade:opened':
          log('trade:opened received for', msg.trade.id);
          break;

        case 'trade:settled':
          log('trade:settled:', msg.result.toUpperCase(), 'close', msg.closePrice, 'payout', msg.payout);
          clearTimeout(timeout);
          resolve(msg);
          break;

        case 'balance':
          log('balance now', msg.amount, msg.currency);
          break;

        case 'error':
          log('server error:', msg.code, msg.message);
          break;

        default:
          break;
      }
    });
    ws.on('error', reject);
  });

  const settled = await done;
  ws.close();
  log('done. user', user.email, 'trade', settled.id, 'result', settled.result);
}

main().catch((err) => {
  console.error('[client] failed:', err.message);
  process.exitCode = 1;
});
