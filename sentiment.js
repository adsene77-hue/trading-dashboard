/* =====================================================================
   Sentimen Institusi & Retail (CFTC, mingguan)
   - FX (EUR, GBP): laporan Traders in Financial Futures (TFF)
     → Asset Manager, Leveraged Funds, Dealer
   - Komoditas (Emas, WTI): laporan Disaggregated
     → Managed Money, Swap Dealer, Producer/Merchant
   - Retail: Non-reportable (trader kecil di bawah batas pelaporan CFTC)
   ===================================================================== */
(() => {
  const REPORTS = {
    tff: {
      endpoint: 'https://publicreporting.cftc.gov/resource/gpe5-46if.json',
      title: 'Traders in Financial Futures',
      groups: [
        { key: 'am', name: 'Asset Manager', desc: 'Dana pensiun, reksa dana, asuransi — posisi jangka panjang', long: 'asset_mgr_positions_long', short: 'asset_mgr_positions_short' },
        { key: 'lf', name: 'Leveraged Funds', desc: 'Hedge fund & CTA — spekulan besar', long: 'lev_money_positions_long', short: 'lev_money_positions_short', speculator: true },
        { key: 'dealer', name: 'Dealer / Bank', desc: 'Bank & dealer — umumnya sisi lawan (market maker)', long: 'dealer_positions_long_all', short: 'dealer_positions_short_all' }
      ]
    },
    disagg: {
      endpoint: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',
      title: 'Disaggregated',
      note: 'Laporan komoditas tidak memiliki kategori Asset Manager/Leveraged Funds; padanan spekulan besarnya adalah Managed Money.',
      groups: [
        { key: 'mm', name: 'Managed Money', desc: 'Hedge fund & CTA — spekulan besar', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all', speculator: true },
        { key: 'swap', name: 'Swap Dealer', desc: 'Bank swap dealer — lindung nilai klien', long: 'swap_positions_long_all', short: 'swap__positions_short_all' },
        { key: 'pm', name: 'Producer / Merchant', desc: 'Produsen & pengguna fisik — hedger komersial', long: 'prod_merc_positions_long', short: 'prod_merc_positions_short' }
      ]
    }
  };
  const RETAIL = { key: 'retail', name: 'Retail', desc: 'Non-reportable CFTC — trader kecil', long: 'nonrept_positions_long_all', short: 'nonrept_positions_short_all', retail: true };

  const $ = id => document.getElementById(id);
  const body = $('sent-body');
  let loadId = 0;

  const fmt = n => Math.abs(n).toLocaleString('id-ID');
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(n);
  const cls = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');

  async function fetchReport(asset) {
    const report = REPORTS[asset.cot.report];
    const groups = [...report.groups, RETAIL];
    const fields = ['report_date_as_yyyy_mm_dd', 'open_interest_all', ...groups.flatMap(g => [g.long, g.short])];
    const params = new URLSearchParams({
      cftc_contract_market_code: asset.cot.code,
      $order: 'report_date_as_yyyy_mm_dd DESC',
      $limit: 2,
      $select: fields.join(',')
    });
    const res = await fetch(`${report.endpoint}?${params}`);
    if (!res.ok) throw new Error(`CFTC API ${res.status}`);
    const [cur, prev] = await res.json();
    if (!cur) throw new Error('data tidak ditemukan');

    const rows = groups.map(g => {
      const long = Number(cur[g.long]);
      const short = Number(cur[g.short]);
      const net = long - short;
      const prevNet = prev ? Number(prev[g.long]) - Number(prev[g.short]) : net;
      return { ...g, long, short, net, change: net - prevNet, longPct: long + short ? long / (long + short) * 100 : 50 };
    });
    return { report, rows, date: cur.report_date_as_yyyy_mm_dd.slice(0, 10), oi: Number(cur.open_interest_all) };
  }

  function summary(rows, asset) {
    const spec = rows.find(r => r.speculator);
    const retail = rows.find(r => r.retail);
    const side = n => (n >= 0 ? 'Net Long' : 'Net Short');
    if (!spec || !retail) return '';
    const opposite = Math.sign(spec.net) !== Math.sign(retail.net);
    const text = opposite
      ? `${spec.name} <b class="${cls(spec.net)}">${side(spec.net)}</b>, Retail <b class="${cls(retail.net)}">${side(retail.net)}</b> — retail berlawanan dengan spekulan besar. Secara kontrarian, ini mendukung arah ${spec.name} pada ${asset.label}.`
      : `${spec.name} dan Retail sama-sama <b class="${cls(spec.net)}">${side(spec.net)}</b> — posisi mulai ramai (crowded); waspadai pembalikan bila momentum melemah.`;
    return `<div class="sent-summary ${opposite ? 'contra' : 'crowded'}">${text}</div>`;
  }

  function render(asset, data) {
    const maxAbs = Math.max(...data.rows.map(r => Math.abs(r.net)), 1);
    $('sent-sub').textContent = `${asset.cot.name} · ${data.report.title} · ${data.date}`;
    body.innerHTML = `
      ${summary(data.rows, asset)}
      <div class="sent-rows">
        ${data.rows.map(r => `
          <div class="sent-row${r.retail ? ' is-retail' : ''}">
            <div class="sent-name"><b>${r.name}</b><small>${r.desc}</small></div>
            <div class="sent-ratio">
              <div class="sent-bar" title="${r.longPct.toFixed(0)}% Long"><span style="width:${r.longPct.toFixed(1)}%"></span></div>
              <small><span class="up">L ${r.longPct.toFixed(0)}%</span><span class="down">S ${(100 - r.longPct).toFixed(0)}%</span></small>
            </div>
            <div class="sent-net">
              <div class="sent-net-bar ${cls(r.net)}"><span style="width:${(Math.abs(r.net) / maxAbs * 50).toFixed(1)}%"></span></div>
              <b class="mono ${cls(r.net)}">${signed(r.net)}</b>
              <small class="mono">Δ minggu ${signed(r.change)}</small>
            </div>
          </div>`).join('')}
      </div>
      <p class="report-note">${data.report.note ? data.report.note + ' ' : ''}Open interest ${fmt(data.oi)} kontrak. Data CFTC rilis tiap Jumat (posisi Selasa).</p>`;
  }

  async function load(asset) {
    const id = ++loadId;
    $('sent-title').textContent = `Sentimen Institusi & Retail — ${asset.label}`;
    $('sent-sub').textContent = `${asset.cot.name} · memuat…`;
    body.innerHTML = '<p class="report-empty">Memuat data CFTC…</p>';
    try {
      const data = await fetchReport(asset);
      if (id === loadId) render(asset, data);
    } catch (err) {
      if (id === loadId) body.innerHTML = `<p class="report-empty">Gagal memuat sentimen CFTC: ${err.message}</p>`;
    }
  }

  window.addEventListener('asset:change', e => load(e.detail));
  load(window.Assets.active);
})();
