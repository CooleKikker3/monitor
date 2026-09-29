(() => {
  // Row layout from /api/history: [t, cpuAvg, cpuMax, memPct, memUsed, diskPct, diskUsed, swapPct]
  const F = { t: 0, cpu: 1, cpuMax: 2, memPct: 3, memUsed: 4, diskPct: 5, diskUsed: 6, swapPct: 7 };
  // Row layout from /api/projects/history: [t, cpuPct, memBytes, requestsPerMin, errorsPerMin]
  const PF = { t: 0, cpu: 1, mem: 2, req: 3, err: 4 };

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const RANGE_MS = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

  // ---------- Formatting ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const nf0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 });
  const fmtPct = (v) => (v == null ? '–' : nf1.format(v) + '%');
  const rtf = new Intl.RelativeTimeFormat('nl-NL', { numeric: 'auto' });
  const fmtTime = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const fmtDayTime = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
  const fmtDate = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtFull = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const MUTED = '<span class="muted">–</span>';

  function fmtBytes(b) {
    if (b == null) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return new Intl.NumberFormat('nl-NL', { maximumFractionDigits: i >= 3 ? 1 : 0 }).format(b) + ' ' + units[i];
  }

  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}u`;
    if (h) return `${h}u ${m}m`;
    return `${m}m`;
  }

  function ago(date) {
    const diff = (new Date(date).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return 'zojuist';
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  }

  // Big number with the decimals and unit set smaller: "24,3%" -> 24<small>,3%</small>
  function bigValue(text) {
    const m = /^([\d.]+)(.*)$/.exec(text);
    return m ? `${m[1]}<small>${esc(m[2])}</small>` : esc(text);
  }

  // ---------- Status ----------

  const ICONS = {
    good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.2l2 2 4-4.2"/></svg>',
    warning: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 1.8l6.5 12H1.5z" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.6v.1"/></svg>',
    critical: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>',
  };
  const LABELS = { good: 'Normaal', warning: 'Hoog', critical: 'Kritiek' };
  const levelFor = (pct) => (pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'good');
  const statusHtml = (level, text, title) =>
    `<span class="status ${level}"${title ? ` title="${esc(title)}"` : ''}>${ICONS[level]}${esc(text)}</span>`;

  function setTile(id, pct, value, detail) {
    const tile = document.getElementById(id);
    const level = levelFor(pct);
    $('.status', tile).outerHTML = statusHtml(level, LABELS[level]);
    $('.tile-value', tile).innerHTML = value;
    $('.tile-detail', tile).textContent = detail;
    $('.meter-fill', tile).style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function pctValue(pct) {
    if (pct == null) return '–';
    const [int, frac] = nf1.format(pct).split(',');
    return `${int}<small>,${frac}%</small>`;
  }

  // ---------- API ----------

  async function api(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function setLive(ok) {
    $('#live').classList.toggle('offline', !ok);
    $('#live-text').textContent = ok ? 'Live' : 'Geen verbinding';
  }

  // ---------- Chart factory ----------

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // Time ticks aligned to round local clock times
  const STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
  function timeTicks(min, max) {
    const step = STEPS.find((s) => (max - min) / s <= 7) || 7 * DAY;
    const offset = new Date(min).getTimezoneOffset() * MIN;
    const ticks = [];
    for (let t = Math.ceil((min - offset) / step) * step + offset; t <= max; t += step) ticks.push({ value: t });
    return ticks;
  }

  function timeTickLabel(v, i, ticks) {
    const step = ticks.length > 1 ? ticks[1].value - ticks[0].value : HOUR;
    if (step >= DAY) return fmtDay.format(v);
    if (RANGE_MS[currentRange] > DAY) return fmtDayTime.format(v);
    return fmtTime.format(v);
  }

  // Byte axes step in powers of two (16 MB, 32 MB, ...) instead of odd decimals
  function byteTicks(scale) {
    let step = 1024 * 1024;
    while (scale.max / step > 4) step *= 2;
    scale.ticks = [];
    for (let v = 0; v <= scale.max; v += step) scale.ticks.push({ value: v });
  }

  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = css('--axis');
      ctx.stroke();
      ctx.restore();
    },
  };

  /**
   * Line chart over time. `series` is [{ label, colorVar }]; one series gets a soft
   * area fill, several get plain lines and a color key in the tooltip.
   * `y` holds axis options: max, suggestedMax, stepSize, tick(v), bytes.
   * `label(item)` returns the tooltip line(s) for one point.
   */
  function timeChart(canvas, series, y, label) {
    const multi = series.length > 1;
    return new Chart(canvas, {
      type: 'line',
      data: {
        datasets: series.map((s) => {
          const color = css(s.colorVar);
          return {
            label: s.label,
            data: [],
            parsing: false,
            borderColor: color,
            backgroundColor: multi ? color : withAlpha(color, 0.12),
            fill: multi ? false : 'origin',
            borderWidth: 2,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: css('--surface'),
            pointHoverBackgroundColor: color,
            spanGaps: false,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 4 } },
        scales: {
          x: {
            type: 'linear',
            grid: { display: false },
            border: { color: css('--axis') },
            ticks: { color: css('--muted'), maxRotation: 0, autoSkip: false, callback: timeTickLabel },
            afterBuildTicks: (scale) => { scale.ticks = timeTicks(scale.min, scale.max); },
          },
          y: {
            min: 0,
            max: y.max,
            suggestedMax: y.suggestedMax,
            grid: { color: css('--grid') },
            border: { display: false },
            ticks: { color: css('--muted'), stepSize: y.stepSize, maxTicksLimit: 5, callback: y.tick },
            afterBuildTicks: y.bytes ? byteTicks : undefined,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: css('--surface'),
            titleColor: css('--text'),
            bodyColor: css('--text-2'),
            borderColor: css('--border'),
            borderWidth: 1,
            padding: 10,
            displayColors: multi,
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 4,
            filter: (item) => item.raw.y != null,
            itemSort: (a, b) => b.raw.y - a.raw.y,
            callbacks: {
              title: (items) => fmtFull.format(items[0].raw.x),
              label,
              labelColor: (item) => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor, borderRadius: 2 }),
            },
          },
        },
      },
      plugins: [crosshair],
    });
  }

  /** Sets the points of each dataset, the visible time window and the empty state. */
  function setChartData(chart, dataPerSeries) {
    const now = Date.now();
    let any = false;
    chart.data.datasets.forEach((ds, i) => {
      ds.data = dataPerSeries[i] || [];
      if (ds.data.some((p) => p.y != null)) any = true;
    });
    chart.options.scales.x.min = now - RANGE_MS[currentRange];
    chart.options.scales.x.max = now;
    chart.update('none');
    $('.empty', chart.canvas.parentElement).style.display = any ? 'none' : 'grid';
    return any;
  }

  function statsText(values, fmt, peakValues = values) {
    const vals = values.filter((v) => v != null);
    if (!vals.length) return '';
    const peak = Math.max(...peakValues.filter((v) => v != null));
    return `gem. ${fmt(vals.reduce((a, b) => a + b, 0) / vals.length)} · max ${fmt(peak)}`;
  }

  // ---------- Server ----------

  let intervalMs = 5000;
  let currentRange = '24h';
  let lastCurrent = null;

  async function loadCurrent() {
    try {
      const c = await api('/api/current');
      if (!c || !c.cpu) return;
      intervalMs = c.intervalMs || intervalMs;
      lastCurrent = c;
      setLive(true);

      $('#hostname').textContent = c.hostname;
      document.title = `${c.hostname} · Servermonitor`;
      $('#sysinfo').textContent = `${c.platform} · uptime ${fmtUptime(c.uptime)}`;

      setTile('tile-cpu', c.cpu.percent, pctValue(c.cpu.percent),
        `${c.cpu.cores} cores · load ${c.cpu.load.map((l) => l.toFixed(2)).join(' / ')}`);
      const swap = c.swap.total ? ` · swap ${fmtPct(c.swap.percent)}` : '';
      setTile('tile-mem', c.memory.percent, pctValue(c.memory.percent),
        `${fmtBytes(c.memory.used)} van ${fmtBytes(c.memory.total)}${swap}`);
      setTile('tile-disk', c.disk.percent, pctValue(c.disk.percent),
        `${fmtBytes(c.disk.used)} van ${fmtBytes(c.disk.total)} · ${fmtBytes(c.disk.free)} vrij`);

      $('#footer-info').textContent = `${c.cpu.model} · schijf ${c.disk.path} · laatste meting ${fmtTime.format(c.time)}`;
    } catch (err) {
      if (err.message !== 'unauthorized') setLive(false);
    }
  }

  const SERVER_CHARTS = {
    cpu: {
      canvas: 'chart-cpu', colorVar: '--series-cpu', field: F.cpu,
      label: (row, aggregated) => aggregated
        ? [`Gemiddeld ${fmtPct(row[F.cpu])}`, `Piek ${fmtPct(row[F.cpuMax])}`]
        : [`CPU ${fmtPct(row[F.cpu])}`],
    },
    mem: {
      canvas: 'chart-mem', colorVar: '--series-mem', field: F.memPct,
      label: (row) => [`RAM ${fmtPct(row[F.memPct])} (${fmtBytes(row[F.memUsed])})`, ...(row[F.swapPct] ? [`Swap ${fmtPct(row[F.swapPct])}`] : [])],
    },
    disk: {
      canvas: 'chart-disk', colorVar: '--series-disk', field: F.diskPct,
      label: (row) => [`Opslag ${fmtPct(row[F.diskPct])} (${fmtBytes(row[F.diskUsed])})`],
    },
  };
  const serverCharts = {};
  let lastHistory = null;

  function buildServerCharts() {
    for (const [key, def] of Object.entries(SERVER_CHARTS)) {
      if (serverCharts[key]) serverCharts[key].destroy();
      serverCharts[key] = timeChart(
        document.getElementById(def.canvas),
        [{ label: key, colorVar: def.colorVar }],
        { max: 100, stepSize: 25, tick: (v) => v + '%' },
        (item) => def.label(item.raw.row, lastHistory && lastHistory.bucketMs > intervalMs),
      );
    }
  }

  function renderServerHistory(history) {
    const points = history.points;
    for (const [key, def] of Object.entries(SERVER_CHARTS)) {
      setChartData(serverCharts[key], [points.map((row) => ({ x: row[F.t], y: row[def.field], row }))]);
      $('#stats-' + key).textContent = statsText(
        points.map((r) => r[def.field]), fmtPct,
        points.map((r) => r[key === 'cpu' ? F.cpuMax : def.field]),
      );
    }
  }

  async function loadHistory() {
    try {
      const range = currentRange;
      const history = await api('/api/history?range=' + range);
      if (range !== currentRange) return;
      lastHistory = history;
      renderServerHistory(history);
    } catch {
      // Status indicator is driven by loadCurrent
    }
  }

  // ---------- Projects: shared ----------

  let projects = [];
  let projectOrder = [];

  // Color follows the project (its position in projects.json), never its rank
  const colorVarFor = (name) => {
    const i = projectOrder.indexOf(name);
    return i >= 0 && i < 8 ? '--cat-' + (i + 1) : '--muted';
  };
  const projectByName = (name) => projects.find((p) => p.name === name);

  function healthStatus(p) {
    const h = p.health;
    if (!p.domain) return { html: MUTED, detail: '' };
    if (!h) return { html: '<span class="muted">Wordt gecontroleerd…</span>', detail: '' };
    if (h.ok) return { html: statusHtml('good', 'Online'), detail: `${h.status} · ${nf0.format(h.ms)} ms` };
    return { html: statusHtml('critical', 'Offline'), detail: String(h.status || h.error || 'Geen antwoord') };
  }

  function autoRenewHtml(cert) {
    const a = cert && cert.autoRenew;
    if (!a || a.state === 'unknown') return `<span class="muted"${a && a.reason ? ` title="${esc(a.reason)}"` : ''}>Auto-renew onbekend</span>`;
    if (a.state === 'on') return statusHtml('good', 'Auto-renew');
    return statusHtml('critical', 'Geen auto-renew', a.reason);
  }

  function certDays(cert) {
    if (!cert.trusted) return statusHtml('critical', 'Ongeldig');
    if (cert.daysLeft < 7) return statusHtml('critical', `Nog ${cert.daysLeft} dagen`);
    if (cert.daysLeft < 14) return statusHtml('warning', `Nog ${cert.daysLeft} dagen`);
    return `Nog ${cert.daysLeft} dagen`;
  }

  // ---------- Tabs and routing ----------

  // #/ is the overview, #/project/<name> a single project
  function routeProject() {
    const m = /^#\/project\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function renderTabs() {
    const active = routeProject();
    const tab = (href, label, selected, extra = '') =>
      `<a href="${href}" role="tab" aria-selected="${selected}"${selected ? ' aria-current="page"' : ''}>${extra}${esc(label)}</a>`;
    $('#tabs').innerHTML = tab('#/', 'Overzicht', !active) + projects.map((p) => {
      const down = p.health && !p.health.ok;
      const mark = down
        ? `<span class="tab-alert" title="Offline">${ICONS.critical}</span>`
        : `<span class="swatch" style="background:var(${colorVarFor(p.name)})"></span>`;
      return tab('#/project/' + encodeURIComponent(p.name), p.label, active === p.name, mark);
    }).join('');
  }

  function showView() {
    const name = routeProject();
    const project = name && projectByName(name);
    // Unknown project (renamed or removed): fall back to the overview
    if (name && projects.length && !project) {
      location.hash = '#/';
      return;
    }
    $('#view-overview').hidden = !!project;
    $('#view-project').hidden = !project;
    renderTabs();
    if (project) {
      buildProjectView(project);
      window.scrollTo(0, 0);
    }
  }

  window.addEventListener('hashchange', showView);

  // ---------- Overview: project table and comparison charts ----------

  function renderProjectTable() {
    $('#projects-body').innerHTML = projects.map((p) => {
      const health = healthStatus(p);
      const errors = p.errors1h == null ? MUTED : p.errors1h > 0 ? statusHtml('warning', nf0.format(p.errors1h)) : '0';
      const git = p.git
        ? `<div class="commit" title="${esc(p.git.subject)}">${esc(p.git.subject)}</div><div class="sub">${esc(p.git.hash)} · ${esc(ago(p.git.date))}</div>`
        : MUTED;
      const cert = !p.domain ? MUTED : !p.cert ? '<span class="muted">Onbekend</span>'
        : `${certDays(p.cert)}<div class="sub">${autoRenewHtml(p.cert)}</div>`;
      return `<tr>
        <td>
          <a class="name" href="#/project/${encodeURIComponent(p.name)}"><span class="swatch" style="background:var(${colorVarFor(p.name)})"></span>${esc(p.label)}</a>
          <div class="sub"><span class="badge">${esc(p.type)}</span>${p.domain ? ` ${esc(p.domain)}` : ''}</div>
        </td>
        <td>${health.html}${health.detail ? `<div class="sub">${esc(health.detail)}</div>` : ''}</td>
        <td class="num">${p.cpu == null ? MUTED : nf2.format(p.cpu) + '%'}</td>
        <td class="num">${p.mem == null ? MUTED : fmtBytes(p.mem)}</td>
        <td class="num">${p.requestsPerMin == null ? MUTED : nf0.format(p.requestsPerMin)}</td>
        <td class="num">${errors}</td>
        <td class="num">${p.disk && p.disk.bytes != null ? fmtBytes(p.disk.bytes) : MUTED}</td>
        <td>${cert}</td>
        <td>${git}</td>
      </tr>`;
    }).join('');
  }

  const PROJECT_METRICS = {
    cpu: { field: PF.cpu, y: { suggestedMax: 5, tick: (v) => nf2.format(v) + '%' }, value: (v) => nf2.format(v) + '%' },
    mem: { field: PF.mem, y: { suggestedMax: 64 * 1024 * 1024, bytes: true, tick: fmtBytes }, value: fmtBytes },
    req: { field: PF.req, y: { suggestedMax: 10, tick: (v) => nf0.format(v) }, value: (v) => nf1.format(v) + '/min' },
    err: { field: PF.err, y: { suggestedMax: 1, tick: (v) => nf1.format(v) }, value: (v) => nf2.format(v) + '/min' },
  };
  const COMPARE = ['cpu', 'mem', 'req'];
  const compareCharts = {};
  let lastProjectHistory = null;

  function buildCompareCharts() {
    const series = projects.map((p) => ({ label: p.label, colorVar: colorVarFor(p.name) }));
    for (const key of COMPARE) {
      const def = PROJECT_METRICS[key];
      const canvas = document.getElementById('compare-' + key);
      if (compareCharts[key]) compareCharts[key].destroy();
      $('.legend', canvas.closest('.chart-card')).innerHTML = series.length > 1
        ? series.map((s) => `<span><span class="swatch" style="background:var(${s.colorVar})"></span>${esc(s.label)}</span>`).join('')
        : '';
      compareCharts[key] = timeChart(canvas, series, def.y, (item) => `${item.dataset.label}: ${def.value(item.raw.y)}`);
    }
  }

  /** Aligns all projects on one set of timestamps so the index tooltip lines up. */
  function alignProjects(list) {
    const times = [...new Set(list.flatMap((p) => p.points.map((r) => r[PF.t])))].sort((a, b) => a - b);
    const byName = new Map(list.map((p) => [p.name, new Map(p.points.map((r) => [r[PF.t], r]))]));
    return (name, field) => {
      const rows = byName.get(name) || new Map();
      return times.map((t) => {
        const r = rows.get(t);
        return { x: t, y: r ? r[field] : null };
      });
    };
  }

  function renderCompareHistory(list) {
    const series = alignProjects(list);
    for (const key of COMPARE) {
      if (!compareCharts[key]) continue;
      setChartData(compareCharts[key], projectOrder.map((name) => series(name, PROJECT_METRICS[key].field)));
    }
  }

  // ---------- Project view ----------

  const projectCharts = {};
  let shownProject = null;

  function tile(label, valueHtml, detailHtml, statusHtmlStr = '') {
    return `<article class="card tile compact">
      <div class="tile-head"><span class="tile-label">${esc(label)}</span>${statusHtmlStr}</div>
      <div class="tile-value">${valueHtml}</div>
      <div class="tile-detail">${detailHtml}</div>
    </article>`;
  }

  function renderProjectTiles(p) {
    $('#p-title').innerHTML = `<span class="swatch" style="background:var(${colorVarFor(p.name)})"></span>${esc(p.label)} <span class="badge">${esc(p.type)}</span>`;
    $('#p-sub').innerHTML = [
      p.domain ? `<a href="https://${esc(p.domain)}" target="_blank" rel="noopener">${esc(p.domain)}</a>` : '',
      p.dir ? esc(p.dir) : '',
    ].filter(Boolean).join(' · ');

    const health = healthStatus(p);
    const h = p.health;
    const memShare = p.mem != null && lastCurrent ? ` · ${nf1.format((p.mem / lastCurrent.memory.total) * 100)}% van het RAM` : '';
    const cores = lastCurrent ? `${lastCurrent.cpu.cores} cores` : 'alle cores';

    const tiles = [
      tile('Status',
        !p.domain ? '–' : !h ? '<span class="muted">…</span>' : h.ok ? 'Online' : 'Offline',
        [health.detail, h ? 'gecontroleerd ' + ago(h.checkedAt) : ''].filter(Boolean).map(esc).join(' · '),
        p.domain && h ? (h.ok ? statusHtml('good', 'OK') : statusHtml('critical', 'Storing')) : ''),
      tile('CPU', p.cpu == null ? '–' : bigValue(nf2.format(p.cpu) + '%'), esc(`van de hele server (${cores})`)),
      tile('RAM', p.mem == null ? '–' : bigValue(fmtBytes(p.mem)), esc(p.mem == null ? '' : 'eigen geheugen' + memShare)),
      tile('Verzoeken', p.requestsPerMin == null ? '–' : bigValue(nf0.format(p.requestsPerMin) + '/min'),
        esc(p.requests1h == null ? 'access-log niet leesbaar' : `${nf0.format(p.requests1h)} in het afgelopen uur`)),
      tile('5xx-fouten', p.errors1h == null ? '–' : bigValue(nf0.format(p.errors1h)), 'in het afgelopen uur',
        p.errors1h > 0 ? statusHtml('warning', 'Let op') : ''),
      tile('Opslag', p.disk && p.disk.bytes != null ? bigValue(fmtBytes(p.disk.bytes)) : '–',
        esc(p.disk ? 'gemeten ' + ago(p.disk.checkedAt) : 'wordt gemeten…')),
      tile('Certificaat',
        !p.cert ? '–' : bigValue(`${p.cert.daysLeft} dagen`),
        !p.cert ? esc(p.domain ? 'onbekend' : 'geen domein') : `geldig tot ${esc(fmtDate.format(p.cert.validTo))}<div class="tile-line">${autoRenewHtml(p.cert)}</div>`,
        p.cert && (!p.cert.trusted || p.cert.daysLeft < 14) ? statusHtml(p.cert.daysLeft < 7 || !p.cert.trusted ? 'critical' : 'warning', p.cert.trusted ? 'Verloopt' : 'Ongeldig') : ''),
      tile('Laatste versie',
        p.git ? `<span class="commit-title" title="${esc(p.git.subject)}">${esc(p.git.subject)}</span>` : '–',
        p.git ? `${esc(p.git.hash)} · ${esc(ago(p.git.date))}` : ''),
    ];
    $('#p-tiles').innerHTML = tiles.join('');
  }

  function buildProjectView(p) {
    shownProject = p.name;
    renderProjectTiles(p);
    const series = [{ label: p.label, colorVar: colorVarFor(p.name) }];
    for (const [key, def] of Object.entries(PROJECT_METRICS)) {
      if (projectCharts[key]) projectCharts[key].destroy();
      projectCharts[key] = timeChart(document.getElementById('p-chart-' + key), series, def.y, (item) => def.value(item.raw.y));
    }
    if (lastProjectHistory) renderProjectHistory(lastProjectHistory);
  }

  function renderProjectHistory(list) {
    const entry = list.find((x) => x.name === shownProject);
    if (!entry || !projectCharts.cpu) return;
    for (const [key, def] of Object.entries(PROJECT_METRICS)) {
      const values = entry.points.map((r) => r[def.field]);
      setChartData(projectCharts[key], [entry.points.map((r) => ({ x: r[PF.t], y: r[def.field] }))]);
      $('#p-stats-' + key).textContent = statsText(values, def.value);
    }
  }

  // ---------- Project loading ----------

  async function loadProjects() {
    try {
      const data = await api('/api/projects');
      const has = data.projects.length > 0;
      $('#tabs').hidden = !has;
      $('#projects-section').hidden = !has;
      $('#compare-charts').hidden = !has;
      $('#server-title').hidden = !has;

      const orderChanged = data.projects.map((p) => p.name).join() !== projectOrder.join();
      projects = data.projects;
      projectOrder = projects.map((p) => p.name);

      if (orderChanged) {
        if (has) buildCompareCharts();
        if (lastProjectHistory) renderCompareHistory(lastProjectHistory);
        showView();
      } else {
        renderTabs();
      }
      renderProjectTable();
      const shown = routeProject() && projectByName(routeProject());
      if (shown) renderProjectTiles(shown);
    } catch {
      // Status indicator is driven by loadCurrent
    }
  }

  async function loadProjectHistory() {
    if (!projectOrder.length) return;
    try {
      const range = currentRange;
      const { projects: list } = await api('/api/projects/history?range=' + range);
      if (range !== currentRange) return;
      lastProjectHistory = list;
      renderCompareHistory(list);
      renderProjectHistory(list);
    } catch {
      // Status indicator is driven by loadCurrent
    }
  }

  // ---------- Range selector ----------

  function selectRange(range) {
    if (!RANGE_MS[range]) range = '24h';
    currentRange = range;
    document.querySelectorAll('.ranges button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.range === range));
    });
    try { localStorage.setItem('monitor-range', range); } catch {}
    lastHistory = null;
    lastProjectHistory = null;
    refreshHistory();
    scheduleHistory();
  }

  function refreshHistory() {
    loadHistory();
    loadProjectHistory();
  }

  let historyTimer;
  function scheduleHistory() {
    clearInterval(historyTimer);
    const every = currentRange === '1h' ? intervalMs : currentRange === '6h' ? 30 * 1000 : 60 * 1000;
    historyTimer = setInterval(refreshHistory, every);
  }

  document.querySelectorAll('.ranges button').forEach((b) => {
    b.addEventListener('click', () => selectRange(b.dataset.range));
  });

  // Rebuild charts with the other palette when the OS theme flips
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    buildServerCharts();
    if (lastHistory) renderServerHistory(lastHistory);
    if (projects.length) buildCompareCharts();
    const shown = routeProject() && projectByName(routeProject());
    if (shown) buildProjectView(shown);
    if (lastProjectHistory) renderCompareHistory(lastProjectHistory);
  });

  // ---------- Start ----------

  let saved = null;
  try { saved = localStorage.getItem('monitor-range'); } catch {}

  buildServerCharts();
  Promise.all([loadCurrent(), loadProjects()]).then(() => {
    setInterval(loadCurrent, intervalMs);
    setInterval(loadProjects, intervalMs);
    selectRange(saved || '24h');
  });
})();
