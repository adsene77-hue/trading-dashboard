/* =====================================================================
   Filter Berita Berdampak Tinggi
   Jadwal dari salinan kalender Forex Factory di repo (data/calendar.json,
   diperbarui GitHub Actions tiap 6 jam). Entry diblokir mulai 2 jam
   sebelum hingga 1 jam sesudah rilis yang relevan untuk aset aktif.
   ===================================================================== */
(() => {
  const CALENDAR_URL = 'https://raw.githubusercontent.com/adsene77-hue/trading-dashboard/main/data/calendar.json';
  const REFRESH_MS = 30 * 60000;
  const BEFORE_MIN = 120;
  const AFTER_MIN = 60;
  const DAY = 24 * 3600e3;

  let events = null;
  let error = null;

  async function load() {
    try {
      const res = await fetch(CALENDAR_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      events = data.events
        .map(e => ({ title: e.title, currency: e.country, impact: e.impact, time: Date.parse(e.date), forecast: e.forecast, previous: e.previous }))
        .filter(e => Number.isFinite(e.time))
        .sort((a, b) => a.time - b.time);
      error = null;
    } catch (err) {
      error = err.message;
    }
    window.dispatchEvent(new CustomEvent('news:update'));
  }

  function relevant(asset) {
    return events.filter(e => asset.newsCurrencies.includes(e.currency) &&
      (e.impact === 'High' || (asset.newsTitles && asset.newsTitles.test(e.title))));
  }

  // state: 'blackout' (dilarang entry) | 'clear' | 'unknown' (jadwal tidak tersedia / kedaluwarsa)
  function status(asset = window.Assets.active, now = Date.now()) {
    if (!events) {
      return { state: 'unknown', reason: error ? `Jadwal berita gagal dimuat (${error})` : 'Memuat jadwal berita…' };
    }
    // Kalender hanya mencakup satu minggu; di luar rentang itu jadwalnya tidak bisa dipercaya
    if (!events.length || now < events[0].time - DAY || now > events[events.length - 1].time + DAY) {
      return { state: 'unknown', reason: 'Jadwal berita belum diperbarui untuk minggu ini' };
    }
    const list = relevant(asset);
    const active = list.filter(e => now >= e.time - BEFORE_MIN * 60000 && now <= e.time + AFTER_MIN * 60000);
    const upcoming = list.filter(e => e.time > now);
    const next = upcoming.length ? upcoming.filter(e => e.time === upcoming[0].time) : [];
    return { state: active.length ? 'blackout' : 'clear', active, next };
  }

  const fmtTime = ms => new Date(ms).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }) + ' WIB';

  function fmtIn(ms, now = Date.now()) {
    const min = Math.round((ms - now) / 60000);
    if (min <= 0) return `${-min} menit lalu`;
    if (min < 60) return `dalam ${min} menit`;
    const h = Math.floor(min / 60);
    if (h < 24) return `dalam ${h} jam ${min % 60} menit`;
    return `dalam ${Math.floor(h / 24)} hari ${h % 24} jam`;
  }

  // "USD Federal Funds Rate (+2 lain)"
  const describe = group => `${group[0].currency} ${group[0].title}${group.length > 1 ? ` (+${group.length - 1} lain)` : ''}`;

  window.NewsFilter = { status, fmtTime, fmtIn, describe, BEFORE_MIN, AFTER_MIN };
  load();
  setInterval(load, REFRESH_MS);
})();
