/**
 * Chart renderer - adapted from the provided chart_pro.html.
 *
 * The visual output is unchanged. What changed is where data comes from:
 *   - no local random feed (createRandomFeed removed)
 *   - history arrives through setData(candles) (server OHLC, see /api/candles)
 *   - live prices arrive through push(price, time) (WebSocket "tick")
 *   - authoritative OHLC arrives through applyCandle()/closeCandle() (WebSocket
 *     "candle" / "candle_closed"), so the client never decides a price
 */

const BG = '#0d1117';
const UP = '#22d3a0';
const DOWN = '#ff4d6d';
const ACC = '#5b8cff';
const GRID = 'rgba(255,255,255,.05)';
const TXT = '#6e7787';
const AXIS = 76;
const PAD_T = 56;
const PAD_B = 28;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createChart(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;

  const S = {
    type: 'candle',
    tf: '5s',
    bucket: 5000,
    candles: [],
    last: 0,
    open0: 0,
    px: 0,
    lo: 0,
    hi: 0,
    bars: 70,
    barsT: 70,
    slide: 0,
    fade: 1,
    shift: 0,
    shiftT: 0,
    dragging: false,
    dragX: 0,
    mouse: null,
    hover: null,
    cw: 10,
    lastHud: '',
    serverOffset: 0,
  };

  const api = {
    onHud: null,
    onViewChange: null,
    get timeframes() {
      return S.tf;
    },
  };

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------------- data handling ---------------- */

  const bucketOf = (t) => Math.floor(t / S.bucket) * S.bucket;

  function upsert(candle) {
    const arr = S.candles;
    const last = arr[arr.length - 1];
    if (!last || candle.t > last.t) {
      arr.push({ t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
      if (arr.length > 3000) arr.splice(0, 500);
      if (S.shiftT > 0) {
        S.shift += 1;
        S.shiftT += 1;
      } else {
        S.slide = 1;
      }
      return true;
    }
    if (candle.t < last.t) {
      // a late message for an older bucket: only refresh the close if it is the same bucket
      for (let i = arr.length - 1; i >= Math.max(0, arr.length - 5); i--) {
        if (arr[i].t === candle.t) {
          arr[i] = { ...candle };
          return false;
        }
      }
      return false;
    }
    last.o = candle.o;
    last.h = candle.h;
    last.l = candle.l;
    last.c = candle.c;
    return false;
  }

  api.setTimeframe = (tf, bucket) => {
    S.tf = tf;
    S.bucket = bucket;
    S.slide = 0;
    S.fade = 0;
  };

  /** Replaces the series with server candles (oldest first). */
  api.setData = (candles) => {
    S.candles = [];
    for (const c of candles || []) {
      if (Number.isFinite(c.t) && Number.isFinite(c.o)) {
        S.candles.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
      }
    }
    S.candles.sort((a, b) => a.t - b.t);
    const first = S.candles[0];
    const last = S.candles[S.candles.length - 1];
    if (first) S.open0 = first.o;
    if (last) {
      S.last = last.c;
      S.px = last.c;
    }
    S.fade = 0;
    S.hi = 0; // force the y-scale to snap
  };

  /** Live tick: drives the price line and the forming candle (fallback path). */
  api.push = (price, time) => {
    if (!Number.isFinite(price) || !Number.isFinite(time)) return;
    S.last = price;
    if (!S.open0) S.open0 = price;
    const t = bucketOf(time);
    const last = S.candles[S.candles.length - 1];
    if (!last || last.t < t) {
      upsert({ t, o: price, h: price, l: price, c: price });
    } else if (last.t === t) {
      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
    }
  };

  /** Authoritative OHLC for the forming candle (server "candle" message). */
  api.applyCandle = (c) => {
    if (!c) return;
    upsert(c);
    const last = S.candles[S.candles.length - 1];
    if (last && c.t === last.t) S.last = c.c;
  };

  /** Confirmed closed candle (server "candle_closed" message). */
  api.closeCandle = (c) => {
    if (!c) return;
    const last = S.candles[S.candles.length - 1];
    if (last && c.t === last.t) {
      last.o = c.o;
      last.h = c.h;
      last.l = c.l;
      last.c = c.c;
    } else if (!last || c.t > last.t) {
      upsert(c);
    }
  };

  api.setPrice = (p) => {
    if (Number.isFinite(p)) S.last = p;
  };
  api.setType = (type) => {
    S.type = type;
    S.fade = 0;
  };
  api.setServerOffset = (offsetMs) => {
    if (Number.isFinite(offsetMs)) S.serverOffset = offsetMs;
  };
  api.goLive = () => {
    S.shiftT = 0;
  };
  api.isLive = () => S.shiftT < 0.5;
  api.candles = () => S.candles.slice();

  /* ---------------- interaction ---------------- */

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.12 : 0.89;
      S.barsT = clamp(S.barsT * f, 20, 200);
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (e) => {
    S.dragging = true;
    S.dragX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    S.mouse = { x: e.clientX, y: e.clientY };
    if (S.dragging) {
      const dx = e.clientX - S.dragX;
      S.dragX = e.clientX;
      const max = Math.max(0, S.candles.length - 6);
      S.shift = S.shiftT = clamp(S.shiftT + dx / S.cw, 0, max);
    }
  });
  const endDrag = () => {
    S.dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    S.mouse = null;
  });

  /* ---------------- drawing helpers ---------------- */

  function niceStep(range, n) {
    const raw = range / n;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function rr(x, y, w, h, r) {
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawCandles(vis, x, y, cw) {
    const bw = Math.max(2, cw * 0.66);
    const r = Math.min(3, bw / 2);
    const last = vis.length - 1;
    vis.forEach((k, j) => {
      const cx = x(j);
      const up = k.c >= k.o;
      const col = up ? UP : DOWN;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, cw * 0.08);
      ctx.beginPath();
      ctx.moveTo(cx, y(k.h));
      ctx.lineTo(cx, y(k.l));
      ctx.stroke();
      const top = y(Math.max(k.o, k.c));
      const bot = y(Math.min(k.o, k.c));
      const h = Math.max(2, bot - top);
      if (j === last) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 14;
      }
      ctx.beginPath();
      rr(cx - bw / 2, top, bw, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  function drawOHLC(vis, x, y, cw) {
    const t = Math.max(2, cw * 0.34);
    vis.forEach((k, j) => {
      const cx = x(j);
      const col = k.c >= k.o ? UP : DOWN;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.2, cw * 0.09);
      ctx.beginPath();
      ctx.moveTo(cx, y(k.h));
      ctx.lineTo(cx, y(k.l));
      ctx.moveTo(cx - t, y(k.o));
      ctx.lineTo(cx, y(k.o));
      ctx.moveTo(cx, y(k.c));
      ctx.lineTo(cx + t, y(k.c));
      ctx.stroke();
    });
  }

  function drawLine(vis, x, y, chartH, area) {
    if (vis.length < 2) return;
    const pts = vis.map((k, j) => ({ x: x(j), y: y(k.c) }));
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const L = pts[pts.length - 1];
      ctx.lineTo(L.x, L.y);
    };
    if (area) {
      path();
      const L = pts[pts.length - 1];
      const F = pts[0];
      ctx.lineTo(L.x, PAD_T + chartH);
      ctx.lineTo(F.x, PAD_T + chartH);
      ctx.closePath();
      const ag = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + chartH);
      ag.addColorStop(0, 'rgba(91,140,255,.35)');
      ag.addColorStop(1, 'rgba(91,140,255,0)');
      ctx.fillStyle = ag;
      ctx.fill();
    }
    path();
    const sg = ctx.createLinearGradient(pts[0].x, 0, pts[pts.length - 1].x, 0);
    sg.addColorStop(0, 'rgba(91,140,255,.2)');
    sg.addColorStop(1, ACC);
    ctx.strokeStyle = sg;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /* ---------------- render loop ---------------- */

  function frame(t) {
    S.bars += (S.barsT - S.bars) * 0.15;
    S.slide += (0 - S.slide) * 0.14;
    S.fade += (1 - S.fade) * 0.12;
    if (!S.dragging) S.shift += (S.shiftT - S.shift) * 0.15;
    S.px += (S.last - S.px) * 0.22;

    const chartW = W - AXIS;
    const chartH = H - PAD_T - PAD_B;
    const cw = chartW / S.bars;
    S.cw = cw;
    const n = Math.ceil(S.bars) + 2;
    const len = S.candles.length;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (!len) {
      requestAnimationFrame(frame);
      return;
    }

    const shift = Math.max(0, S.shift);
    const shiftI = Math.floor(shift);
    const frac = shift - shiftI;
    const rightIdx = Math.max(0, len - 1 - shiftI);
    const first = Math.max(0, rightIdx - n + 1);
    const vis = S.candles.slice(first, rightIdx + 1);
    const m = vis.length;

    const base = chartW - cw / 2 + (S.slide + frac) * cw;
    const xOf = (j) => base - (rightIdx - (first + j)) * cw;

    const isLine = S.type === 'line' || S.type === 'area';
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of vis) {
      const a = isLine ? k.c : k.l;
      const b = isLine ? k.c : k.h;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    const pad = (hi - lo) * 0.12 || 0.5;
    lo -= pad;
    hi += pad;
    if (!S.hi) {
      S.lo = lo;
      S.hi = hi;
    }
    S.lo += (lo - S.lo) * 0.18;
    S.hi += (hi - S.hi) * 0.18;
    const Lo = S.lo;
    const Hi = S.hi;
    const y = (p) => PAD_T + ((Hi - p) / (Hi - Lo)) * chartH;

    ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
    ctx.textBaseline = 'middle';

    const step = niceStep(Hi - Lo, 6);
    const dp = Math.max(2, Math.ceil(-Math.log10(step)));
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    for (let v = Math.ceil(Lo / step) * step; v < Hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(chartW, yy);
      ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(v.toFixed(dp), chartW + 10, yy);
    }

    const every = Math.max(1, Math.round(100 / cw));
    ctx.textAlign = 'center';
    for (let j = 0; j < m; j++) {
      const g = first + j;
      if ((rightIdx - g) % every !== 0) continue;
      const xx = Math.round(xOf(j)) + 0.5;
      if (xx < 0 || xx > chartW) continue;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(xx, PAD_T);
      ctx.lineTo(xx, PAD_T + chartH);
      ctx.stroke();
      const ts = new Date(S.candles[g].t).toTimeString().slice(0, S.bucket < 60000 ? 8 : 5);
      ctx.fillStyle = TXT;
      ctx.fillText(ts, xx, H - 13);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, PAD_T, chartW, chartH);
    ctx.clip();
    ctx.globalAlpha = S.fade;
    if (S.type === 'candle') drawCandles(vis, xOf, y, cw);
    else if (S.type === 'ohlc') drawOHLC(vis, xOf, y, cw);
    else drawLine(vis, xOf, y, chartH, S.type === 'area');
    ctx.globalAlpha = 1;
    ctx.restore();

    const L = vis[m - 1];
    const up = L.c >= L.o;
    const col = up ? UP : DOWN;
    const py = y(S.px);
    const lx = xOf(m - 1);

    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(230,233,239,.35)';
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(chartW, py);
    ctx.stroke();
    ctx.setLineDash([]);

    if (lx > -20 && lx < chartW + 20) {
      const pulse = (Math.sin((t / 1000) * 4) + 1) / 2;
      ctx.globalAlpha = 0.28 * (1 - pulse);
      ctx.beginPath();
      ctx.arc(lx, py, 4 + pulse * 10, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(lx, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }

    ctx.fillStyle = col;
    ctx.beginPath();
    rr(chartW + 4, py - 11, AXIS - 8, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(S.px.toFixed(4), chartW + AXIS / 2, py);

    const nowMs = Date.now() + S.serverOffset;
    const rem = Math.max(0, L.t + S.bucket - nowMs) / 1000;
    ctx.fillStyle = TXT;
    ctx.fillText(rem.toFixed(1) + 's', chartW + AXIS / 2, py + 22);

    S.hover = null;
    const mo = S.mouse;
    if (mo && mo.x < chartW && mo.y > PAD_T && mo.y < PAD_T + chartH) {
      let g = Math.round(rightIdx - (base - mo.x) / cw);
      g = clamp(g, 0, len - 1);
      const k = S.candles[g];
      const cx = base - (rightIdx - g) * cw;
      S.hover = k;

      ctx.strokeStyle = 'rgba(230,233,239,.25)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, PAD_T);
      ctx.lineTo(cx, PAD_T + chartH);
      ctx.moveTo(0, mo.y);
      ctx.lineTo(chartW, mo.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const hp = Hi - ((mo.y - PAD_T) / chartH) * (Hi - Lo);
      ctx.fillStyle = '#232a38';
      ctx.beginPath();
      rr(chartW + 4, mo.y - 11, AXIS - 8, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#e6e9ef';
      ctx.textAlign = 'center';
      ctx.fillText(hp.toFixed(dp), chartW + AXIS / 2, mo.y);
    }

    if (api.onHud) {
      const hk = S.hover || L;
      api.onHud({
        price: S.last,
        open: S.open0,
        hovered: Boolean(S.hover),
        candle: hk,
        live: S.shiftT < 0.5,
      });
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return api;
}
