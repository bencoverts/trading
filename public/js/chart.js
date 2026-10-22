/**
 * Canvas chart (adapted from the provided chart-kit / chart_pro design).
 *
 * Data contract:
 *   setData(candles)      replace history (from GET /candles)
 *   push(price, time)     live tick -> updates the forming candle + price line
 *   applyCandle(candle)   authoritative OHLC for the forming candle
 *   closeCandle(candle)   confirmed closed candle
 *   setMarkers(markers)   entry / expiry markers for open + settled trades
 *
 * The client never decides prices; it only renders what the server sends.
 */

const COLORS = {
  bg: '#0b0f16',
  grid: 'rgba(255,255,255,.05)',
  text: '#6e7787',
  up: '#22d3a0',
  down: '#ff4d6d',
  accent: '#5b8cff',
  entry: '#f5b83d',
  expiry: '#9b7bff',
};

const AXIS_W = 78;
const PAD_T = 54;
const PAD_B = 26;

export function createChart(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;

  const state = {
    type: opts.type || 'candle',
    tf: '1m',
    tfMs: 60_000,
    decimals: 2,
    candles: [],
    markers: [],
    last: 0,
    px: 0,
    open0: 0,
    lo: 0,
    hi: 0,
    bars: 90,
    barsTarget: 90,
    slide: 0,
    fade: 1,
    shift: 0,
    shiftTarget: 0,
    dragging: false,
    dragX: 0,
    mouse: null,
    hover: null,
    cw: 10,
    serverOffset: 0,
    watermark: opts.watermark ?? 'SIMULASI',
  };

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const bucketOf = (t) => Math.floor(t / state.tfMs) * state.tfMs;

  function upsert(candle) {
    const arr = state.candles;
    const last = arr[arr.length - 1];
    if (!last || candle.t > last.t) {
      arr.push({ ...candle });
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      if (state.shiftTarget > 0) {
        state.shift += 1;
        state.shiftTarget += 1;
      } else {
        state.slide = 1;
      }
      return true;
    }
    if (candle.t < last.t) {
      for (let i = arr.length - 1; i >= Math.max(0, arr.length - 6); i--) {
        if (arr[i].t === candle.t) {
          arr[i] = { ...candle };
          return false;
        }
      }
      return false;
    }
    Object.assign(last, candle);
    return false;
  }

  const api = {
    onHover: null,
    setTimeframe(tf, tfMs) {
      state.tf = tf;
      state.tfMs = tfMs;
      state.slide = 0;
      state.fade = 0;
    },
    setDecimals(d) {
      state.decimals = d;
    },
    setType(type) {
      state.type = type;
      state.fade = 0;
    },
    setServerOffset(offset) {
      if (Number.isFinite(offset)) state.serverOffset = offset;
    },
    setData(candles) {
      state.candles = (candles || [])
        .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o))
        .map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }))
        .sort((a, b) => a.t - b.t);
      const first = state.candles[0];
      const last = state.candles[state.candles.length - 1];
      if (first) state.open0 = first.o;
      if (last) {
        state.last = last.c;
        state.px = last.c;
      }
      state.hi = 0;
      state.fade = 0;
    },
    push(price, time) {
      if (!Number.isFinite(price) || !Number.isFinite(time)) return;
      state.last = price;
      if (!state.open0) state.open0 = price;
      const bucket = bucketOf(time);
      const last = state.candles[state.candles.length - 1];
      if (!last || last.t < bucket) {
        upsert({ t: bucket, o: price, h: price, l: price, c: price });
      } else if (last.t === bucket) {
        last.c = price;
        if (price > last.h) last.h = price;
        if (price < last.l) last.l = price;
      }
    },
    applyCandle(c) {
      if (!c) return;
      upsert(c);
      state.last = c.c;
    },
    closeCandle(c) {
      if (!c) return;
      const last = state.candles[state.candles.length - 1];
      if (last && c.t === last.t) Object.assign(last, c);
      else if (!last || c.t > last.t) upsert(c);
    },
    setMarkers(markers) {
      state.markers = markers || [];
    },
    setPrice(p) {
      if (Number.isFinite(p)) state.last = p;
    },
    goLive() {
      state.shiftTarget = 0;
    },
    isLive() {
      return state.shiftTarget < 0.5;
    },
    getLast() {
      return state.last;
    },
    resize,
  };

  // ------------------------------------------------------------- interaction
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.barsTarget = Math.max(24, Math.min(220, state.barsTarget * (e.deltaY > 0 ? 1.12 : 0.89)));
    },
    { passive: false },
  );
  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    state.dragX = e.clientX;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    state.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (state.dragging) {
      const dx = e.clientX - state.dragX;
      state.dragX = e.clientX;
      const max = Math.max(0, state.candles.length - 8);
      state.shift = state.shiftTarget = Math.max(0, Math.min(max, state.shiftTarget + dx / state.cw));
    }
  });
  const endDrag = () => {
    state.dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    state.mouse = null;
  });

  // ---------------------------------------------------------------- drawing
  const niceStep = (range, n) => {
    const raw = range / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  };
  const rr = (x, y, w, h, r) => {
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  };

  function drawCandles(vis, xOf, yOf, cw) {
    const bw = Math.max(2, cw * 0.66);
    const r = Math.min(3, bw / 2);
    vis.forEach((k, j) => {
      const cx = xOf(j);
      const up = k.c >= k.o;
      const col = up ? COLORS.up : COLORS.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.max(1, cw * 0.08);
      ctx.beginPath();
      ctx.moveTo(cx, yOf(k.h));
      ctx.lineTo(cx, yOf(k.l));
      ctx.stroke();
      const top = yOf(Math.max(k.o, k.c));
      const bot = yOf(Math.min(k.o, k.c));
      if (j === vis.length - 1) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      rr(cx - bw / 2, top, bw, Math.max(2, bot - top), r);
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  function drawOhlc(vis, xOf, yOf, cw) {
    const tick = Math.max(2, cw * 0.34);
    vis.forEach((k, j) => {
      const cx = xOf(j);
      ctx.strokeStyle = k.c >= k.o ? COLORS.up : COLORS.down;
      ctx.lineWidth = Math.max(1.2, cw * 0.09);
      ctx.beginPath();
      ctx.moveTo(cx, yOf(k.h));
      ctx.lineTo(cx, yOf(k.l));
      ctx.moveTo(cx - tick, yOf(k.o));
      ctx.lineTo(cx, yOf(k.o));
      ctx.moveTo(cx, yOf(k.c));
      ctx.lineTo(cx + tick, yOf(k.c));
      ctx.stroke();
    });
  }

  function drawLine(vis, xOf, yOf, chartH, area) {
    if (vis.length < 2) return;
    const pts = vis.map((k, j) => ({ x: xOf(j), y: yOf(k.c) }));
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    };
    if (area) {
      trace();
      ctx.lineTo(pts[pts.length - 1].x, PAD_T + chartH);
      ctx.lineTo(pts[0].x, PAD_T + chartH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + chartH);
      grad.addColorStop(0, 'rgba(91,140,255,.32)');
      grad.addColorStop(1, 'rgba(91,140,255,0)');
      ctx.fillStyle = grad;
      ctx.fill();
    }
    trace();
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame((t) => {
      renderQueued = false;
      frame(t);
    });
  }

  function frame(t) {
    state.bars += (state.barsTarget - state.bars) * 0.15;
    state.slide += (0 - state.slide) * 0.14;
    state.fade += (1 - state.fade) * 0.12;
    if (!state.dragging) state.shift += (state.shiftTarget - state.shift) * 0.15;
    state.px += (state.last - state.px) * 0.22;

    const chartW = W - AXIS_W;
    const chartH = H - PAD_T - PAD_B;
    const cw = chartW / state.bars;
    state.cw = cw;
    const visibleCount = Math.ceil(state.bars) + 2;
    const len = state.candles.length;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // SIMULASI watermark (always visible)
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.max(40, Math.min(120, chartW / 8))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.watermark, chartW / 2, PAD_T + chartH / 2);
    ctx.restore();

    if (!len) {
      requestRender();
      return;
    }

    const shift = Math.max(0, state.shift);
    const shiftI = Math.floor(shift);
    const frac = shift - shiftI;
    const rightIdx = Math.max(0, len - 1 - shiftI);
    const first = Math.max(0, rightIdx - visibleCount + 1);
    const vis = state.candles.slice(first, rightIdx + 1);
    const m = vis.length;
    const base = chartW - cw / 2 + (state.slide + frac) * cw;
    const xOf = (j) => base - (rightIdx - (first + j)) * cw;

    const isLine = state.type === 'line' || state.type === 'area';
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of vis) {
      const a = isLine ? k.c : k.l;
      const b = isLine ? k.c : k.h;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    // keep markers inside the visible price scale
    for (const mk of state.markers) {
      if (Number.isFinite(mk.price)) {
        lo = Math.min(lo, mk.price);
        hi = Math.max(hi, mk.price);
      }
    }
    const pad = (hi - lo) * 0.14 || 0.5;
    lo -= pad;
    hi += pad;
    if (!state.hi) {
      state.lo = lo;
      state.hi = hi;
    }
    state.lo += (lo - state.lo) * 0.18;
    state.hi += (hi - state.hi) * 0.18;
    const Lo = state.lo;
    const Hi = state.hi;
    const yOf = (p) => PAD_T + ((Hi - p) / (Hi - Lo || 1)) * chartH;

    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';

    const step = niceStep(Hi - Lo, 6);
    const dp = Math.max(0, Math.min(state.decimals, Math.ceil(-Math.log10(step))));
    ctx.textAlign = 'left';
    for (let v = Math.ceil(Lo / step) * step; v < Hi; v += step) {
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(chartW, yy);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(v.toFixed(dp), chartW + 10, yy);
    }

    const every = Math.max(1, Math.round(110 / cw));
    ctx.textAlign = 'center';
    for (let j = 0; j < m; j++) {
      const g = first + j;
      if ((rightIdx - g) % every !== 0) continue;
      const xx = Math.round(xOf(j)) + 0.5;
      if (xx < 0 || xx > chartW) continue;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(xx, PAD_T);
      ctx.lineTo(xx, PAD_T + chartH);
      ctx.stroke();
      const label = new Date(state.candles[g].t).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        ...(state.tfMs < 60_000 ? { second: '2-digit' } : {}),
      });
      ctx.fillStyle = COLORS.text;
      ctx.fillText(label, xx, H - 12);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, PAD_T, chartW, chartH);
    ctx.clip();
    ctx.globalAlpha = state.fade;
    if (state.type === 'candle') drawCandles(vis, xOf, yOf, cw);
    else if (state.type === 'ohlc') drawOhlc(vis, xOf, yOf, cw);
    else drawLine(vis, xOf, yOf, chartH, state.type === 'area');
    ctx.globalAlpha = 1;

    // ---- trade markers (entry / expiry) --------------------------------
    const nowMs = Date.now() + state.serverOffset;
    for (const mk of state.markers) {
      const priceY = yOf(mk.price);
      const color = mk.kind === 'entry' ? COLORS.entry : COLORS.expiry;
      const label = `${mk.kind === 'entry' ? 'ENTRY' : 'EXPIRY'} ${mk.direction === 'down' ? 'SELL' : 'BUY'} ${Number(mk.price).toFixed(state.decimals)}`;
      ctx.setLineDash(mk.kind === 'entry' ? [5, 4] : [2, 3]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = mk.open ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.moveTo(0, priceY);
      ctx.lineTo(chartW, priceY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      const textW = ctx.measureText(label).width + 12;
      ctx.fillStyle = color;
      ctx.beginPath();
      rr(6, priceY - 16, textW, 15, 4);
      ctx.fill();
      ctx.fillStyle = '#0b0f16';
      ctx.textAlign = 'left';
      ctx.fillText(label, 12, priceY - 8);

      // pending-trade countdown marker on the time axis
      if (mk.open && mk.expiryTime > nowMs) {
        const remaining = (mk.expiryTime - nowMs) / 1000;
        if (remaining < 3600) {
          const cx = chartW - 4 - Math.min(chartW - 8, (remaining / (state.tfMs / 1000)) * cw);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(cx, PAD_T + chartH - 8, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const last = vis[m - 1];
    const liveColor = state.last >= last.o ? COLORS.up : COLORS.down;
    const py = yOf(state.px);
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(230,233,239,.35)';
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(chartW, py);
    ctx.stroke();
    ctx.setLineDash([]);

    const lx = xOf(m - 1);
    if (lx > -20 && lx < chartW + 20) {
      const pulse = (Math.sin((t / 1000) * 4) + 1) / 2;
      ctx.globalAlpha = 0.25 * (1 - pulse);
      ctx.fillStyle = liveColor;
      ctx.beginPath();
      ctx.arc(lx, py, 4 + pulse * 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(lx, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // price axis badge
    ctx.fillStyle = liveColor;
    ctx.beginPath();
    rr(chartW + 3, py - 10, AXIS_W - 6, 20, 5);
    ctx.fill();
    ctx.fillStyle = '#0b0f16';
    ctx.textAlign = 'center';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillText(state.px.toFixed(state.decimals), chartW + AXIS_W / 2, py);

    // candle countdown (server clock)
    const remaining = Math.max(0, last.t + state.tfMs - nowMs) / 1000;
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`${remaining.toFixed(1)}s`, chartW + AXIS_W / 2, py + 20);

    // crosshair + hover info
    state.hover = null;
    const mo = state.mouse;
    if (mo && mo.x > 0 && mo.x < chartW && mo.y > PAD_T && mo.y < PAD_T + chartH) {
      let g = Math.round(rightIdx - (base - mo.x) / cw);
      g = Math.max(0, Math.min(len - 1, g));
      state.hover = state.candles[g];
      const cx = base - (rightIdx - g) * cw;
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
      rr(chartW + 3, mo.y - 10, AXIS_W - 6, 20, 5);
      ctx.fill();
      ctx.fillStyle = '#e6e9ef';
      ctx.textAlign = 'center';
      ctx.fillText(hp.toFixed(state.decimals), chartW + AXIS_W / 2, mo.y);
    }

    if (api.onHover) api.onHover({ candle: state.hover || last, hovered: Boolean(state.hover), live: state.last });
    requestRender();
  }
  requestRender();

  return api;
}
