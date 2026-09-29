(() => {
  // Row layout from /api/history: [t, cpuAvg, cpuMax, memPct, memUsed, diskPct, diskUsed, swapPct]
  const F = { t: 0, cpu: 1, cpuMax: 2, memPct: 3, memUsed: 4, diskPct: 5, diskUsed: 6, swapPct: 7 };
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const RANGE_MS = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

  const $ = (sel, root = document) => root.querySelector(sel);
  const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const fmtPct = (v) => (v == null ? '–' : nf1.format(v) + '%');

  function fmtBytes(b) {
    if (!b && b !== 0) return '–';
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

  const fmtTime = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const fmtDayTime = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
  const fmtFull = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---------- Status ----------

  const ICONS = {
    good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.2l2 2 4-4.2"/></svg>',
    warning: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 1.8l6.5 12H1.5z" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.6v.1"/></svg>',
    critical: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>',
  };
  const LABELS = { good: 'Normaal', warning: 'Hoog', critical: 'Kritiek' };
  const levelFor = (pct) => (pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'good');

  function setTile(id, pct, value, detail) {
    const tile = document.getElementById(id);
    const level = levelFor(pct);
    const status = $('.status', tile);
    status.className = 'status ' + level;
    status.innerHTML = ICONS[level] + LABELS[level];
    $('.tile-value', tile).innerHTML = value;
    $('.tile-detail', tile).textContent = detail;
    $('.meter-fill', tile).style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function valueHtml(pct) {
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

  let intervalMs = 5000;

  async function loadCurrent() {
    try {
      const c = await api('/api/current');
      if (!c || !c.cpu) return;
      intervalMs = c.intervalMs || intervalMs;
      setLive(true);

      $('#hostname').textContent = c.hostname;
      document.title = `${c.hostname} · Servermonitor`;
      $('#sysinfo').textContent = `${c.platform} · uptime ${fmtUptime(c.uptime)}`;

      setTile('tile-cpu', c.cpu.percent, valueHtml(c.cpu.percent),
        `${c.cpu.cores} cores · load ${c.cpu.load.map((l) => l.toFixed(2)).join(' / ')}`);
      const swap = c.swap.total ? ` · swap ${fmtPct(c.swap.percent)}` : '';
      setTile('tile-mem', c.memory.percent, valueHtml(c.memory.percent),
        `${fmtBytes(c.memory.used)} van ${fmtBytes(c.memory.total)}${swap}`);
      setTile('tile-disk', c.disk.percent, valueHtml(c.disk.percent),
        `${fmtBytes(c.disk.used)} van ${fmtBytes(c.disk.total)} · ${fmtBytes(c.disk.free)} vrij`);

      $('#footer-info').textContent = `${c.cpu.model} · schijf ${c.disk.path} · laatste meting ${fmtTime.format(c.time)}`;
    } catch (err) {
      if (err.message !== 'unauthorized') setLive(false);
    }
  }

  // ---------- Charts ----------

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // Time ticks aligned to round local clock times
  const STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
  function timeTicks(min, max) {
    const span = max - min;
    const step = STEPS.find((s) => span / s <= 7) || 7 * DAY;
    const offset = new Date(min).getTimezoneOffset() * MIN;
    const ticks = [];
    for (let t = Math.ceil((min - offset) / step) * step + offset; t <= max; t += step) ticks.push({ value: t });
    return { ticks, step };
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

  const CHARTS = {
    cpu: {
      canvas: 'chart-cpu', color: '--series-cpu', field: F.cpu,
      tooltip: (row, aggregated) => aggregated
        ? [`Gemiddeld ${fmtPct(row[F.cpu])}`, `Piek ${fmtPct(row[F.cpuMax])}`]
        : [`CPU ${fmtPct(row[F.cpu])}`],
    },
    mem: {
      canvas: 'chart-mem', color: '--series-mem', field: F.memPct,
      tooltip: (row) => [`RAM ${fmtPct(row[F.memPct])} (${fmtBytes(row[F.memUsed])})`, ...(row[F.swapPct] ? [`Swap ${fmtPct(row[F.swapPct])}`] : [])],
    },
    disk: {
      canvas: 'chart-disk', color: '--series-disk', field: F.diskPct,
      tooltip: (row) => [`Opslag ${fmtPct(row[F.diskPct])} (${fmtBytes(row[F.diskUsed])})`],
    },
  };

  let currentRange = '24h';
  let lastHistory = null;
  const charts = {};

  function buildChart(key) {
    const def = CHARTS[key];
    const color = css(def.color);
    const ctx = document.getElementById(def.canvas);
    if (charts[key]) charts[key].destroy();

    charts[key] = new Chart(ctx, {
      type: 'line',
      data: { datasets: [{
        data: [],
        parsing: false,
        borderColor: color,
        backgroundColor: withAlpha(color, 0.12),
        borderWidth: 2,
        fill: 'origin',
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: css('--surface'),
        pointHoverBackgroundColor: color,
        spanGaps: false,
      }] },
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
            ticks: {
              color: css('--muted'),
              maxRotation: 0,
              autoSkip: false,
              callback: (v, i, ticks) => {
                const step = ticks.length > 1 ? ticks[1].value - ticks[0].value : HOUR;
                if (step >= DAY) return fmtDay.format(v);
                if (RANGE_MS[currentRange] > DAY) return fmtDayTime.format(v);
                return fmtTime.format(v);
              },
            },
            afterBuildTicks: (scale) => { scale.ticks = timeTicks(scale.min, scale.max).ticks; },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: css('--grid') },
            border: { display: false },
            ticks: { color: css('--muted'), stepSize: 25, callback: (v) => v + '%' },
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
            displayColors: false,
            callbacks: {
              title: (items) => fmtFull.format(items[0].raw.x),
              label: (item) => def.tooltip(item.raw.row, lastHistory && lastHistory.bucketMs > intervalMs),
            },
          },
        },
      },
      plugins: [crosshair],
    });
  }

  function buildAll() {
    Object.keys(CHARTS).forEach(buildChart);
    if (lastHistory) render(lastHistory);
  }

  function render(history) {
    const now = Date.now();
    const min = now - RANGE_MS[currentRange];
    const points = history.points;

    for (const [key, def] of Object.entries(CHARTS)) {
      const chart = charts[key];
      chart.data.datasets[0].data = points.map((row) => ({ x: row[F.t], y: row[def.field], row }));
      chart.options.scales.x.min = min;
      chart.options.scales.x.max = now;
      chart.update('none');

      const values = points.map((r) => r[def.field]).filter((v) => v != null);
      const box = chart.canvas.parentElement;
      $('.empty', box).style.display = values.length ? 'none' : 'grid';

      const stats = document.getElementById('stats-' + key);
      if (values.length) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const peakField = key === 'cpu' ? F.cpuMax : def.field;
        const peak = Math.max(...points.map((r) => r[peakField]).filter((v) => v != null));
        stats.textContent = `gem. ${fmtPct(avg)} · max ${fmtPct(peak)}`;
      } else {
        stats.textContent = '';
      }
    }
  }

  async function loadHistory() {
    try {
      const range = currentRange;
      const history = await api('/api/history?range=' + range);
      if (range !== currentRange) return;
      lastHistory = history;
      render(history);
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
    loadHistory();
    scheduleHistory();
  }

  let historyTimer;
  function scheduleHistory() {
    clearInterval(historyTimer);
    const every = currentRange === '1h' ? intervalMs : currentRange === '6h' ? 30 * 1000 : 60 * 1000;
    historyTimer = setInterval(loadHistory, every);
  }

  document.querySelectorAll('.ranges button').forEach((b) => {
    b.addEventListener('click', () => selectRange(b.dataset.range));
  });

  // Rebuild charts with the other palette when the OS theme flips
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', buildAll);

  // ---------- Start ----------

  let saved = null;
  try { saved = localStorage.getItem('monitor-range'); } catch {}

  buildAll();
  loadCurrent().then(() => {
    setInterval(loadCurrent, intervalMs);
    selectRange(saved || '24h');
  });
})();
