/* =====================================================================
   Overlay SMC (Smart Money Concepts) di atas Lightweight Charts
   - Struktur pasar: swing HH/HL/LH/LL, BOS & CHoCH
   - Order Block aktif (belum termitigasi)
   - Fair Value Gap aktif (belum terisi)
   - Zona Premium / Equilibrium / Discount
   - Filter entry: Session Killzones, MTF Trend Matrix, Fibonacci OTE
   Data candle mengikuti aset aktif (window.Assets):
   - Binance: PAXG/USDT (proxy XAUUSD), EUR/USDT (proxy EURUSD)
   - Twelve Data (API key pengguna): GBP/USD, WTI/USD
   ===================================================================== */
(() => {
  const COLORS = {
    bull: '#26c281',
    bear: '#f05252',
    gold: '#e8c060',
    text: '#c9cdd4'
  };
  // data-api.binance.vision = endpoint khusus data pasar (tetap bisa diakses walau api.binance.com diblokir)
  const SOURCES = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const TWELVE_DATA = 'https://api.twelvedata.com/time_series';
  const TD_INTERVAL = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
  const TZ_OFFSET = 7 * 3600; // tampilkan waktu dalam WIB
  // Kuota gratis Twelve Data 800 request/hari & 8/menit, jadi asetnya diperbarui lebih jarang
  const POLL_MS = { binance: 5000, twelvedata: 5 * 60000 };
  const LIMITS = { structures: 12, swings: 24, obPerSide: 3, fvgs: 8 };

  // Killzone ICT didefinisikan dalam jam New York, sehingga pergeseran DST AS
  // otomatis ikut terkonversi ke WIB
  const KILLZONES = [
    { name: 'Asia', label: 'ASIA', short: 'AS', start: 20 * 60, end: 24 * 60, color: '#5b8cff' },
    { name: 'London Open', label: 'LONDON', short: 'LO', start: 2 * 60, end: 5 * 60, color: '#b07cff' },
    { name: 'New York Open', label: 'NEW YORK', short: 'NY', start: 7 * 60, end: 10 * 60, color: '#3fc1c9' }
  ];
  const KILLZONE_TFS = new Set(['15m', '1h']); // di 4H/1D satu candle lebih panjang dari sesi

  const FIB_LEVELS = [0, 0.5, 0.618, 0.705, 0.786, 1];
  const OTE = [0.618, 0.786];

  const MTF_TFS = ['15m', '1h', '4h'];
  const MTF_MS = { binance: 60000, twelvedata: 15 * 60000 };
  const TF_LABEL = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

  const state = {
    asset: window.Assets.active,
    interval: '1h',
    swingLen: 5,
    candles: [],
    smc: null,
    killzones: [],
    mtf: null,
    show: { structure: true, ob: true, fvg: true, pd: true, kz: true, fib: true, mtf: true },
    loadId: 0,
    mtfId: 0,
    pollTimer: null,
    mtfTimer: null,
    source: SOURCES[0],
    version: 0
  };

  const el = document.getElementById('smc-chart');
  const canvas = document.getElementById('smc-overlay');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('smc-status');
  const mtfEl = document.getElementById('smc-mtf');

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

  const priceFormat = asset => ({ type: 'price', precision: asset.decimals, minMove: 1 / 10 ** asset.decimals });
  const fmtP = n => window.Assets.fmtPrice(n, state.asset);

  async function fetchKlines(limit, interval = state.interval, asset = state.asset) {
    if (asset.candles.provider === 'twelvedata') return fetchTwelveData(limit, interval, asset);
    // Coba sumber terakhir yang berhasil dulu, lalu sisanya
    const order = [state.source, ...SOURCES.filter(s => s !== state.source)];
    let lastErr;
    for (const base of order) {
      try {
        const res = await fetch(`${base}/api/v3/klines?symbol=${asset.candles.symbol}&interval=${interval}&limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.source = base;
        return (await res.json()).map(toCandle);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function fetchTwelveData(limit, interval, asset) {
    const key = window.Assets.twelveDataKey;
    if (!key) throw new Error('API key Twelve Data belum diisi');
    const params = new URLSearchParams({
      symbol: asset.candles.symbol,
      interval: TD_INTERVAL[interval],
      outputsize: limit,
      timezone: 'UTC',
      order: 'asc',
      apikey: key
    });
    const res = await fetch(`${TWELVE_DATA}?${params}`);
    // Twelve Data mengirim alasan error dalam JSON, juga untuk status 401/429
    const json = await res.json().catch(() => null);
    if (!json || json.status === 'error' || !res.ok) {
      const code = json?.code || res.status;
      throw new Error(
        code === 401 ? 'API key Twelve Data tidak valid atau tidak berlaku untuk simbol ini' :
        code === 429 ? 'kuota Twelve Data habis, coba lagi beberapa saat lagi' :
        json?.message || `HTTP ${res.status}`);
    }
    return json.values.map(v => {
      const iso = v.datetime.length > 10 ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z';
      return { time: Date.parse(iso) / 1000 + TZ_OFFSET, open: +v.open, high: +v.high, low: +v.low, close: +v.close };
    });
  }

  function resetDownstream(reason) {
    window.dispatchEvent(new CustomEvent('smc:reset', { detail: { reason } }));
  }

  async function load() {
    const id = ++state.loadId;
    clearTimeout(state.pollTimer);
    if (window.Assets.needsKey(state.asset)) {
      setStatus(`Data candle ${state.asset.label} memakai Twelve Data — isi API key gratis di atas chart untuk mengaktifkan SMC, Lantai Komando, dan Kalkulator Volatilitas.`);
      resetDownstream(`Data candle ${state.asset.label} butuh API key Twelve Data`);
      return;
    }
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
      if (id !== state.loadId) return;
      setStatus(`Gagal memuat data ${state.asset.candles.label}: ${err.message}`);
      resetDownstream(`Gagal memuat data candle: ${err.message}`);
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
    }, POLL_MS[state.asset.candles.provider]);
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

    // Fibonacci OTE pada impuls terakhir searah tren:
    // bullish = swing low terakhir → high tertinggi setelahnya, bearish = sebaliknya
    let fib = null;
    if (trend === 1 && lastLow) {
      let hi = lastLow.idx;
      for (let j = lastLow.idx; j < n; j++) if (c[j].high > c[hi].high) hi = j;
      if (hi > lastLow.idx) fib = { dir: 1, from: lastLow.idx, to: hi, low: lastLow.price, high: c[hi].high };
    } else if (trend === -1 && lastHigh) {
      let lo = lastHigh.idx;
      for (let j = lastHigh.idx; j < n; j++) if (c[j].low < c[lo].low) lo = j;
      if (lo > lastHigh.idx) fib = { dir: -1, from: lastHigh.idx, to: lo, high: lastHigh.price, low: c[lo].low };
    }

    const activeOb = dir => obs.filter(o => o.dir === dir && o.end === null).slice(-LIMITS.obPerSide);

    return {
      trend,
      structures: structures.slice(-LIMITS.structures),
      swings: swings.filter(s => s.label).slice(-LIMITS.swings),
      obs: [...activeOb(1), ...activeOb(-1)],
      fvgs: fvgs.filter(f => f.end === null).slice(-LIMITS.fvgs),
      pd,
      fib
    };
  }

  // Harga level retracement: 0 = ujung impuls, 1 = awal impuls
  const fibLevel = (f, r) => (f.dir === 1 ? f.high - (f.high - f.low) * r : f.low + (f.high - f.low) * r);

  /* ---------- Session Killzones ---------- */
  const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const nyCache = new Map();

  function nyClockOf(utcSec) {
    const parts = nyFmt.formatToParts(new Date(utcSec * 1000));
    const get = type => parts.find(p => p.type === type).value;
    return { day: get('weekday'), min: Number(get('hour')) * 60 + Number(get('minute')) };
  }

  // Hari & menit jam New York, di-cache per waktu candle agar polling tetap ringan
  function nyClock(utcSec) {
    let v = nyCache.get(utcSec);
    if (v === undefined) {
      if (nyCache.size > 20000) nyCache.clear();
      v = nyClockOf(utcSec);
      nyCache.set(utcSec, v);
    }
    return v;
  }

  // Pasar emas tutup Jumat 17:00 – Minggu 18:00 NY (PAXG tetap jalan 24/7)
  const goldMarketOpen = ({ day, min }) =>
    !(day === 'Sat' || (day === 'Fri' && min >= 17 * 60) || (day === 'Sun' && min < 18 * 60));

  function computeKillzones(c) {
    if (!KILLZONE_TFS.has(state.interval)) return [];
    const runs = [];
    let cur = null;
    for (let i = 0; i < c.length; i++) {
      const clock = nyClock(c[i].time - TZ_OFFSET);
      const m = clock.min;
      const zone = goldMarketOpen(clock) ? KILLZONES.find(z => m >= z.start && m < z.end) || null : null;
      if (zone && cur && cur.zone === zone) {
        cur.end = i;
      } else if (zone) {
        cur = { zone, start: i, end: i };
        runs.push(cur);
      } else {
        cur = null;
      }
    }
    return runs;
  }

  // Dipakai signal_engine.js untuk mengecek killzone berdasarkan jam sekarang
  window.SMCSessions = {
    activeKillzone(nowSec = Date.now() / 1000) {
      const clock = nyClockOf(Math.floor(nowSec));
      if (!goldMarketOpen(clock)) return null;
      return KILLZONES.find(z => clock.min >= z.start && clock.min < z.end) || null;
    }
  };

  function renderKillzoneLegend() {
    const legend = document.getElementById('smc-kz-legend');
    // Selisih jam New York terhadap UTC saat ini (otomatis -4 saat DST, -5 saat standar)
    const now = Math.floor(Date.now() / 1000);
    const utcMin = Math.floor(now / 60) % 1440;
    const nyOffset = (nyClockOf(now).min - utcMin + 1440) % 1440;
    const toWib = m => {
      const w = (m - nyOffset + TZ_OFFSET / 60 + 2880) % 1440;
      return String(Math.floor(w / 60)).padStart(2, '0') + ':' + String(w % 60).padStart(2, '0');
    };
    const note = KILLZONE_TFS.has(state.interval) ? '' : '<span class="kz-note">tampil di 15m/1H</span>';
    legend.innerHTML = KILLZONES.map(z =>
      `<span class="kz-chip" style="--kz:${z.color}">${z.name} <b class="mono">${toWib(z.start)}–${toWib(z.end)}</b></span>`
    ).join('') + '<span class="kz-note">WIB</span>' + note;
  }

  /* ---------- MTF Trend Matrix ---------- */
  async function refreshMTF() {
    const id = ++state.mtfId;
    const len = state.swingLen;
    const asset = state.asset;
    if (window.Assets.needsKey(asset)) {
      state.mtf = null;
      renderMTF();
      return;
    }
    const rows = await Promise.all(MTF_TFS.map(async tf => {
      try {
        const r = computeSMC(await fetchKlines(500, tf, asset), len);
        return { tf, trend: r.trend, ev: r.structures[r.structures.length - 1] || null };
      } catch (err) {
        return { tf, error: true };
      }
    }));
    if (id !== state.mtfId) return;
    state.mtf = rows;
    renderMTF();
    window.dispatchEvent(new CustomEvent('smc:mtf', { detail: rows }));
  }

  function scheduleMTF() {
    clearTimeout(state.mtfTimer);
    state.mtfTimer = setTimeout(() => {
      refreshMTF();
      scheduleMTF();
    }, MTF_MS[state.asset.candles.provider]);
  }

  function renderMTF() {
    mtfEl.hidden = !state.show.mtf;
    if (!state.show.mtf) return;
    if (!state.mtf) {
      const waiting = window.Assets.needsKey(state.asset) ? 'Butuh API key Twelve Data' : 'Memuat…';
      mtfEl.innerHTML = `<div class="mtf-title">MTF Trend</div><div class="mtf-foot">${waiting}</div>`;
      return;
    }
    const body = state.mtf.map(r => {
      const active = r.tf === state.interval ? ' class="active"' : '';
      if (r.error) return `<tr${active}><td>${TF_LABEL[r.tf]}</td><td colspan="2" class="muted">gagal memuat</td></tr>`;
      const cls = r.trend === 1 ? 'up' : r.trend === -1 ? 'down' : 'muted';
      const trend = r.trend === 1 ? '▲ Bullish' : r.trend === -1 ? '▼ Bearish' : '— Netral';
      const ev = r.ev ? `${r.ev.type} ${fmtP(r.ev.price)}` : '—';
      return `<tr${active}><td>${TF_LABEL[r.tf]}</td><td class="${cls}">${trend}</td><td class="mono muted">${ev}</td></tr>`;
    }).join('');
    const trends = state.mtf.filter(r => !r.error).map(r => r.trend);
    const aligned = trends.length === MTF_TFS.length && trends[0] !== 0 && trends.every(t => t === trends[0]);
    const foot = aligned
      ? `<span class="${trends[0] === 1 ? 'up' : 'down'}">Selaras ${trends[0] === 1 ? 'Bullish' : 'Bearish'}</span>`
      : 'Campuran — tunggu keselarasan';
    mtfEl.innerHTML = `<div class="mtf-title">MTF Trend Matrix</div>
      <table><tbody>${body}</tbody></table>
      <div class="mtf-foot">${foot}</div>`;
  }

  function recompute() {
    state.smc = computeSMC(state.candles, state.swingLen);
    state.killzones = computeKillzones(state.candles);
    state.version++;
    updateInfo();
    // Diteruskan ke peluang.js untuk petunjuk zona beli/jual
    const last = state.candles[state.candles.length - 1];
    window.dispatchEvent(new CustomEvent('smc:update', {
      detail: { smc: state.smc, price: last.close, interval: state.interval, candles: state.candles, asset: state.asset }
    }));
  }

  /* ---------- Info bar ---------- */
  function updateInfo() {
    const { trend, structures, fib } = state.smc;
    const last = state.candles[state.candles.length - 1];
    const trendEl = document.getElementById('smc-trend');
    trendEl.textContent = trend === 1 ? 'Bullish' : trend === -1 ? 'Bearish' : 'Netral';
    trendEl.className = trend === 1 ? 'up' : trend === -1 ? 'down' : '';
    document.getElementById('smc-price').textContent = last ? fmtP(last.close) : '—';
    const ev = structures[structures.length - 1];
    const evEl = document.getElementById('smc-last');
    evEl.textContent = ev ? `${ev.type} ${ev.dir === 1 ? '▲' : '▼'} ${fmtP(ev.price)}` : '—';
    evEl.className = ev ? (ev.dir === 1 ? 'up' : 'down') : '';

    const oteEl = document.getElementById('smc-ote');
    if (fib && last) {
      const a = fibLevel(fib, OTE[0]);
      const b = fibLevel(fib, OTE[1]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const inZone = last.close >= lo && last.close <= hi;
      oteEl.textContent = `${fmtP(lo)}–${fmtP(hi)}${inZone ? ' · harga di OTE' : ''}`;
      oteEl.className = 'mono' + (inZone ? ' gold' : '');
    } else {
      oteEl.textContent = '—';
      oteEl.className = 'mono';
    }
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

  function drawKillzones(X, paneW, paneH) {
    ctx.font = '600 9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const run of state.killzones) {
      // logicalToCoordinate hanya andal untuk indeks bulat, jadi tepi blok
      // dihitung dari pusat candle ± setengah jarak antar-candle
      const xs = X(run.start);
      const xe = X(run.end);
      const next = X(run.start + 1);
      if (xs === null || xe === null || next === null) continue;
      const half = (next - xs) / 2;
      const x1 = xs - half;
      const x2 = xe + half;
      if (x2 < 0 || x1 > paneW) continue;
      ctx.fillStyle = alpha(run.zone.color, 0.07);
      ctx.fillRect(x1, 0, x2 - x1, paneH);
      // Label penuh jika muat, label pendek jika blok sempit (mis. 1H)
      const room = x2 - x1 - 6;
      const text = [run.zone.label, run.zone.short].find(t => ctx.measureText(t).width <= room);
      if (text) {
        ctx.fillStyle = alpha(run.zone.color, 0.7);
        ctx.fillText(text, x1 + 3, 6);
      }
    }
  }

  function drawFib(f, X, Y, paneW) {
    const x1 = X(f.from);
    const x2 = X(f.to);
    if (x1 === null || x2 === null) return;

    // Zona OTE 0.618–0.786
    const yA = Y(fibLevel(f, OTE[0]));
    const yB = Y(fibLevel(f, OTE[1]));
    if (yA !== null && yB !== null) {
      ctx.fillStyle = alpha(COLORS.gold, 0.13);
      ctx.fillRect(x1, Math.min(yA, yB), paneW - x1, Math.abs(yB - yA));
    }

    // Garis impuls yang diukur
    const yStart = Y(f.dir === 1 ? f.low : f.high);
    const yEnd = Y(f.dir === 1 ? f.high : f.low);
    if (yStart !== null && yEnd !== null) {
      ctx.strokeStyle = alpha(COLORS.gold, 0.5);
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, yStart);
      ctx.lineTo(x2, yEnd);
      ctx.stroke();
    }

    ctx.font = '500 9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const labelYs = [];
    // Level OTE diberi label lebih dulu; label lain dilewati jika bertumpuk (impuls kecil)
    const order = [...FIB_LEVELS].sort((a, b) => (b >= OTE[0] && b <= OTE[1]) - (a >= OTE[0] && a <= OTE[1]));
    for (const r of order) {
      const p = fibLevel(f, r);
      const y = Y(p);
      if (y === null) continue;
      const inOte = r >= OTE[0] && r <= OTE[1];
      ctx.strokeStyle = alpha(COLORS.gold, inOte ? 0.7 : 0.3);
      ctx.setLineDash(r === 0.705 ? [] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, Math.round(y) + 0.5);
      ctx.lineTo(paneW, Math.round(y) + 0.5);
      ctx.stroke();
      if (labelYs.some(ly => Math.abs(ly - y) < 11)) continue;
      labelYs.push(y);
      ctx.fillStyle = alpha(COLORS.gold, inOte ? 0.95 : 0.6);
      ctx.fillText(`${r} · ${fmtP(p)}${r === 0.705 ? ' OTE' : ''}`, x2 + 6, y - 2);
    }
    ctx.setLineDash([]);
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

    const { structures, swings, obs, fvgs, pd, fib } = state.smc;

    if (state.show.kz) drawKillzones(X, paneW, paneH);

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

    if (state.show.fib && fib) drawFib(fib, X, Y, paneW);

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
    renderKillzoneLegend();
    renderMTF();
    load();
  });

  document.getElementById('smc-swing').addEventListener('change', e => {
    state.swingLen = Number(e.target.value);
    if (state.candles.length) recompute();
    refreshMTF();
  });

  for (const box of document.querySelectorAll('[data-layer]')) {
    box.addEventListener('change', () => {
      state.show[box.dataset.layer] = box.checked;
      state.version++;
      if (box.dataset.layer === 'mtf') renderMTF();
    });
  }

  /* ---------- Multi-aset & API key Twelve Data ---------- */
  const keyBox = document.getElementById('td-key');
  const keyForm = document.getElementById('td-key-form');
  const keyInput = document.getElementById('td-key-input');
  const keyClear = document.getElementById('td-key-clear');

  function renderAssetUI() {
    const a = state.asset;
    document.getElementById('smc-sub').textContent = `${a.candles.label} (${a.candles.note}) · Lightweight Charts`;
    const usesKey = a.candles.provider === 'twelvedata';
    keyBox.hidden = !usesKey;
    if (!usesKey) return;
    const hasKey = !!window.Assets.twelveDataKey;
    document.getElementById('td-key-text').textContent = hasKey
      ? `Data candle ${a.label} dari Twelve Data (key tersimpan hanya di browser ini). Diperbarui tiap 5 menit karena kuota gratis 800 request/hari.`
      : `Data candle ${a.label} memakai Twelve Data dan butuh API key gratis milik Anda (disimpan hanya di browser ini).`;
    keyForm.hidden = hasKey;
    keyClear.hidden = !hasKey;
  }

  function resetInfo() {
    for (const id of ['smc-trend', 'smc-price', 'smc-last', 'smc-ote']) {
      const node = document.getElementById(id);
      node.textContent = '—';
      node.className = id === 'smc-trend' ? '' : 'mono';
    }
  }

  function switchAsset(asset) {
    state.asset = asset;
    // Naikkan id agar respons request aset lama diabaikan
    state.loadId++;
    state.mtfId++;
    clearTimeout(state.pollTimer);
    state.candles = [];
    state.smc = null;
    state.killzones = [];
    state.mtf = null;
    series.setData([]);
    series.applyOptions({ priceFormat: priceFormat(asset) });
    state.version++;
    resetInfo();
    renderAssetUI();
    renderMTF();
    load();
    refreshMTF();
    scheduleMTF();
  }

  keyForm.addEventListener('submit', e => {
    e.preventDefault();
    const value = keyInput.value.trim();
    if (!value) return;
    keyInput.value = '';
    window.Assets.twelveDataKey = value;
  });
  keyClear.addEventListener('click', () => { window.Assets.twelveDataKey = null; });

  window.addEventListener('asset:change', e => switchAsset(e.detail));
  window.addEventListener('asset:key', () => switchAsset(state.asset));

  series.applyOptions({ priceFormat: priceFormat(state.asset) });
  renderAssetUI();
  renderKillzoneLegend();
  renderMTF();
  load();
  refreshMTF();
  scheduleMTF();
})();
