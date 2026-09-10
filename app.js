(function () {
  'use strict';

  // ---- config -------------------------------------------------------
  // Admin login is checked server-side (functions/api/login.js) against
  // env vars set in Cloudflare Pages -- nothing secret lives in this file.
  const CONFIG = {
    DATA_URL: './data.json'
  };

  const COLOR_VARS = ['--series-1','--series-2','--series-3','--series-4','--series-5','--series-6','--series-7','--series-8'];

  // ---- state ----------------------------------------------------------
  const state = {
    trades: [],
    dailySummaries: [],
    rangeDays: null,        // null = all time
    sortCol: 'totalProfit',
    sortDir: 'desc',
    selectedAnalyst: null,
    colorMap: {},            // analyst -> css var
    adminUnlocked: false,
    pendingParsed: null      // { trades, dailySummaries } staged from paste, not yet merged
  };

  const root = document.documentElement;
  const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();

  function fmtMoney(n, opts) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const o = opts || {};
    const sign = n < 0 ? '-' : (o.plus ? '+' : '');
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 1 : digits) + '%';
  }
  function fmtNum(n) { return n === null || n === undefined || isNaN(n) ? '—' : n.toLocaleString('en-US'); }

  function buildColorMap(trades) {
    const names = Array.from(new Set(trades.map(t => t.analyst))).sort();
    const map = {};
    names.forEach((name, i) => { map[name] = COLOR_VARS[i % COLOR_VARS.length]; });
    return map;
  }

  function maxDate(trades) {
    let m = null;
    for (const t of trades) if (!m || t.date > m) m = t.date;
    return m;
  }

  function filteredTrades() {
    if (!state.rangeDays) return state.trades;
    // "last N days" = last N distinct days that actually have a posted recap,
    // not N calendar days -- the channel skips weekends/off days, so a
    // calendar cutoff would quietly shrink the window.
    const uniqueDates = Array.from(new Set(state.trades.map(t => t.date))).sort();
    const windowDates = new Set(uniqueDates.slice(-state.rangeDays));
    return state.trades.filter(t => windowDates.has(t.date));
  }

  // ---- rendering: filter bar -----------------------------------------
  function renderFilters() {
    const el = document.getElementById('filters');
    const options = [
      { label: 'Last 7d', v: 7 }, { label: 'Last 14d', v: 14 }, { label: 'Last 20d', v: 20 },
      { label: 'Last 30d', v: 30 }, { label: 'Last 60d', v: 60 }, { label: 'All time', v: null }
    ];
    el.innerHTML = '';
    options.forEach(opt => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (state.rangeDays === opt.v) b.classList.add('active');
      b.onclick = () => { state.rangeDays = opt.v; renderAll(); };
      el.appendChild(b);
    });
  }

  // ---- rendering: tiles -----------------------------------------------
  function renderTiles(stats) {
    const el = document.getElementById('tiles');
    if (!stats.length) { el.innerHTML = ''; return; }
    const mostProfitable = stats.slice().sort((a,b)=>b.totalProfit-a.totalProfit)[0];
    const bestWinRate = stats.filter(s=>s.trades>=10).sort((a,b)=>b.winRate-a.winRate)[0] || stats.slice().sort((a,b)=>b.winRate-a.winRate)[0];
    const totalTrades = stats.reduce((s,x)=>s+x.trades,0);
    const totalProfit = stats.reduce((s,x)=>s+x.totalProfit,0);
    const tiles = [
      { label: 'Most profitable', value: mostProfitable.analyst, sub: fmtMoney(mostProfitable.totalProfit) },
      { label: 'Best win rate (10+ trades)', value: bestWinRate.analyst, sub: bestWinRate.winRate.toFixed(1)+'%' },
      { label: 'Tracked calls', value: fmtNum(totalTrades), sub: stats.length + ' analysts' },
      { label: 'Combined profit', value: fmtMoney(totalProfit), sub: 'across everyone shown' }
    ];
    el.innerHTML = tiles.map(t => `
      <div class="tile">
        <div class="label">${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="hint" style="margin-top:2px">${t.sub}</div>
      </div>`).join('');
  }

  // ---- rendering: leaderboard table -----------------------------------
  const COLUMNS = [
    { key: 'analyst', label: 'Analyst' },
    { key: 'trades', label: 'Trades' },
    { key: 'winRate', label: 'Win Rate', tip: 'Wins ÷ total calls' },
    { key: 'profitFactor', label: 'Profit Factor', tip: 'Gross $ won ÷ gross $ lost. Above 1 = net profitable.' },
    { key: 'totalProfit', label: 'Total Profit' },
    { key: 'avgPerTrade', label: 'Avg $ / Trade', tip: 'Total profit ÷ priced trades — the blended expected outcome of one call, wins and losses combined.' },
    { key: 'maxLoss', label: 'Worst Loss' },
    { key: 'avgEntryCost', label: 'Avg Contract Cost', tip: 'Average entry price × 100 — roughly what one contract costs to open.' },
    { key: 'daysActive', label: 'Days Active' }
  ];

  function renderTable(stats) {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    thead.innerHTML = '<tr>' + COLUMNS.map(c => {
      const sorted = state.sortCol === c.key;
      const cls = sorted ? ('sorted ' + (state.sortDir === 'asc' ? 'asc' : '')) : '';
      const tip = c.tip ? ` title="${c.tip}"` : '';
      return `<th data-key="${c.key}" class="${cls}"${tip}>${c.label}</th>`;
    }).join('') + '</tr>';

    thead.querySelectorAll('th').forEach(th => {
      th.onclick = () => {
        const key = th.dataset.key;
        if (state.sortCol === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortCol = key; state.sortDir = 'desc'; }
        renderAll();
      };
    });

    const sorted = stats.slice().sort((a, b) => {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      const av = a[state.sortCol], bv = b[state.sortCol];
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir;
    });

    tbody.innerHTML = sorted.map(s => {
      const color = css(state.colorMap[s.analyst] || '--series-1');
      const selected = state.selectedAnalyst === s.analyst ? 'selected' : '';
      return `<tr class="${selected}" data-analyst="${s.analyst}">
        <td class="name-cell"><span class="dot" style="background:${color}"></span>${s.analyst}</td>
        <td>${fmtNum(s.trades)}</td>
        <td>${s.winRate.toFixed(1)}%</td>
        <td>${isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}</td>
        <td class="${s.totalProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.totalProfit)}</td>
        <td class="${s.avgPerTrade >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.avgPerTrade)}</td>
        <td class="neg">${s.maxLoss != null ? fmtMoney(s.maxLoss) : '—'}</td>
        <td class="muted-cell">${s.avgEntryCost != null ? fmtMoney(s.avgEntryCost) : '—'}</td>
        <td>${s.daysActive}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
      tr.onclick = () => {
        const a = tr.dataset.analyst;
        state.selectedAnalyst = state.selectedAnalyst === a ? null : a;
        renderAll();
      };
    });
  }

  // ---- rendering: bar chart (total profit by analyst) -----------------
  function renderBarChart(stats) {
    const wrap = document.getElementById('barChart');
    const sorted = stats.slice().sort((a,b)=>b.totalProfit-a.totalProfit);
    if (!sorted.length) { wrap.innerHTML = ''; return; }
    const w = wrap.clientWidth || 600;
    const rowH = 30, gap = 10, leftPad = 100, rightPad = 74, topPad = 6;
    const h = sorted.length * (rowH + gap) + topPad;
    const maxAbs = Math.max(1, ...sorted.map(s => Math.abs(s.totalProfit)));
    const plotW = w - leftPad - rightPad;

    const surface = css('--surface-1');
    let bars = '';
    let labels = '';
    sorted.forEach((s, i) => {
      const y = topPad + i * (rowH + gap);
      const color = css(state.colorMap[s.analyst] || '--series-1');
      const barW = Math.max(2, (Math.abs(s.totalProfit) / maxAbs) * plotW);
      const x = s.totalProfit >= 0 ? leftPad : leftPad - barW;
      bars += `<rect x="${x}" y="${y}" width="${barW}" height="${rowH}" rx="4" fill="${color}"></rect>`;
      // name label gets an opaque halo so it stays legible even if a
      // negative bar's left edge runs underneath it
      const haloW = s.analyst.length * 7.6 + 14;
      labels += `
        <rect x="${leftPad - 10 - haloW}" y="${y}" width="${haloW}" height="${rowH}" fill="${surface}"></rect>
        <text x="${leftPad - 10}" y="${y + rowH/2}" text-anchor="end" dominant-baseline="middle" font-weight="600" fill="${color}">${s.analyst}</text>
        <text x="${leftPad + Math.max(barW, 0) + 8}" y="${y + rowH/2}" dominant-baseline="middle" font-variant-numeric="tabular-nums">${fmtMoney(s.totalProfit, {plus:true})}</text>
      `;
    });

    wrap.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}">
      ${bars}
      <line class="axis-line" x1="${leftPad}" y1="0" x2="${leftPad}" y2="${h}"></line>
      ${labels}
    </svg>`;
  }

  // ---- rendering: cumulative profit line chart -------------------------
  let lineChartVisibility = {};

  function renderLineChart(trades, stats) {
    const wrap = document.getElementById('lineChart');
    const legendEl = document.getElementById('lineLegend');
    const tooltip = document.getElementById('lineTooltip');
    const analysts = stats.map(s => s.analyst);
    analysts.forEach(a => { if (!(a in lineChartVisibility)) lineChartVisibility[a] = true; });

    // build per-analyst cumulative series over sorted unique dates
    const dates = Array.from(new Set(trades.filter(t=>typeof t.dollar === 'number').map(t => t.date))).sort();
    if (!dates.length) { wrap.innerHTML = '<div class="hint">No priced trades in this range.</div>'; legendEl.innerHTML=''; return; }

    const series = {};
    analysts.forEach(a => {
      let running = 0;
      series[a] = dates.map(d => {
        const dayTrades = trades.filter(t => t.analyst === a && t.date === d && typeof t.dollar === 'number');
        dayTrades.forEach(t => running += t.dollar);
        return running;
      });
    });

    const w = wrap.clientWidth || 600, h = 320, padL = 56, padR = 16, padT = 14, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    let allVals = [0];
    analysts.forEach(a => { if (lineChartVisibility[a]) allVals = allVals.concat(series[a]); });
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const range = (maxV - minV) || 1;

    const xFor = (i) => padL + (dates.length === 1 ? plotW/2 : (i / (dates.length - 1)) * plotW);
    const yFor = (v) => padT + plotH - ((v - minV) / range) * plotH;

    let gridLines = '';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minV + (range * i / ticks);
      const y = yFor(v);
      gridLines += `<line class="grid-line" x1="${padL}" x2="${w-padR}" y1="${y}" y2="${y}"></line>
        <text x="${padL-8}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtMoney(v)}</text>`;
    }
    const zeroY = yFor(0);

    let paths = '';
    analysts.forEach(a => {
      if (!lineChartVisibility[a]) return;
      const color = css(state.colorMap[a] || '--series-1');
      const pts = series[a].map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
      paths += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" data-analyst="${a}"></polyline>`;
    });

    // sparse x-axis labels (start, middle, end)
    let xLabels = '';
    [0, Math.floor((dates.length-1)/2), dates.length-1].forEach(i => {
      if (i < 0 || i >= dates.length) return;
      xLabels += `<text x="${xFor(i)}" y="${h-8}" text-anchor="middle">${dates[i].slice(5)}</text>`;
    });

    wrap.innerHTML = `<svg id="lineSvg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible">
      ${gridLines}
      <line class="axis-line" x1="${padL}" x2="${w-padR}" y1="${zeroY}" y2="${zeroY}"></line>
      ${paths}
      ${xLabels}
      <rect id="hoverCatcher" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
      <line id="crosshair" class="grid-line" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" style="display:none;stroke-dasharray:3,3"></line>
    </svg>`;

    legendEl.innerHTML = analysts.map(a => {
      const color = css(state.colorMap[a] || '--series-1');
      const off = lineChartVisibility[a] ? '' : 'off';
      return `<span class="item ${off}" data-analyst="${a}"><span class="swatch" style="background:${color}"></span>${a}</span>`;
    }).join('');
    legendEl.querySelectorAll('.item').forEach(item => {
      item.onclick = () => {
        const a = item.dataset.analyst;
        lineChartVisibility[a] = !lineChartVisibility[a];
        renderLineChart(trades, stats);
      };
    });

    const svg = document.getElementById('lineSvg');
    const catcher = document.getElementById('hoverCatcher');
    const crosshair = document.getElementById('crosshair');
    catcher.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = w / rect.width;
      const mx = (e.clientX - rect.left) * scale;
      let idx = Math.round(((mx - padL) / plotW) * (dates.length - 1));
      idx = Math.max(0, Math.min(dates.length - 1, idx));
      const x = xFor(idx);
      crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
      crosshair.style.display = 'block';
      let lines = `<div style="margin-bottom:3px;font-weight:600">${dates[idx]}</div>`;
      analysts.filter(a => lineChartVisibility[a]).forEach(a => {
        lines += `<div>${a}: ${fmtMoney(series[a][idx])}</div>`;
      });
      tooltip.innerHTML = lines;
      tooltip.style.display = 'block';
      tooltip.style.left = ((x/scale)) + 'px';
      tooltip.style.top = (padT) + 'px';
    });
    catcher.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; crosshair.style.display = 'none'; });
  }

  // ---- rendering: detail panel -----------------------------------------
  function renderDetail(trades) {
    const panel = document.getElementById('detailPanel');
    if (!state.selectedAnalyst) { panel.classList.remove('open'); return; }
    panel.classList.add('open');
    const a = state.selectedAnalyst;
    const color = css(state.colorMap[a] || '--series-1');
    const rows = trades.filter(t => t.analyst === a).sort((x,y)=> y.date.localeCompare(x.date));
    document.getElementById('detailTitle').innerHTML = `<span class="dot" style="background:${color}"></span>${a} — ${rows.length} calls in range`;
    document.getElementById('detailBody').innerHTML = rows.map(t => `
      <tr>
        <td class="name-cell">${t.date}</td>
        <td>$${t.ticker}</td>
        <td class="${t.win ? 'pos' : 'neg'}">${t.win ? 'WIN' : 'LOSS'}</td>
        <td>${t.entry != null ? t.entry.toFixed(2) : '—'}</td>
        <td>${t.exit != null ? t.exit.toFixed(2) : '—'}</td>
        <td class="${t.pct >= 0 ? 'pos':'neg'}">${fmtPct(t.pct)}</td>
        <td class="${(t.dollar||0) >= 0 ? 'pos':'neg'}">${t.dollar != null ? fmtMoney(t.dollar) : '—'}</td>
      </tr>`).join('');
  }

  // ---- master render ---------------------------------------------------
  function renderAll() {
    const trades = filteredTrades();
    const stats = MordyParser.computeStats(trades);
    renderFilters();
    renderTiles(stats);
    renderTable(stats);
    renderBarChart(stats);
    renderLineChart(trades, stats);
    renderDetail(trades);
    const rangeLabel = state.rangeDays ? `last ${state.rangeDays} days` : 'all tracked days';
    document.getElementById('rangeNote').textContent = `Showing ${rangeLabel} · ${fmtNum(trades.length)} calls · updated through ${maxDate(state.trades) || '—'}`;
  }

  window.addEventListener('resize', () => { renderBarChart(MordyParser.computeStats(filteredTrades())); renderLineChart(filteredTrades(), MordyParser.computeStats(filteredTrades())); });

  // ---- data loading ------------------------------------------------------
  async function loadData() {
    try {
      const res = await fetch(CONFIG.DATA_URL, { cache: 'no-store' });
      const json = await res.json();
      state.trades = json.trades || [];
      state.dailySummaries = json.dailySummaries || [];
    } catch (e) {
      state.trades = [];
      state.dailySummaries = [];
      console.error('Failed to load data.json', e);
    }
    state.colorMap = buildColorMap(state.trades);
    renderAll();
  }

  // ---- admin: real server-checked login -----------------------------------
  async function checkSession() {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      const json = await res.json();
      return !!json.loggedIn;
    } catch (e) {
      return false;
    }
  }

  function wireAdminUI() {
    const openBtn = document.getElementById('adminOpenBtn');
    const gateModal = document.getElementById('adminGateModal');
    const gateClose = document.getElementById('gateCloseBtn');
    const gateUser = document.getElementById('gateUsername');
    const gateInput = document.getElementById('gatePassword');
    const gateSubmit = document.getElementById('gateSubmit');
    const gateError = document.getElementById('gateError');

    const adminModal = document.getElementById('adminModal');
    const adminClose = document.getElementById('adminCloseBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const pasteArea = document.getElementById('pasteArea');
    const parseBtn = document.getElementById('parseBtn');
    const parseMsg = document.getElementById('parseMsg');
    const previewList = document.getElementById('previewList');
    const mergeBtn = document.getElementById('mergeBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const dropZone = document.getElementById('dropZone');
    const dropZoneLabel = document.getElementById('dropZoneLabel');
    const fileInput = document.getElementById('fileInput');
    const browseLink = document.getElementById('browseLink');

    function loadFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        pasteArea.value = String(reader.result || '');
        dropZoneLabel.textContent = `Loaded "${file.name}" (${(file.size / 1024).toFixed(0)} KB) — click Parse below`;
        parseMsg.innerHTML = '';
      };
      reader.onerror = () => {
        parseMsg.innerHTML = '<div class="error-text">Could not read that file.</div>';
      };
      reader.readAsText(file);
    }

    browseLink.onclick = (e) => { e.preventDefault(); fileInput.click(); };
    fileInput.onchange = () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); };
    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    openBtn.onclick = async () => {
      if (state.adminUnlocked || (await checkSession())) {
        state.adminUnlocked = true;
        adminModal.classList.add('open');
      } else {
        gateModal.classList.add('open');
        gateUser.value = ''; gateInput.value = ''; gateError.textContent = '';
        gateUser.focus();
      }
    };
    gateClose.onclick = () => gateModal.classList.remove('open');
    adminClose.onclick = () => adminModal.classList.remove('open');

    async function submitLogin() {
      gateSubmit.disabled = true;
      gateError.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: gateUser.value, password: gateInput.value })
        });
        const json = await res.json();
        if (json.ok) {
          state.adminUnlocked = true;
          gateModal.classList.remove('open');
          adminModal.classList.add('open');
        } else {
          gateError.textContent = json.error || 'Login failed.';
        }
      } catch (e) {
        gateError.textContent = 'Could not reach the login API. Is this deployed on Cloudflare Pages with the functions/ folder, not plain GitHub Pages?';
      }
      gateSubmit.disabled = false;
    }
    gateSubmit.onclick = submitLogin;
    gateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
    gateUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

    logoutBtn.onclick = async () => {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
      state.adminUnlocked = false;
      adminModal.classList.remove('open');
    };

    parseBtn.onclick = () => {
      const raw = pasteArea.value.trim();
      if (!raw) { parseMsg.innerHTML = '<div class="error-text">Paste some recap text/HTML first.</div>'; return; }
      let result;
      try {
        result = MordyParser.parseRecapText(raw);
      } catch (e) {
        parseMsg.innerHTML = '<div class="error-text">Could not parse that: ' + e.message + '</div>';
        return;
      }
      const existingKeys = new Set(state.trades.map(MordyParser.dedupeKey));
      const newTrades = result.trades.filter(t => !existingKeys.has(MordyParser.dedupeKey(t)));
      const dupeCount = result.trades.length - newTrades.length;
      state.pendingParsed = { trades: newTrades, dailySummaries: result.dailySummaries };

      if (!newTrades.length) {
        parseMsg.innerHTML = `<div class="error-text">Found ${result.trades.length} call(s) but all already exist in the current data (0 new). Nothing to merge.</div>`;
        previewList.innerHTML = '';
        mergeBtn.disabled = true;
        return;
      }
      parseMsg.innerHTML = `<div class="ok-text">Found ${newTrades.length} new call(s)${dupeCount ? ' (' + dupeCount + ' already tracked, skipped)' : ''} across ${new Set(newTrades.map(t=>t.date)).size} day(s).</div>`;
      previewList.innerHTML = newTrades.slice(0, 200).map(t => `
        <div class="row">
          <span>${t.date} · ${t.analyst} · $${t.ticker}</span>
          <span class="${t.win?'pos':'neg'}">${t.win?'WIN':'LOSS'} ${t.dollar!=null?fmtMoney(t.dollar):''}</span>
        </div>`).join('');
      mergeBtn.disabled = false;
    };

    mergeBtn.onclick = () => {
      if (!state.pendingParsed || !state.pendingParsed.trades.length) return;
      state.trades = state.trades.concat(state.pendingParsed.trades);
      const existingDates = new Set(state.dailySummaries.map(d => d.date));
      state.pendingParsed.dailySummaries.forEach(d => {
        if (!existingDates.has(d.date)) state.dailySummaries.push(d);
      });
      state.colorMap = buildColorMap(state.trades);
      parseMsg.innerHTML = '<div class="ok-text">Merged into the live view below. Click "Publish to GitHub" to make it live for everyone (or download it and commit it yourself).</div>';
      mergeBtn.disabled = true;
      state.pendingParsed = null;
      renderAll();
    };

    downloadBtn.onclick = () => {
      const payload = JSON.stringify({ trades: state.trades, dailySummaries: state.dailySummaries }, null, 1);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'data.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const publishBtn = document.getElementById('publishBtn');
    const publishMsg = document.getElementById('publishMsg');
    publishBtn.onclick = async () => {
      publishBtn.disabled = true;
      publishBtn.textContent = 'Publishing…';
      publishMsg.innerHTML = '';
      try {
        const res = await fetch('/api/publish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trades: state.trades, dailySummaries: state.dailySummaries })
        });
        const json = await res.json();
        if (json.ok) {
          publishMsg.innerHTML = `<div class="ok-text">Published${json.commitUrl ? ' — <a href="' + json.commitUrl + '" target="_blank" rel="noopener">view commit</a>' : ''}. Cloudflare will redeploy in under a minute.</div>`;
        } else {
          publishMsg.innerHTML = `<div class="error-text">${json.error || 'Publish failed.'}</div>`;
        }
      } catch (e) {
        publishMsg.innerHTML = '<div class="error-text">Could not reach the publish API. Is GITHUB_TOKEN / GITHUB_REPO set on this Worker?</div>';
      }
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publish to GitHub';
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireAdminUI();
    loadData();
  });
})();
