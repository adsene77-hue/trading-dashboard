/* =====================================================================
   Overlay SMC (Smart Money Concepts) di atas Lightweight Charts
   - Struktur pasar: swing HH/HL/LH/LL, BOS & CHoCH
   - Order Block aktif (belum termitigasi)
   - Fair Value Gap aktif (belum terisi)
   - Zona Premium / Equilibrium / Discount
   Data: PAXG/USDT dari Binance (token emas 1:1 troy ounce, proxy XAUUSD)
   ===================================================================== */
(() => {
  const COLORS = {
    bull: '#26c281',
    bear: '#f05252',
    gold: '#e8c060',
    text: '#c9cdd4'
  };
  const SYMBOL = 'PAXGUSDT';
  // data-api.binance.vision = endpoint khusus data pasar (tetap bisa diakses walau api.binance.com diblokir)
  const SOURCES = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const TZ_OFFSET = 7 * 3600; // tampilkan waktu dalam WIB
  const POLL_MS = 5000;
  const LIMITS = { structures: 12, swings: 24, obPerSide: 3, fvgs: 8 };

  const state = {
    interval: '1h',
    swingLen: 5,
    candles: [],
    smc: null,
    show: { structure: true, ob: true, fvg: true, pd: true },
    loadId: 0,
    pollTimer: null,
    source: SOURCES[0],
    version: 0
  };

  const el = document.getElementById('smc-chart');
  const canvas = document.getElementById('smc-overlay');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('smc-status');

  /* ---------- Chart ---------- */
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: '#0d0f14' },
      textColor: '#8a909c',
      fontFamily: 'Inter, system-ui, sans-serif'
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
    },
    rightPriceScale: { borderColor: '#1a1e26' },
    timeScale: { borderColor: '#1a1e26', timeVisible: true, secondsVisible: false, rightOffset: 12 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
  });

  const series = chart.addCandlestickSeries({
    upColor: COLORS.bull,
    downColor: COLORS.bear,
    borderVisible: false,
    wickUpColor: COLORS.bull,
    wickDownColor: COLORS.bear
  });

  /* ---------- Data ---------- */
  const toCandle = r => ({
    time: Math.floor(r[0] / 1000) + TZ_OFFSET,
    open: +r[1], high: +r[2], low: +r[3], close: +r[4]
  });

  async function fetchKlines(limit) {
    // Coba sumber terakhir yang berhasil dulu, lalu sisanya
    const order = [state.source, ...SOURCES.filter(s => s !== state.source)];
    let lastErr;
    for (const base of order) {
      try {
        const res = await fetch(`${base}/api/v3/klines?symbol=${SYMBOL}&interval=${state.interval}&limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.source = base;
        return (await res.json()).map(toCandle);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function load() {
    const id = ++state.loadId;
    clearTimeout(state.pollTimer);
    setStatus('Memuat data…');
    try {
      const candles = await fetchKlines(700);
      if (id !== state.loadId) return;
      state.candles = candles;
      series.setData(candles);
      const n = candles.length;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 160), to: n + 12 });
      recompute();
      setStatus('');
      schedulePoll(id);
    } catch (err) {
      if (id === state.loadId) setStatus('Gagal memuat data Binance: ' + err.message);
    }
  }

  function schedulePoll(id) {
    state.pollTimer = setTimeout(async () => {
      if (id !== state.loadId) return;
      try {
        const latest = await fetchKlines(2);
        if (id !== state.loadId) return;
        let changed = false;
        for (const bar of latest) {
          const last = state.candles[state.candles.length - 1];
          if (last && bar.time === last.time) {
            state.candles[state.candles.length - 1] = bar;
          } else if (!last || bar.time > last.time) {
            state.candles.push(bar);
          } else {
            continue;
          }
          series.update(bar);
          changed = true;
        }
        if (changed) recompute();
      } catch (err) {
        // Gagal sementara: coba lagi di putaran berikutnya
      }
      schedulePoll(id);
    }, POLL_MS);
  }

  /* ---------- Mesin SMC ---------- */
  function computeSMC(c, len) {
    const n = c.length;
    const structures = [];
    const swings = [];
    const obs = [];
    const fvgs = [];
    let lastHigh = null;
    let lastLow = null;
    let prevHighPrice = null;
    let prevLowPrice = null;
    let trend = 0;

    // FVG yang terlalu kecil diabaikan (di bawah 10% rata-rata range candle)
    const avgRange = c.reduce((s, b) => s + (b.high - b.low), 0) / Math.max(1, n);
    const minGap = avgRange * 0.1;

    const isPivotHigh = s => {
      for (let j = s - len; j <= s + len; j++) {
        if (j === s) continue;
        if (j < s ? c[j].high >= c[s].high : c[j].high > c[s].high) return false;
      }
      return true;
    };
    const isPivotLow = s => {
      for (let j = s - len; j <= s + len; j++) {
        if (j === s) continue;
        if (j < s ? c[j].low <= c[s].low : c[j].low < c[s].low) return false;
      }
      return true;
    };

    for (let i = 0; i < n; i++) {
      const bar = c[i];

      // Swing di indeks s baru terkonfirmasi setelah `len` candle di kanannya terbentuk
      const s = i - len;
      if (s >= len) {
        if (isPivotHigh(s)) {
          const price = c[s].high;
          swings.push({ idx: s, price, dir: 1, label: prevHighPrice === null ? '' : price > prevHighPrice ? 'HH' : 'LH' });
          prevHighPrice = price;
          lastHigh = { idx: s, price, broken: false };
        }
        if (isPivotLow(s)) {
          const price = c[s].low;
          swings.push({ idx: s, price, dir: -1, label: prevLowPrice === null ? '' : price < prevLowPrice ? 'LL' : 'HL' });
          prevLowPrice = price;
          lastLow = { idx: s, price, broken: false };
        }
      }

      // Break of Structure / Change of Character (konfirmasi dengan close)
      if (lastHigh && !lastHigh.broken && bar.close > lastHigh.price) {
        lastHigh.broken = true;
        structures.push({ from: lastHigh.idx, to: i, price: lastHigh.price, dir: 1, type: trend === -1 ? 'CHoCH' : 'BOS' });
        trend = 1;
        // Bullish OB: candle dengan low terendah antara swing high dan candle penembus
        let ob = lastHigh.idx;
        for (let j = lastHigh.idx; j < i; j++) if (c[j].low < c[ob].low) ob = j;
        obs.push({ start: ob, top: c[ob].high, bottom: c[ob].low, dir: 1, born: i, end: null });
      }
      if (lastLow && !lastLow.broken && bar.close < lastLow.price) {
        lastLow.broken = true;
        structures.push({ from: lastLow.idx, to: i, price: lastLow.price, dir: -1, type: trend === 1 ? 'CHoCH' : 'BOS' });
        trend = -1;
        // Bearish OB: candle dengan high tertinggi antara swing low dan candle penembus
        let ob = lastLow.idx;
        for (let j = lastLow.idx; j < i; j++) if (c[j].high > c[ob].high) ob = j;
        obs.push({ start: ob, top: c[ob].high, bottom: c[ob].low, dir: -1, born: i, end: null });
      }

      // Mitigasi Order Block: close menembus sisi seberang zona
      for (const o of obs) {
        if (o.end !== null || o.born >= i) continue;
        if (o.dir === 1 ? bar.close < o.bottom : bar.close > o.top) o.end = i;
      }

      // Fair Value Gap (pola 3 candle)
      if (i >= 2) {
        const a = c[i - 2];
        const m = c[i - 1];
        if (bar.low > a.high && m.close > a.high && bar.low - a.high >= minGap) {
          fvgs.push({ start: i - 1, top: bar.low, bottom: a.high, dir: 1, born: i, end: null });
        }
        if (bar.high < a.low && m.close < a.low && a.low - bar.high >= minGap) {
          fvgs.push({ start: i - 1, top: a.low, bottom: bar.high, dir: -1, born: i, end: null });
        }
      }
      // FVG dianggap terisi saat harga menyentuh ujung terjauh gap
      for (const f of fvgs) {
        if (f.end !== null || f.born >= i) continue;
        if (f.dir === 1 ? bar.low <= f.bottom : bar.high >= f.top) f.end = i;
      }
    }

    // Zona Premium/Discount: range sejak swing high & low terakhir
    let pd = null;
    if (lastHigh && lastLow) {
      const start = Math.min(lastHigh.idx, lastLow.idx);
      let top = -Infinity;
      let bottom = Infinity;
      for (let j = start; j < n; j++) {
        if (c[j].high > top) top = c[j].high;
        if (c[j].low < bottom) bottom = c[j].low;
      }
      pd = { start, top, bottom };
    }

    const activeOb = dir => obs.filter(o => o.dir === dir && o.end === null).slice(-LIMITS.obPerSide);

    return {
      trend,
      structures: structures.slice(-LIMITS.structures),
      swings: swings.filter(s => s.label).slice(-LIMITS.swings),
      obs: [...activeOb(1), ...activeOb(-1)],
      fvgs: fvgs.filter(f => f.end === null).slice(-LIMITS.fvgs),
      pd
    };
  }

  function recompute() {
    state.smc = computeSMC(state.candles, state.swingLen);
    state.version++;
    updateInfo();
    // Diteruskan ke peluang.js untuk petunjuk zona beli/jual
    const last = state.candles[state.candles.length - 1];
    window.dispatchEvent(new CustomEvent('smc:update', {
      detail: { smc: state.smc, price: last.close, interval: state.interval }
    }));
  }

  /* ---------- Info bar ---------- */
  function updateInfo() {
    const { trend, structures } = state.smc;
    const last = state.candles[state.candles.length - 1];
    const trendEl = document.getElementById('smc-trend');
    trendEl.textContent = trend === 1 ? 'Bullish' : trend === -1 ? 'Bearish' : 'Netral';
    trendEl.className = trend === 1 ? 'up' : trend === -1 ? 'down' : '';
    document.getElementById('smc-price').textContent = last ? last.close.toFixed(2) : '—';
    const ev = structures[structures.length - 1];
    const evEl = document.getElementById('smc-last');
    evEl.textContent = ev ? `${ev.type} ${ev.dir === 1 ? '▲' : '▼'} ${ev.price.toFixed(2)}` : '—';
    evEl.className = ev ? (ev.dir === 1 ? 'up' : 'down') : '';
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
  }

  /* ---------- Gambar overlay (canvas) ---------- */
  const alpha = (hex, a) => {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${v >> 16}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  };

  function drawZone(x1, x2, y1, y2, color, label) {
    if (x1 === null || y1 === null || y2 === null) return;
    const top = Math.min(y1, y2);
    const h = Math.max(1, Math.abs(y2 - y1));
    ctx.fillStyle = alpha(color, 0.14);
    ctx.fillRect(x1, top, x2 - x1, h);
    ctx.strokeStyle = alpha(color, 0.45);
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, top + 0.5, x2 - x1 - 1, h - 1);
    if (label && h >= 10) {
      ctx.fillStyle = alpha(color, 0.9);
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(label, x1 + 5, top + h / 2);
    }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.smc) return;

    const ts = chart.timeScale();
    const paneW = ts.width();
    const paneH = h - ts.height();
    const X = i => ts.logicalToCoordinate(i);
    const Y = p => series.priceToCoordinate(p);

    // Hanya gambar di area candle, jangan menutupi skala harga/waktu
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, paneW, paneH);
    ctx.clip();

    const { structures, swings, obs, fvgs, pd } = state.smc;

    if (state.show.pd && pd) {
      const x1 = X(pd.start);
      const mid = (pd.top + pd.bottom) / 2;
      const yTop = Y(pd.top);
      const yMid = Y(mid);
      const yBot = Y(pd.bottom);
      if (x1 !== null && yTop !== null && yMid !== null && yBot !== null) {
        ctx.fillStyle = alpha(COLORS.bear, 0.05);
        ctx.fillRect(x1, yTop, paneW - x1, yMid - yTop);
        ctx.fillStyle = alpha(COLORS.bull, 0.05);
        ctx.fillRect(x1, yMid, paneW - x1, yBot - yMid);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = alpha(COLORS.gold, 0.6);
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(yMid) + 0.5);
        ctx.lineTo(paneW, Math.round(yMid) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 10px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillStyle = alpha(COLORS.bear, 0.8);
        ctx.fillText('PREMIUM', paneW - 6, yTop + 4);
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = alpha(COLORS.gold, 0.85);
        ctx.fillText('EQUILIBRIUM', paneW - 6, yMid - 3);
        ctx.fillStyle = alpha(COLORS.bull, 0.8);
        ctx.fillText('DISCOUNT', paneW - 6, yBot - 4);
      }
    }

    if (state.show.fvg) {
      for (const f of fvgs) {
        drawZone(X(f.start), paneW, Y(f.top), Y(f.bottom), f.dir === 1 ? COLORS.bull : COLORS.bear, 'FVG');
      }
    }

    if (state.show.ob) {
      for (const o of obs) {
        drawZone(X(o.start), paneW, Y(o.top), Y(o.bottom), o.dir === 1 ? COLORS.bull : COLORS.bear, o.dir === 1 ? 'Bull OB' : 'Bear OB');
      }
    }

    if (state.show.structure) {
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'center';

      for (const s of structures) {
        const x1 = X(s.from);
        const x2 = X(s.to);
        const y = Y(s.price);
        if (x1 === null || x2 === null || y === null) continue;
        const color = s.dir === 1 ? COLORS.bull : COLORS.bear;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(s.type === 'CHoCH' ? [5, 3] : []);
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(y) + 0.5);
        ctx.lineTo(x2, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.textBaseline = s.dir === 1 ? 'bottom' : 'top';
        ctx.fillText(s.type, (x1 + x2) / 2, s.dir === 1 ? y - 3 : y + 3);
      }

      ctx.font = '500 9px Inter, sans-serif';
      for (const sw of swings) {
        const x = X(sw.idx);
        const y = Y(sw.price);
        if (x === null || y === null) continue;
        ctx.fillStyle = alpha(COLORS.text, 0.75);
        ctx.textBaseline = sw.dir === 1 ? 'bottom' : 'top';
        ctx.fillText(sw.label, x, sw.dir === 1 ? y - 6 : y + 6);
      }
    }

    ctx.restore();
  }

  // Gambar ulang hanya saat posisi/skala chart atau data berubah
  let lastKey = '';
  function frame() {
    const range = chart.timeScale().getVisibleLogicalRange();
    const last = state.candles[state.candles.length - 1];
    const refA = last ? series.priceToCoordinate(last.close) : 0;
    const refB = last ? series.priceToCoordinate(last.close * 1.01) : 0;
    const key = [range && range.from, range && range.to, refA, refB, el.clientWidth, el.clientHeight, state.version].join('|');
    if (key !== lastKey) {
      lastKey = key;
      draw();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- Kontrol ---------- */
  document.getElementById('smc-intervals').addEventListener('click', e => {
    const btn = e.target.closest('button[data-interval]');
    if (!btn || btn.dataset.interval === state.interval) return;
    state.interval = btn.dataset.interval;
    for (const b of e.currentTarget.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    load();
  });

  document.getElementById('smc-swing').addEventListener('change', e => {
    state.swingLen = Number(e.target.value);
    if (state.candles.length) recompute();
  });

  for (const box of document.querySelectorAll('[data-layer]')) {
    box.addEventListener('change', () => {
      state.show[box.dataset.layer] = box.checked;
      state.version++;
    });
  }

  load();
})();
