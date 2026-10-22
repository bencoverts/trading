/**
 * Demo trading client.
 *
 * Responsibilities:
 *  - load market config + chart history from the REST API
 *  - keep a WebSocket to /ws for ticks, candles and account events
 *  - proxy trade intents to POST /api/trades (the server decides prices/results)
 *
 * There is no local random price generator and no client-side outcome logic.
 */
import { createChart } from '/chart.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'demo-trading.token';

const state = {
  market: null,
  symbol: 'ASIA50',
  tf: '5s',
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  balance: null,
  lastSeq: 0,
  serverOffset: 0,
  ws: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  pingTimer: null,
  uiTimer: null,
  lastMessageAt: 0,
  switching: null,
  openTrades: [],
  history: [],
  lastHudKey: '',
  trading: false,
  subscribedTf: null,
};

const chart = createChart($('c'));

/* ------------------------------------------------------------------ utils */

const money = (n) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function setConn(status) {
  const el = $('conn');
  el.className = `conn ${status}`;
  el.textContent = status === 'online' ? 'live' : status;
}

async function api(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (auth && state.token) opts.headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, opts);
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    if (res.status === 401 && auth) handleSignedOut();
    const err = new Error(payload?.error?.message || `request failed (${res.status})`);
    err.code = payload?.error?.code || 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  // chart controls
  document.querySelectorAll('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('on', x === btn));
      chart.setType(btn.dataset.type);
    });
  });
  document.querySelectorAll('[data-tf]').forEach((btn) => {
    btn.addEventListener('click', () => selectTimeframe(btn.dataset.tf));
  });
  $('live').addEventListener('click', () => chart.goLive());

  $('symbolName').textContent = 'loading…';

  try {
    state.market = await api('/api/market', { auth: false });
  } catch (err) {
    toast(`Cannot load market config: ${err.message}`, 'lose');
    return;
  }

  state.symbol = state.market.symbol;
  $('symbolName').textContent = state.market.symbolName;
  document.title = `${state.market.symbolName} · Demo`;
  $('limits').textContent = `${money(state.market.trading.minAmount)} – ${money(state.market.trading.maxAmount)} / trade`;
  $('payout').textContent =
    state.market.trading.payoutMode === 'profit'
      ? `win +${Math.round(state.market.trading.payoutRate * 100)}%`
      : `win ×${state.market.trading.payoutRate.toFixed(2)}`;
  $('amount').min = String(state.market.trading.minAmount);
  $('amount').max = String(state.market.trading.maxAmount);

  const durations = state.market.trading.allowedDurations;
  const durationSelect = $('duration');
  durationSelect.replaceChildren(
    ...durations.map((d) => {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = `${d}s`;
      return opt;
    }),
  );
  durationSelect.value = String(durations.includes(5) ? 5 : durations[0]);

  await selectTimeframe('5s');
  bindUi();
  connect();
  state.uiTimer = setInterval(renderOpenTrades, 500);

  if (state.token) await loadMe();
  else openAuth();
}

/* --------------------------------------------------------------- chart data */

async function selectTimeframe(tf) {
  const bucket = state.market.timeframeMs[tf];
  if (!bucket) return;
  state.tf = tf;
  document.querySelectorAll('[data-tf]').forEach((x) => x.classList.toggle('on', x.dataset.tf === tf));
  chart.setTimeframe(tf, bucket);

  const requestId = Symbol(tf);
  state.switching = requestId;
  try {
    const res = await api(`/api/candles?symbol=${encodeURIComponent(state.symbol)}&tf=${tf}&limit=400`, { auth: false });
    if (state.switching !== requestId) return; // a newer timeframe won
    state.serverOffset = res.serverTime - Date.now();
    chart.setServerOffset(state.serverOffset);
    chart.setData(res.candles);
    if (Number.isFinite(res.lastPrice)) chart.setPrice(res.lastPrice);
    if (Number.isFinite(res.seq)) state.lastSeq = Math.max(state.lastSeq, res.seq - 0);
  } catch (err) {
    toast(`History unavailable: ${err.message}`, 'lose');
  } finally {
    if (state.switching === requestId) state.switching = null;
  }
  subscribe();
}

async function reloadChart() {
  return selectTimeframe(state.tf);
}

/* ------------------------------------------------------------- websocket */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  return `${proto}//${location.host}/ws${q}`;
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  setConn('connecting');

  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    setConn('offline');
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectAttempt = 0;
    setConn('online');
    state.lastMessageAt = Date.now();
    subscribe();
    if (state.lastSeq > 0) send({ type: 'resume', lastSeq: state.lastSeq });
    startPing();
  });

  ws.addEventListener('message', (event) => {
    state.lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConn('offline');
    stopPing();
    state.ws = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(15000, 500 * 2 ** state.reconnectAttempt);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function subscribe() {
  if (state.subscribedTf && state.subscribedTf !== state.tf) {
    send({ type: 'unsubscribe', symbol: state.symbol, timeframe: state.subscribedTf });
  }
  state.subscribedTf = state.tf;
  send({ type: 'subscribe', symbol: state.symbol, timeframe: state.tf });
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    send({ type: 'ping', id: Date.now() });
    if (Date.now() - state.lastMessageAt > 60_000) {
      // no traffic at all: assume a half-open socket and reconnect
      try {
        state.ws?.close();
      } catch {
        /* ignore */
      }
    }
  }, 25_000);
}

function stopPing() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.serverOffset = msg.serverTime - Date.now();
      chart.setServerOffset(state.serverOffset);
      break;

    case 'tick':
      if (typeof msg.seq === 'number') state.lastSeq = Math.max(state.lastSeq, msg.seq);
      chart.setPrice(msg.price);
      chart.push(msg.price, msg.time);
      break;

    case 'candle':
      if (msg.tf !== state.tf) break;
      chart.applyCandle({ t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c });
      if (typeof msg.seq === 'number') state.lastSeq = Math.max(state.lastSeq, msg.seq);
      break;

    case 'candle_closed':
      if (msg.tf !== state.tf) break;
      chart.closeCandle(msg.candle);
      break;

    case 'replay':
      if (typeof msg.seq === 'number') state.lastSeq = Math.max(state.lastSeq, msg.seq);
      for (const t of msg.ticks || []) chart.setPrice(t.price);
      for (const c of msg.candles || []) chart.applyCandle({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
      break;

    case 'resync':
      state.lastSeq = 0;
      reloadChart();
      break;

    case 'balance':
      setBalance(msg.amount);
      break;

    case 'trade:opened':
      toast(`Trade opened · ${msg.trade.direction.toUpperCase()} ${money(msg.trade.amount)}`, '');
      refreshTrades();
      break;

    case 'trade:settled':
      toast(
        `${msg.result.toUpperCase()} · ${msg.result === 'lose' ? '-' : '+'}${money(
          msg.result === 'lose' ? msg.trade.amount : msg.payout - msg.trade.amount,
        )} @ ${Number(msg.closePrice).toFixed(state.market?.priceDecimals ?? 2)}`,
        msg.result,
      );
      refreshTrades();
      refreshMe();
      break;

    case 'pong':
      break;

    case 'error':
      if (msg.code === 'UNAUTHORIZED') {
        handleSignedOut();
      } else {
        toast(msg.message || msg.code, 'lose');
      }
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------- HUD */

chart.onHud = ({ price, open, candle, hovered, live }) => {
  const decimals = state.market?.priceDecimals ?? 2;
  const px = Number(price).toFixed(decimals);
  const chg = open ? ((price - open) / open) * 100 : 0;
  const key = `${px}|${chg.toFixed(3)}|${candle.t}|${candle.o}|${candle.h}|${candle.l}|${candle.c}|${hovered}`;
  if (key === state.lastHudKey) return;
  state.lastHudKey = key;

  setText($('px'), px);
  const chgEl = $('chg');
  setText(chgEl, `${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%`);
  chgEl.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
  setText(
    $('ohlc'),
    `${hovered ? '' : 'last · '}O ${candle.o.toFixed(2)}  H ${candle.h.toFixed(2)}  L ${candle.l.toFixed(2)}  C ${candle.c.toFixed(2)}`,
  );
  $('live').classList.toggle('hide', live);
};

/* ------------------------------------------------------------------- auth */

function openAuth() {
  $('authError').textContent = '';
  $('authModal').hidden = false;
  $('email').focus();
}

function closeAuth() {
  $('authModal').hidden = true;
}

function setBalance(amount) {
  state.balance = Number(amount);
  setText($('balance'), money(amount));
}

function renderAuthState() {
  const who = $('who');
  if (state.user && state.user.email) {
    who.textContent = state.user.email;
    $('signInBtn').textContent = 'switch account';
  } else {
    who.textContent = 'not signed in';
    $('signInBtn').textContent = 'Sign in';
  }
  $('signOutBtn').hidden = !state.user;
  $('email').value = state.user?.email ?? '';
  $('hint').classList.toggle('signed-in', Boolean(state.user));
}

function handleSignedOut() {
  state.token = null;
  state.user = null;
  state.balance = null;
  localStorage.removeItem(TOKEN_KEY);
  setText($('balance'), '—');
  renderAuthState();
  renderTrades();
}

async function loadMe() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    setBalance(me.account.balance);
    const limits = me.limits;
    $('limits').textContent = `${money(limits.minAmount)} – ${money(limits.maxAmount)} / trade · max ${limits.maxOpenTrades} open`;
    renderAuthState();
    await refreshTrades();
  } catch (err) {
    if (err.status === 401) handleSignedOut();
  }
}

async function refreshMe() {
  if (!state.token) return;
  try {
    const me = await api('/api/me');
    state.user = me.user;
    setBalance(me.account.balance);
    renderAuthState();
  } catch {
    /* handled by api() on 401 */
  }
}

async function authenticate(mode) {
  const email = $('email').value.trim();
  const password = $('password').value;
  $('authError').textContent = '';
  try {
    const res = await api(`/api/auth/${mode}`, { method: 'POST', body: { email, password }, auth: false });
    state.token = res.token;
    localStorage.setItem(TOKEN_KEY, res.token);
    state.user = res.user;
    setBalance(res.account.balance);
    renderAuthState();
    closeAuth();
    send({ type: 'auth', token: res.token });
    connect();
    await refreshTrades();
    toast(mode === 'login' ? 'Signed in' : 'Demo account created');
  } catch (err) {
    $('authError').textContent = err.message;
  }
}

/* ----------------------------------------------------------------- trades */

function renderTrades() {
  renderOpenTrades();
  renderHistory();
}

function renderOpenTrades() {
  const list = $('openTrades');
  $('openCount').textContent = state.openTrades.length ? `(${state.openTrades.length})` : '';
  if (!state.openTrades.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no open trades';
    list.replaceChildren(li);
    return;
  }
  const now = Date.now() + state.serverOffset;
  list.replaceChildren(
    ...state.openTrades.map((trade) => {
      const li = document.createElement('li');
      const left = Math.max(0, Math.ceil((trade.expiryTime - now) / 1000));
      const dir = document.createElement('span');
      dir.className = `dir ${trade.direction === 'up' ? 'up' : 'down'}`;
      dir.textContent = trade.direction === 'up' ? 'BUY' : 'SELL';
      const amount = document.createElement('span');
      amount.textContent = money(trade.amount);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = left > 0 ? `${left}s` : 'settling…';
      li.append(dir, amount, count);
      return li;
    }),
  );
}

function renderHistory() {
  const list = $('history');
  if (!state.history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no trades yet';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...state.history.map((trade) => {
      const li = document.createElement('li');
      const res = document.createElement('span');
      res.className = `${trade.result === 'win' ? 'up' : trade.result === 'lose' ? 'down' : 'flat'}`;
      res.textContent = (trade.result || 'closed').toUpperCase();
      const amount = document.createElement('span');
      amount.textContent = `${trade.direction === 'up' ? '▲' : '▼'} ${money(trade.amount)}`;
      const payout = document.createElement('span');
      payout.className = 'count';
      payout.textContent = trade.result === 'lose' ? `-${money(trade.amount)}` : `+${money((trade.payout ?? 0) - trade.amount)}`;
      li.append(res, amount, payout);
      return li;
    }),
  );
}

async function refreshTrades() {
  if (!state.token) {
    state.openTrades = [];
    state.history = [];
    renderTrades();
    return;
  }
  try {
    const [open, closed] = await Promise.all([
      api('/api/trades?status=open&limit=20'),
      api('/api/trades?status=closed&limit=6'),
    ]);
    state.openTrades = open.trades;
    state.history = closed.trades;
    renderTrades();
  } catch {
    /* api() already surfaced auth problems */
  }
}

async function submitTrade(direction) {
  if (!state.token) {
    openAuth();
    return;
  }
  if (state.trading || !state.market) return;

  const amount = Number($('amount').value);
  const durationSec = Number($('duration').value);
  const min = state.market.trading.minAmount;
  const max = state.market.trading.maxAmount;
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    toast(`Amount must be between ${money(min)} and ${money(max)}`, 'lose');
    return;
  }
  if (state.balance !== null && amount > state.balance) {
    toast('Insufficient demo balance', 'lose');
    return;
  }

  state.trading = true;
  setTradingEnabled(false);
  try {
    const key = crypto.randomUUID();
    await api('/api/trades', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: { symbol: state.symbol, direction, amount, durationSec },
    });
    await refreshMe();
    await refreshTrades();
  } catch (err) {
    toast(err.message, 'lose');
  } finally {
    state.trading = false;
    setTradingEnabled(true);
  }
}

function setTradingEnabled(enabled) {
  document.querySelectorAll('[data-dir]').forEach((b) => {
    b.disabled = !enabled;
  });
}

function bindUi() {
  $('tradeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const dir = event.submitter?.dataset.dir;
    if (dir) submitTrade(dir);
  });

  $('signInBtn').addEventListener('click', openAuth);
  $('closeAuth').addEventListener('click', closeAuth);
  $('registerBtn').addEventListener('click', () => authenticate('register'));
  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    authenticate('login');
  });
  $('signOutBtn').addEventListener('click', () => {
    handleSignedOut();
    closeAuth();
    toast('Signed out');
  });
  $('resetBtn').addEventListener('click', async () => {
    if (!state.token) {
      openAuth();
      return;
    }
    try {
      const res = await api('/api/account/reset', { method: 'POST' });
      setBalance(res.account.balance);
      await refreshTrades();
      toast('Demo balance reset');
    } catch (err) {
      toast(err.message, 'lose');
    }
  });
  $('authModal').addEventListener('click', (event) => {
    if (event.target === $('authModal')) closeAuth();
  });
}

boot();
