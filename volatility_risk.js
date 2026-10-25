/* =====================================================================
   Kalkulator Volatilitas & Risiko Trader
   Jarak stop loss dan ukuran posisi mengikuti BESAR pergerakan harga
   (ATR), bukan arahnya. Data candle dibaca dari event "smc:update"
   yang dikirim smc.js; kanvas grafik tidak disentuh.
   ===================================================================== */
(() => {
  const ATR_LEN = 14;
  const BASE_LEN = 100; // rata-rata ATR dari 100 candle terakhir sebagai patokan "normal"
  // Ambang dengan sedikit histeresis agar status tidak berkedip saat ATR tepat di sekitar rata-rata
  const HIGH_ABOVE = 1.0;
  const LOW_BELOW = 0.95;
  const STORE_KEY = 'jejak-bandar:vol-calc';
  const TF_LABEL = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

  const ADVICE = {
    low: 'Jarak stop bisa lebih sempit. Fokus pada manajemen risiko.',
    high: 'Gejolak tinggi mendeteksi jarak stop lebih lebar. Sesuaikan ukuran posisi (lot) agar risiko tetap terkontrol.'
  };

  const $ = id => document.getElementById(id);
  const panel = $('volatility-risk-panel');
  const inputs = {
    balance: $('vol-balance'),
    risk: $('vol-risk'),
    mult: $('vol-mult'),
    contract: $('vol-contract')
  };

  let latest = null;
  let level = null; // 'low' | 'high'

  const money = n => '$' + n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, d = 2) => n.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  // Besar pergerakan dalam pips (FX) atau dolar (emas/minyak), harga sesuai presisi aset
  const move = n => window.Assets.fmtMove(n);
  const price = n => window.Assets.fmtPrice(n);
  const SHARED = ['balance', 'risk', 'mult'];

  /* ---------- Simpan input pengguna (kenyamanan per browser saja) ---------- */
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch (err) {
    // localStorage tidak tersedia: pakai nilai default
  }
  // Ukuran kontrak disimpan per aset (oz emas, unit FX, barel minyak)
  saved.contracts = saved.contracts || (saved.contract ? { XAUUSD: saved.contract } : {});
  for (const key of SHARED) if (saved[key] !== undefined) inputs[key].value = saved[key];

  function saveInputs() {
    for (const key of SHARED) saved[key] = inputs[key].value;
    saved.contracts[window.Assets.active.key] = inputs.contract.value;
    delete saved.contract;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (err) {
      // abaikan
    }
  }

  function applyAsset(asset) {
    inputs.contract.value = saved.contracts[asset.key] ?? asset.contract.size;
    $('vol-contract-label').textContent = `Ukuran kontrak (${asset.contract.unit}/lot)`;
    $('vol-note').textContent = `Harga & ATR dari ${asset.candles.label}; ukuran kontrak standar ${asset.label} = ` +
      `${asset.contract.size.toLocaleString('id-ID')} ${asset.contract.unit}/lot (cek spesifikasi broker Anda). Bukan saran investasi.`;
  }

  function resetPanel(note = 'Menunggu data candle…') {
    latest = null;
    level = null;
    panel.dataset.vol = 'none';
    $('vol-sub').textContent = `ATR ${ATR_LEN} vs rata-rata ${BASE_LEN} candle · ${window.Assets.active.candles.label}`;
    $('vol-badge-text').textContent = 'Status: Menunggu data';
    $('vol-level').textContent = '—';
    $('vol-level-note').textContent = note;
    $('vol-ratio').textContent = '—';
    $('vol-meter-fill').style.width = '0%';
    for (const id of ['vol-range', 'vol-atr', 'vol-base', 'vol-out-risk', 'vol-out-sl', 'vol-out-lot', 'vol-out-normal', 'vol-out-buy', 'vol-out-sell']) {
      $(id).textContent = '—';
    }
    $('vol-advice').innerHTML = `<b>Saran:</b> ${note}`;
    $('vol-warning').hidden = true;
    $('vol-lot-warning').hidden = true;
  }

  /* ---------- Pemindai volatilitas (ATR Wilder) ---------- */
  function computeVolatility(candles) {
    const n = candles.length;
    if (n < ATR_LEN + BASE_LEN) return null;

    const tr = candles.map((c, i) => i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));

    let atr = tr.slice(0, ATR_LEN).reduce((s, v) => s + v, 0) / ATR_LEN;
    const atrSeries = [];
    for (let i = ATR_LEN; i < n; i++) {
      atr = (atr * (ATR_LEN - 1) + tr[i]) / ATR_LEN;
      atrSeries.push(atr);
    }
    const recent = atrSeries.slice(-BASE_LEN);
    const baseline = recent.reduce((s, v) => s + v, 0) / recent.length;
    const last = candles[n - 1];

    return { atr, baseline, ratio: atr / baseline, activeRange: last.high - last.low, price: last.close };
  }

  function classify(ratio) {
    if (level === 'high') return ratio < LOW_BELOW ? 'low' : 'high';
    if (level === 'low') return ratio > HIGH_ABOVE ? 'high' : 'low';
    return ratio > HIGH_ABOVE ? 'high' : 'low';
  }

  window.addEventListener('asset:change', e => {
    applyAsset(e.detail);
    resetPanel();
  });
  window.addEventListener('smc:reset', e => resetPanel(e.detail.reason + '.'));

  window.addEventListener('smc:update', e => {
    const { candles, interval } = e.detail;
    const vol = computeVolatility(candles);
    if (!vol) return;
    latest = { ...vol, interval };
    level = classify(vol.ratio);
    render();
  });

  /* ---------- Kalkulator posisi ---------- */
  function readInputs() {
    const v = {};
    for (const key in inputs) v[key] = parseFloat(String(inputs[key].value).replace(',', '.'));
    const valid = v.balance > 0 && v.risk > 0 && v.risk <= 100 && v.mult > 0 && v.contract > 0;
    return valid ? v : null;
  }

  function sizing(v, atr) {
    const riskUsd = v.balance * v.risk / 100;
    const slDist = atr * v.mult;
    const lot = riskUsd / (slDist * v.contract);
    return { riskUsd, slDist, lot, lotRounded: Math.floor(lot * 100) / 100 };
  }

  /* ---------- Tampilan ---------- */
  function render() {
    if (!latest) return;
    const { atr, baseline, ratio, activeRange, price: last, interval } = latest;
    const tf = TF_LABEL[interval] || interval;

    panel.dataset.vol = level;
    $('vol-badge-text').textContent = `Status: Memantau Gejolak · ${tf}`;
    $('vol-sub').textContent = `ATR ${ATR_LEN} vs rata-rata ${BASE_LEN} candle · ${window.Assets.active.candles.label} ${tf}`;
    $('vol-level').textContent = level === 'high' ? 'Gejolak Tinggi' : 'Gejolak Rendah';
    $('vol-level-note').textContent = level === 'high' ? 'Ekstrem — pergerakan di atas rata-rata' : 'Stabil — pergerakan di bawah rata-rata';
    $('vol-ratio').textContent = `${num(ratio)}× rata-rata`;
    $('vol-meter-fill').style.width = Math.min(100, ratio / 2 * 100) + '%';

    $('vol-range').textContent = move(activeRange);
    $('vol-atr').textContent = move(atr);
    $('vol-base').textContent = move(baseline);

    const v = readInputs();
    const advice = $('vol-advice');
    const warn = $('vol-warning');

    if (!v) {
      for (const id of ['vol-out-risk', 'vol-out-sl', 'vol-out-lot', 'vol-out-normal', 'vol-out-buy', 'vol-out-sell']) $(id).textContent = '—';
      advice.innerHTML = `<b>Saran:</b> ${ADVICE[level]}`;
      warn.hidden = level !== 'high';
      $('vol-input-error').hidden = false;
      return;
    }
    $('vol-input-error').hidden = true;

    const now = sizing(v, atr);
    const normal = sizing(v, baseline);
    const lotText = r => (r.lotRounded >= 0.01 ? `${num(r.lotRounded)} lot` : '< 0,01 lot');

    $('vol-out-risk').textContent = money(now.riskUsd);
    $('vol-out-sl').textContent = move(now.slDist);
    $('vol-out-lot').textContent = lotText(now);
    $('vol-out-normal').textContent = lotText(normal);
    $('vol-out-buy').textContent = price(last - now.slDist);
    $('vol-out-sell').textContent = price(last + now.slDist);

    const change = normal.lot > 0 ? (now.lot / normal.lot - 1) * 100 : 0;
    const changeText = Math.abs(change) < 1
      ? 'setara dengan saat volatilitas rata-rata'
      : `${change < 0 ? 'lebih kecil' : 'lebih besar'} ${num(Math.abs(change), 0)}% dibanding saat volatilitas rata-rata (${lotText(normal)})`;

    const esc = s => s.replace(/</g, '&lt;');
    advice.innerHTML = `<b>Saran:</b> ${ADVICE[level]}
      <span class="vol-advice-detail">SL ${num(v.mult, 1)}× ATR = <b>${move(now.slDist)}</b> dari entry. Dengan risiko ${money(now.riskUsd)}, ukuran posisi <b>${esc(lotText(now))}</b> — ${esc(changeText)}.</span>`;

    warn.hidden = level !== 'high';
    $('vol-lot-warning').hidden = now.lotRounded >= 0.01;
  }

  for (const key in inputs) {
    inputs[key].addEventListener('input', () => {
      saveInputs();
      render();
    });
  }

  applyAsset(window.Assets.active);
})();
