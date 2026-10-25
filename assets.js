/* =====================================================================
   Multi-Asset Selector
   Satu sumber kebenaran untuk aset aktif. Modul lain membaca
   window.Assets.active dan mendengarkan event "asset:change".
   ===================================================================== */
(() => {
  const STORE_KEY = 'jejak-bandar:asset';
  const KEY_STORE = 'jejak-bandar:twelvedata-key';

  const ASSETS = {
    XAUUSD: {
      key: 'XAUUSD',
      label: 'XAUUSD',
      name: 'Emas',
      noun: 'emas',
      decimals: 2,
      pip: null,
      tv: {
        spot: 'OANDA:XAUUSD',
        spotNote: 'Harga Spot',
        second: 'BINANCE:PAXGUSDT',
        secondInterval: '60',
        secondNote: 'Token Emas · Volume Transaksi'
      },
      candles: { provider: 'binance', symbol: 'PAXGUSDT', label: 'PAXG/USDT', note: 'proxy XAUUSD · Binance' },
      contract: { size: 100, unit: 'oz' },
      cot: { code: '088691', name: 'Gold (COMEX)', report: 'disagg' },
      drivers: {
        bull: 'ekspektasi pelemahan Dolar AS atau meningkatnya ketegangan geopolitik (Safe Haven demand)',
        bear: 'ekspektasi inflasi mulai stabil sehingga daya tarik emas menurun',
        bearShort: 'berekspektasi inflasi mulai stabil'
      },
      dxyNote: 'Korelasi terbalik dengan emas'
    },
    EURUSD: {
      key: 'EURUSD',
      label: 'EURUSD',
      name: 'Euro',
      noun: 'euro',
      decimals: 5,
      pip: 0.0001,
      tv: {
        spot: 'OANDA:EURUSD',
        spotNote: 'Harga Spot',
        second: 'BINANCE:EURUSDT',
        secondInterval: '60',
        secondNote: 'EUR/USDT · Volume Transaksi'
      },
      candles: { provider: 'binance', symbol: 'EURUSDT', label: 'EUR/USDT', note: 'proxy EURUSD · Binance' },
      contract: { size: 100000, unit: 'EUR' },
      cot: { code: '099741', name: 'Euro FX (CME)', report: 'tff' },
      drivers: {
        bull: 'ekspektasi ECB lebih hawkish dibanding The Fed atau pelemahan Dolar AS',
        bear: 'ekspektasi The Fed lebih hawkish, data zona euro melemah, atau permintaan safe haven Dolar AS',
        bearShort: 'berekspektasi selisih suku bunga bergeser ke arah Dolar AS'
      },
      dxyNote: 'EUR ±57% bobot DXY — korelasi terbalik kuat'
    },
    GBPUSD: {
      key: 'GBPUSD',
      label: 'GBPUSD',
      name: 'Pound',
      noun: 'pound sterling',
      decimals: 5,
      pip: 0.0001,
      tv: {
        spot: 'OANDA:GBPUSD',
        spotNote: 'Harga Spot',
        second: 'OANDA:GBPUSD',
        secondInterval: '240',
        secondNote: 'Struktur 4H (volume riil tidak tersedia di widget gratis)'
      },
      candles: { provider: 'twelvedata', symbol: 'GBP/USD', label: 'GBP/USD', note: 'Twelve Data' },
      contract: { size: 100000, unit: 'GBP' },
      cot: { code: '096742', name: 'British Pound (CME)', report: 'tff' },
      drivers: {
        bull: 'ekspektasi Bank of England lebih hawkish atau pelemahan Dolar AS',
        bear: 'ekspektasi BoE memangkas suku bunga, data ekonomi Inggris melemah, atau penguatan Dolar AS',
        bearShort: 'berekspektasi BoE mulai melonggarkan kebijakan'
      },
      dxyNote: 'GBP ±12% bobot DXY — korelasi terbalik'
    },
    WTI: {
      key: 'WTI',
      label: 'WTI',
      name: 'Crude Oil',
      noun: 'minyak mentah',
      decimals: 2,
      pip: null,
      tv: {
        spot: 'TVC:USOIL',
        spotNote: 'CFD Minyak WTI',
        second: 'TVC:USOIL',
        secondInterval: '240',
        secondNote: 'Struktur 4H (futures NYMEX tidak tersedia di widget gratis)'
      },
      candles: { provider: 'twelvedata', symbol: 'WTI/USD', label: 'WTI/USD', note: 'Twelve Data' },
      contract: { size: 1000, unit: 'barel' },
      cot: { code: '067651', name: 'WTI Crude (NYMEX)', report: 'disagg' },
      drivers: {
        bull: 'gangguan pasokan (OPEC+, geopolitik Timur Tengah) atau permintaan global menguat',
        bear: 'kekhawatiran perlambatan ekonomi, permintaan melemah, atau kenaikan produksi',
        bearShort: 'berekspektasi pasokan melimpah'
      },
      dxyNote: 'Dolar kuat cenderung menekan harga minyak'
    }
  };

  const read = key => {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  };
  const write = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) {
      // localStorage tidak tersedia: pilihan hanya berlaku di sesi ini
    }
  };

  let active = ASSETS[read(STORE_KEY)] || ASSETS.XAUUSD;
  let memoryKey = null;

  const Assets = {
    list: Object.values(ASSETS),
    get active() { return active; },

    select(key) {
      const next = ASSETS[key];
      if (!next || next === active) return;
      active = next;
      write(STORE_KEY, key);
      renderNav();
      window.dispatchEvent(new CustomEvent('asset:change', { detail: active }));
    },

    // Harga dengan presisi sesuai aset (2 desimal emas/minyak, 5 desimal FX)
    fmtPrice(n, asset = active) {
      return Number.isFinite(n) ? n.toFixed(asset.decimals) : '—';
    },

    // Besar pergerakan: pips untuk FX, dolar untuk emas/minyak
    fmtMove(n, asset = active) {
      if (!Number.isFinite(n)) return '—';
      if (asset.pip) return (n / asset.pip).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' pips';
      return '$' + n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    get twelveDataKey() { return read(KEY_STORE) || memoryKey; },
    set twelveDataKey(value) {
      memoryKey = value || null;
      write(KEY_STORE, value || null);
      window.dispatchEvent(new CustomEvent('asset:key', { detail: !!value }));
    },

    needsKey(asset = active) {
      return asset.candles.provider === 'twelvedata' && !Assets.twelveDataKey;
    }
  };

  /* ---------- Bilah navigasi aset di header ---------- */
  const nav = document.getElementById('asset-nav');

  function renderNav() {
    nav.innerHTML = Assets.list.map(a => `
      <button type="button" data-asset="${a.key}" class="${a === active ? 'active' : ''}" aria-pressed="${a === active}">
        <b>${a.label}</b><small>${a.name}</small>
      </button>`).join('');
    document.getElementById('brand-asset').textContent = active.label;
    document.title = `Jejak Bandar ${active.label}`;
  }

  nav.addEventListener('click', e => {
    const btn = e.target.closest('button[data-asset]');
    if (btn) Assets.select(btn.dataset.asset);
  });

  window.Assets = Assets;
  renderNav();
})();
