const fs = require('fs');
const os = require('os');
const path = require('path');

const MINUTE = 60 * 1000;

// Row layout for stored samples (compact arrays keep the history file small):
// [timestamp, cpuAvg, cpuMax, memPct, memUsed, diskPct, diskUsed, swapPct]
const F = { t: 0, cpu: 1, cpuMax: 2, memPct: 3, memUsed: 4, diskPct: 5, diskUsed: 6, swapPct: 7 };

function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readMemory() {
  // /proc/meminfo gives MemAvailable, which reflects real usage (excludes cache)
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kb[m[1]] = Number(m[2]) * 1024;
    }
    const total = kb.MemTotal;
    const available = kb.MemAvailable ?? kb.MemFree + (kb.Cached || 0) + (kb.Buffers || 0);
    return {
      total,
      used: total - available,
      swapTotal: kb.SwapTotal || 0,
      swapUsed: (kb.SwapTotal || 0) - (kb.SwapFree || 0),
    };
  } catch {
    const total = os.totalmem();
    return { total, used: total - os.freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

function readDisk(diskPath) {
  try {
    const s = fs.statfsSync(diskPath);
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    // Same formula as `df`: reserved blocks are excluded from the percentage base
    const pct = used + avail > 0 ? (used / (used + avail)) * 100 : 0;
    return { total, used, free: avail, pct };
  } catch {
    return { total: 0, used: 0, free: 0, pct: 0 };
  }
}

class Collector {
  constructor({ dataDir, intervalSec = 5, retentionDays = 30, diskPath = '/' }) {
    this.file = path.join(dataDir, 'history.json');
    this.dataDir = dataDir;
    this.intervalMs = Math.max(1, intervalSec) * 1000;
    this.retentionMs = retentionDays * 24 * 60 * MINUTE;
    this.diskPath = diskPath;

    this.recent = []; // raw samples, last hour
    this.minutes = []; // per-minute aggregates, up to retention
    this.bucket = null; // minute currently being aggregated
    this.current = null;
    this.prevCpu = cpuTimes();
    this.dirty = false;

    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data.minutes)) this.minutes = data.minutes;
      this.prune();
    } catch {
      // No history yet
    }
  }

  save() {
    if (!this.dirty) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, minutes: this.minutes }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  prune() {
    const cutoff = Date.now() - this.retentionMs;
    let i = 0;
    while (i < this.minutes.length && this.minutes[i][F.t] < cutoff) i++;
    if (i) this.minutes.splice(0, i);
    const recentCutoff = Date.now() - 60 * MINUTE;
    i = 0;
    while (i < this.recent.length && this.recent[i][F.t] < recentCutoff) i++;
    if (i) this.recent.splice(0, i);
  }

  sample() {
    const now = Date.now();
    const cpuNow = cpuTimes();
    const dTotal = cpuNow.total - this.prevCpu.total;
    const dIdle = cpuNow.idle - this.prevCpu.idle;
    this.prevCpu = cpuNow;
    const cpu = dTotal > 0 ? Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) : 0;

    const mem = readMemory();
    const disk = readDisk(this.diskPath);
    const memPct = mem.total ? (mem.used / mem.total) * 100 : 0;
    const swapPct = mem.swapTotal ? (mem.swapUsed / mem.swapTotal) * 100 : 0;

    const cpus = os.cpus();
    this.current = {
      time: now,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptime: os.uptime(),
      cpu: {
        percent: round(cpu),
        cores: cpus.length,
        model: cpus[0] ? cpus[0].model.trim() : '',
        load: os.loadavg().map((l) => round(l, 2)),
      },
      memory: { total: mem.total, used: mem.used, percent: round(memPct) },
      swap: { total: mem.swapTotal, used: mem.swapUsed, percent: round(swapPct) },
      disk: { path: this.diskPath, total: disk.total, used: disk.used, free: disk.free, percent: round(disk.pct) },
    };

    const row = [now, round(cpu), round(cpu), round(memPct), mem.used, round(disk.pct), disk.used, round(swapPct)];
    this.recent.push(row);
    this.addToMinute(row);
    this.prune();
  }

  addToMinute(row) {
    const minuteStart = Math.floor(row[F.t] / MINUTE) * MINUTE;
    if (this.bucket && this.bucket.start !== minuteStart) this.flushMinute();
    if (!this.bucket) this.bucket = { start: minuteStart, rows: [] };
    this.bucket.rows.push(row);
  }

  flushMinute() {
    const b = this.bucket;
    this.bucket = null;
    if (!b || !b.rows.length) return;
    this.minutes.push(aggregate(b.rows, b.start));
    this.dirty = true;
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.saveTimer = setInterval(() => this.trySave(), MINUTE);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    this.flushMinute();
    this.trySave();
  }

  trySave() {
    try {
      this.save();
    } catch (err) {
      console.error('Kon historie niet opslaan:', err.message);
    }
  }

  /** Returns history for a time range, downsampled to at most ~400 points. */
  history(rangeMs) {
    const now = Date.now();
    const from = now - rangeMs;

    if (rangeMs <= 60 * MINUTE) {
      return { bucketMs: this.intervalMs, points: withGaps(this.recent.filter((r) => r[F.t] >= from), this.intervalMs) };
    }

    const source = this.minutes.filter((r) => r[F.t] >= from);
    // Include the minute in progress so the chart reaches "now"
    if (this.bucket && this.bucket.rows.length) source.push(aggregate(this.bucket.rows, this.bucket.start));

    const bucketMs = Math.max(MINUTE, Math.ceil(rangeMs / 400 / MINUTE) * MINUTE);
    if (bucketMs === MINUTE) return { bucketMs, points: withGaps(source, bucketMs) };

    const groups = new Map();
    for (const r of source) {
      const key = Math.floor(r[F.t] / bucketMs) * bucketMs;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const points = [...groups.entries()].map(([start, rows]) => aggregate(rows, start));
    return { bucketMs, points: withGaps(points, bucketMs) };
  }
}

function aggregate(rows, start) {
  const avg = (i) => rows.reduce((s, r) => s + r[i], 0) / rows.length;
  const max = (i) => rows.reduce((m, r) => Math.max(m, r[i]), 0);
  return [
    start,
    round(avg(F.cpu)),
    round(max(F.cpuMax)),
    round(avg(F.memPct)),
    Math.round(avg(F.memUsed)),
    round(avg(F.diskPct)),
    Math.round(avg(F.diskUsed)),
    round(avg(F.swapPct)),
  ];
}

// Insert a null row where data is missing (server was down) so lines break there
function withGaps(rows, stepMs) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i][F.t] - rows[i - 1][F.t] > stepMs * 2.5) {
      out.push([rows[i - 1][F.t] + stepMs, null, null, null, null, null, null, null]);
    }
    out.push(rows[i]);
  }
  return out;
}

module.exports = { Collector, FIELDS: F };
