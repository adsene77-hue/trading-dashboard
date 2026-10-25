/* =====================================================================
   Petunjuk Peluang — Jejak Bandar
   Menggabungkan bias mingguan dari COT (event "cot:update") dengan zona
   harga dari overlay SMC (event "smc:update") untuk menandai area
   beli/jual yang searah dengan posisi institusi.
   ===================================================================== */
(() => {
  const el = document.getElementById('opportunity');
  const state = { cot: null, smc: null };
  const MAX_ZONES = 3;
  const EQ_BAND = 0.05; // ±5% dari range dianggap area Equilibrium
  const TF_LABEL = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

  window.addEventListener('cot:update', e => { state.cot = e.detail; render(); });
  window.addEventListener('smc:update', e => { state.smc = e.detail; render(); });

  const fmt = n => n.toFixed(2);

  /* ---------- Bias COT ---------- */
  function cotBias({ analysis, data }) {
    const n = data.length;
    const net4 = n >= 5 ? data[n - 1].net - data[n - 5].net : analysis.dNet;
    const net4Text = `Net Long 4 minggu ${net4 >= 0 ? '+' : '−'}${Math.abs(net4).toLocaleString('id-ID')} kontrak.`;

    switch (analysis.verdict.key) {
      case 'accum':
        return { dir: 1, weak: false, label: 'Beli', note: 'Institusi menambah Net Long minggu ini. ' + net4Text };
      case 'dist':
        return { dir: -1, weak: false, label: 'Jual', note: 'Institusi mengurangi beli / menambah jual minggu ini. ' + net4Text };
    }
    // Taking profit / netral: arah ditentukan oleh tren Net Long 4 minggu
    if (net4 > 0) return { dir: 1, weak: true, label: 'Beli (hati-hati)', note: 'Ada taking profit minggu ini, tetapi ' + net4Text.charAt(0).toLowerCase() + net4Text.slice(1) };
    if (net4 < 0) return { dir: -1, weak: true, label: 'Jual (hati-hati)', note: 'Taking profit berlanjut. ' + net4Text };
    return { dir: 0, weak: true, label: 'Tunggu', note: 'Posisi institusi belum memberi arah yang jelas.' };
  }

  /* ---------- Posisi harga dalam range Premium/Discount ---------- */
  function pricePosition(pd, price) {
    if (!pd) return null;
    const mid = (pd.top + pd.bottom) / 2;
    const band = (pd.top - pd.bottom) * EQ_BAND;
    const zone = price > mid + band ? 'premium' : price < mid - band ? 'discount' : 'eq';
    return { mid, zone, label: { premium: 'Premium', discount: 'Discount', eq: 'Equilibrium' }[zone] };
  }

  /* ---------- Zona SMC searah bias ---------- */
  function candidateZones(dir, smc, price, mid) {
    const zones = [
      ...smc.obs.map(z => ({ ...z, kind: z.dir === 1 ? 'Bull OB' : 'Bear OB' })),
      ...smc.fvgs.map(z => ({ ...z, kind: z.dir === 1 ? 'Bull FVG' : 'Bear FVG' }))
    ];
    return zones
      .filter(z => z.dir === dir && (dir === 1 ? z.bottom < price : z.top > price))
      .map(z => ({
        ...z,
        inside: price >= z.bottom && price <= z.top,
        dist: dir === 1 ? Math.max(0, price - z.top) : Math.max(0, z.bottom - price),
        ideal: mid !== null && (dir === 1 ? z.top <= mid : z.bottom >= mid)
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_ZONES);
  }

  /* ---------- Render ---------- */
  function render() {
    if (!state.cot || !state.smc) {
      const waiting = [!state.cot && 'data COT', !state.smc && 'grafik SMC'].filter(Boolean).join(' & ');
      el.className = 'report-block opportunity';
      el.innerHTML = `<span class="report-label">Petunjuk Peluang · Jejak Bandar</span>
        <p class="opp-wait">Menunggu ${waiting}…</p>`;
      return;
    }

    const { smc, price, interval } = state.smc;
    const tf = TF_LABEL[interval] || interval;
    const bias = cotBias(state.cot);
    const pos = pricePosition(smc.pd, price);
    const mid = pos ? pos.mid : null;
    const trendLabel = smc.trend === 1 ? 'Bullish' : smc.trend === -1 ? 'Bearish' : 'Netral';

    let align;
    if (bias.dir === 0) align = { text: 'Tidak ada', cls: '' };
    else if (bias.dir === smc.trend) align = bias.weak ? { text: 'Sedang', cls: 'mid' } : { text: 'Kuat', cls: 'strong' };
    else align = { text: 'Berlawanan', cls: 'weak' };

    const zones = bias.dir ? candidateZones(bias.dir, smc, price, mid) : [];
    const steps = [];
    const sideWord = bias.dir === 1 ? 'beli' : 'jual';

    if (bias.dir === 0) {
      steps.push('Bias institusi belum jelas — lebih aman menunggu laporan COT berikutnya atau struktur SMC yang tegas.');
    } else {
      if (pos) {
        const idealArea = bias.dir === 1 ? `Discount (di bawah ${fmt(mid)})` : `Premium (di atas ${fmt(mid)})`;
        steps.push(`Area ${sideWord} ideal mengikuti bandar ada di zona <b>${idealArea}</b>.`);
        const chasing = bias.dir === 1 ? pos.zone === 'premium' : pos.zone === 'discount';
        if (chasing) {
          steps.push(`Harga sekarang di <b>${pos.label}</b> — hindari mengejar ${sideWord}; tunggu harga ${bias.dir === 1 ? 'koreksi turun' : 'memantul naik'} ke zona di ${bias.dir === 1 ? 'bawah' : 'atas'}.`);
        } else {
          steps.push(`Harga sekarang di <b>${pos.label}</b> — area ini mendukung ${sideWord}, perhatikan reaksi harga di zona terdekat.`);
        }
      }
      if (align.cls === 'weak') {
        steps.push(`Struktur ${tf} masih <b>${trendLabel}</b>, berlawanan dengan bias COT. Tunggu <b>CHoCH ${bias.dir === 1 ? 'bullish' : 'bearish'}</b> di ${tf} sebelum mencari entry.`);
      }
      steps.push('Saat harga masuk zona, tunggu konfirmasi (candle penolakan atau CHoCH di timeframe lebih kecil) sebelum entry.');
      if (smc.pd) {
        steps.push(bias.dir === 1
          ? `Target likuiditas terdekat: puncak range / swing high di <b>${fmt(smc.pd.top)}</b>.`
          : `Target likuiditas terdekat: dasar range / swing low di <b>${fmt(smc.pd.bottom)}</b>.`);
      }
    }

    const zoneRows = zones.map(z => {
      const invalid = z.dir === 1 ? `close &lt; ${fmt(z.bottom)}` : `close &gt; ${fmt(z.top)}`;
      const where = z.inside ? '<span class="tag-in">Harga di zona</span>' : `jarak ${fmt(z.dist)}`;
      return `<div class="opp-zone">
          <span class="z-kind ${z.dir === 1 ? 'up' : 'down'}">${z.kind}</span>
          <span class="z-range mono">${fmt(z.bottom)} – ${fmt(z.top)}</span>
          <span class="z-meta">${where}${z.ideal ? ` · <span class="tag-ideal">${z.dir === 1 ? 'Discount' : 'Premium'}</span>` : ''}</span>
          <span class="z-inv mono">Invalid: ${invalid}</span>
        </div>`;
    }).join('');

    const noZone = bias.dir
      ? `<p class="opp-wait">Belum ada Order Block/FVG ${sideWord} yang aktif di ${tf}. Tunggu struktur baru terbentuk, atau coba timeframe lain.</p>`
      : '';

    const biasCls = bias.dir === 1 ? 'buy' : bias.dir === -1 ? 'sell' : 'wait';
    el.className = `report-block opportunity opp-${biasCls}`;
    el.innerHTML = `
      <div class="opp-head">
        <span class="report-label">Petunjuk Peluang · Jejak Bandar</span>
        <span class="opp-badge">Bias ${bias.label}</span>
      </div>
      <div class="opp-grid">
        <div class="opp-stat"><span>Bias COT</span><b>${bias.label}</b><small>${bias.note}</small></div>
        <div class="opp-stat"><span>Struktur SMC ${tf}</span><b class="${smc.trend === 1 ? 'up' : smc.trend === -1 ? 'down' : ''}">${trendLabel}</b></div>
        <div class="opp-stat"><span>Keselarasan</span><b class="align-${align.cls}">${align.text}</b></div>
        <div class="opp-stat"><span>Posisi Harga</span><b>${pos ? pos.label : '—'}</b><small class="mono">${fmt(price)}${pos ? ` · EQ ${fmt(mid)}` : ''}</small></div>
      </div>
      <ul class="opp-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ul>
      ${bias.dir ? `<span class="report-label">Zona ${sideWord} terdekat (${tf})</span>` : ''}
      ${zoneRows ? `<div class="opp-zones">${zoneRows}</div>` : noZone}
      <p class="report-note">Petunjuk edukatif dari aturan otomatis, bukan saran investasi. Harga zona berbasis PAXG/USDT — sesuaikan selisihnya dengan harga XAUUSD di broker Anda.</p>`;
  }

  render();
})();
