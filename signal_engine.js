/* =====================================================================
   Lantai Komando Sinyal — pemindai 5 syarat entry SMC
   Membaca data dari smc.js lewat event "smc:update" & "smc:mtf" serta
   helper window.SMCSessions; tidak menyentuh kanvas grafik sama sekali.
   ===================================================================== */
let signalConditions = {
  mtfSelaras: false,
  zonaPremDisc: false,
  liquiditySweep: false,
  masukOTE: false,
  waktuKillzone: false
};

(() => {
  const SCAN_MS = 1000;
  const SWEEP_LOOKBACK = 12; // candle terakhir yang diperiksa untuk liquidity sweep
  const OTE = [0.618, 0.786];
  const TF_LABEL = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
  const LABELS = {
    mtfSelaras: 'MTF Selaras',
    zonaPremDisc: 'Zona Premium/Discount',
    liquiditySweep: 'Liquidity Sweep',
    masukOTE: 'Masuk OTE',
    waktuKillzone: 'Waktu Killzone'
  };

  const feed = { smc: null, mtf: null };
  const ui = {
    panel: document.getElementById('signal-panel'),
    orb: document.getElementById('signal-orb'),
    count: document.getElementById('signal-count'),
    title: document.getElementById('signal-title'),
    dir: document.getElementById('signal-dir'),
    desc: document.getElementById('signal-desc'),
    list: document.getElementById('signal-list'),
    sub: document.getElementById('signal-sub'),
    sound: document.getElementById('signal-sound')
  };

  let readyDir = 0; // arah sinyal yang sudah dibunyikan, agar beep hanya sekali per setup
  let soundOn = false;
  let audioCtx = null;

  window.addEventListener('smc:update', e => { feed.smc = e.detail; });
  window.addEventListener('smc:mtf', e => { feed.mtf = e.detail; });

  const fmt = n => n.toFixed(2);
  const fibLevel = (f, r) => (f.dir === 1 ? f.high - (f.high - f.low) * r : f.low + (f.high - f.low) * r);

  /* ---------- Arah kandidat: konsensus MTF, jika belum ada pakai tren TF aktif ---------- */
  function candidateDir(rows, smc) {
    if (rows.length === 3 && rows[0].trend !== 0 && rows.every(r => r.trend === rows[0].trend)) return rows[0].trend;
    return smc.trend;
  }

  /* ---------- Liquidity sweep: wick menembus swing lalu close kembali ---------- */
  function findSweep(dir, candles, swings) {
    const n = candles.length;
    const price = candles[n - 1].close;
    for (let i = n - 1; i >= Math.max(0, n - SWEEP_LOOKBACK); i--) {
      const bar = candles[i];
      for (const s of swings) {
        // Buy: sapu swing low (sell-side liquidity). Sell: sapu swing high (buy-side liquidity)
        if (s.dir !== -dir || s.idx >= i - 1) continue;
        if (dir === 1 && bar.low < s.price && bar.close > s.price && price > s.price) return { level: s.price, ago: n - 1 - i };
        if (dir === -1 && bar.high > s.price && bar.close < s.price && price < s.price) return { level: s.price, ago: n - 1 - i };
      }
    }
    return null;
  }

  /* ---------- Pemindai utama ---------- */
  function evaluateSignal() {
    const detail = {};
    for (const key in signalConditions) signalConditions[key] = false;

    if (!feed.smc) {
      for (const key in LABELS) detail[key] = 'Menunggu data grafik…';
      return render(0, detail, null);
    }

    const { smc, price, interval, candles } = feed.smc;
    const rows = (feed.mtf || []).filter(r => !r.error);
    const dir = candidateDir(rows, smc);
    const side = dir === 1 ? 'Buy' : dir === -1 ? 'Sell' : null;

    // 1. MTF selaras
    signalConditions.mtfSelaras = dir !== 0 && rows.length === 3 && rows.every(r => r.trend === dir);
    detail.mtfSelaras = rows.length
      ? rows.map(r => `${TF_LABEL[r.tf]} ${r.trend === 1 ? '▲' : r.trend === -1 ? '▼' : '–'}`).join(' · ')
      : 'Memuat matriks MTF…';

    // 2. Harga di Discount (buy) / Premium (sell)
    if (smc.pd) {
      const mid = (smc.pd.top + smc.pd.bottom) / 2;
      const zone = price < mid ? 'Discount' : 'Premium';
      signalConditions.zonaPremDisc = (dir === 1 && price < mid) || (dir === -1 && price > mid);
      detail.zonaPremDisc = `Harga di ${zone} (EQ ${fmt(mid)})` + (side && !signalConditions.zonaPremDisc ? ` — ${side} butuh ${dir === 1 ? 'Discount' : 'Premium'}` : '');
    } else {
      detail.zonaPremDisc = 'Range swing belum terbentuk';
    }

    // 3. Liquidity sweep searah
    const sweep = dir ? findSweep(dir, candles, smc.swings) : null;
    signalConditions.liquiditySweep = !!sweep;
    detail.liquiditySweep = sweep
      ? `${dir === 1 ? 'Sell-side' : 'Buy-side'} liquidity tersapu di ${fmt(sweep.level)} (${sweep.ago === 0 ? 'candle ini' : sweep.ago + ' candle lalu'})`
      : `Belum ada sweep ${dir === -1 ? 'swing high' : 'swing low'} dalam ${SWEEP_LOOKBACK} candle terakhir`;

    // 4. Harga di zona OTE 0.618–0.786 searah
    const fib = smc.fib;
    if (fib && fib.dir === dir) {
      const a = fibLevel(fib, OTE[0]);
      const b = fibLevel(fib, OTE[1]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      signalConditions.masukOTE = price >= lo && price <= hi;
      detail.masukOTE = `OTE ${fmt(lo)}–${fmt(hi)} · harga ${fmt(price)}`;
    } else {
      detail.masukOTE = 'Belum ada impuls Fibonacci searah';
    }

    // 5. Sedang dalam killzone (berdasarkan jam sekarang)
    const kz = window.SMCSessions ? window.SMCSessions.activeKillzone() : null;
    signalConditions.waktuKillzone = !!kz;
    detail.waktuKillzone = kz ? `${kz.name} sedang aktif` : 'Di luar killzone Asia/London/New York';

    render(dir, detail, interval);
  }

  /* ---------- Tampilan ---------- */
  function render(dir, detail, interval) {
    const keys = Object.keys(signalConditions);
    const done = keys.filter(k => signalConditions[k]).length;
    const ready = done === keys.length && dir !== 0;
    const state = ready ? (dir === 1 ? 'buy' : 'sell') : 'wait';

    ui.panel.dataset.state = state;
    ui.orb.className = 'signal-orb ' + state;
    ui.count.textContent = `${done}/${keys.length}`;
    if (interval) ui.sub.textContent = `Pemindai 5 syarat SMC · PAXG/USDT ${TF_LABEL[interval] || interval} · tiap ${SCAN_MS / 1000} dtk`;

    ui.dir.textContent = dir === 1 ? 'Arah kandidat: BUY' : dir === -1 ? 'Arah kandidat: SELL' : 'Arah kandidat: belum jelas';
    ui.dir.className = 'signal-dir ' + (dir === 1 ? 'up' : dir === -1 ? 'down' : '');

    if (ready) {
      ui.title.textContent = `SIGNAL READY - EKSEKUSI SEKARANG (${dir === 1 ? 'BUY' : 'SELL'})`;
      ui.desc.textContent = 'Kelima syarat terpenuhi. Konfirmasi ulang di chart, tentukan stop loss di luar zona sweep, lalu eksekusi sesuai manajemen risiko.';
    } else {
      const missing = keys.filter(k => !signalConditions[k]).map(k => LABELS[k]);
      ui.title.textContent = 'WAIT';
      ui.desc.textContent = `Belum ada setup yang lengkap. Menunggu: ${missing.join(', ')}.`;
    }

    ui.list.innerHTML = keys.map(k => `
      <li class="${signalConditions[k] ? 'ok' : 'no'}">
        <span class="check-icon" aria-hidden="true">${signalConditions[k] ? '✓' : ''}</span>
        <span class="check-text"><b>${LABELS[k]}</b><small>${detail[k]}</small></span>
      </li>`).join('');

    // Bunyikan beep hanya saat setup baru menjadi lengkap (atau arahnya berganti)
    if (ready && readyDir !== dir) beep();
    readyDir = ready ? dir : 0;
  }

  /* ---------- Audio peringatan ---------- */
  function beep() {
    if (!soundOn || !audioCtx) return;
    const t = audioCtx.currentTime;
    for (const offset of [0, 0.25, 0.5]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t + offset);
      gain.gain.exponentialRampToValueAtTime(0.15, t + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + offset);
      osc.stop(t + offset + 0.2);
    }
  }

  // Browser hanya mengizinkan audio setelah interaksi pengguna, jadi suara diaktifkan lewat tombol
  ui.sound.addEventListener('click', () => {
    soundOn = !soundOn;
    if (soundOn) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        beep(); // bunyi uji
      } catch (err) {
        soundOn = false;
      }
    }
    ui.sound.textContent = soundOn ? '🔊 Suara: Aktif' : '🔇 Suara: Mati';
    ui.sound.setAttribute('aria-pressed', String(soundOn));
  });

  evaluateSignal();
  setInterval(evaluateSignal, SCAN_MS);
})();
