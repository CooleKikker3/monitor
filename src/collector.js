const fs = require('fs');
const os = require('os');
const path = require('path');
const { Series, round, avgOf, maxOf, MINUTE } = require('./series');

// Row layout for stored samples (compact arrays keep the history file small):
// [timestamp, cpuAvg, cpuMax, memPct, memUsed, diskPct, diskUsed, swapPct]
const F = { t: 0, cpu: 1, cpuMax: 2, memPct: 3, memUsed: 4, diskPct: 5, diskUsed: 6, swapPct: 7 };

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

function aggregate(rows, start) {
  const avg = (i) => avgOf(rows, i);
  return [
    start,
    round(avg(F.cpu)),
    round(maxOf(rows, F.cpuMax)),
    round(avg(F.memPct)),
    Math.round(avg(F.memUsed)),
    round(avg(F.diskPct)),
    Math.round(avg(F.diskUsed)),
    round(avg(F.swapPct)),
  ];
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

class Collector {
  constructor({ dataDir, intervalSec = 5, retentionDays = 30, diskPath = '/' }) {
    this.file = path.join(dataDir, 'history.json');
    this.intervalMs = Math.max(1, intervalSec) * 1000;
    this.diskPath = diskPath;
    this.series = new Series({
      aggregate,
      retentionMs: retentionDays * 24 * 60 * MINUTE,
      intervalMs: this.intervalMs,
    });
    this.current = null;
    this.prevCpu = cpuTimes();
    this.dirty = false;

    try {
      this.series.load(JSON.parse(fs.readFileSync(this.file, 'utf8')).minutes);
    } catch {
      // No history yet
    }
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
    if (this.series.add(row)) this.dirty = true;
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.saveTimer = setInterval(() => this.trySave(), MINUTE);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    if (this.series.flush()) this.dirty = true;
    this.trySave();
  }

  trySave() {
    if (!this.dirty) return;
    try {
      writeJsonAtomic(this.file, { version: 1, minutes: this.series.minutes });
      this.dirty = false;
    } catch (err) {
      console.error('Kon historie niet opslaan:', err.message);
    }
  }

  history(rangeMs) {
    return this.series.history(rangeMs);
  }
}

module.exports = { Collector, writeJsonAtomic };
