const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFile } = require('child_process');
const { Series, round, avgOf, MINUTE } = require('./series');
const { writeJsonAtomic } = require('./collector');

// Row layout per project: [timestamp, cpuPct, memBytes, requestsPerMin, errorsPerMin]
const P = { t: 0, cpu: 1, mem: 2, req: 3, err: 4 };

const HOUR = 60 * MINUTE;
const CLK_TCK = 100; // Linux USER_HZ; /proc/<pid>/stat reports CPU time in these ticks
const PAGE_SIZE = 4096;
const MAX_LOG_READ = 8 * 1024 * 1024;

const TYPES = ['node', 'php', 'laravel', 'static'];

function aggregate(rows, start) {
  const avg = (i) => avgOf(rows, i);
  const mem = avg(P.mem);
  return [start, round(avg(P.cpu), 2), mem == null ? null : Math.round(mem), round(avg(P.req)), round(avg(P.err), 2)];
}

function loadConfig(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Kon ${file} niet lezen:`, err.message);
    return [];
  }
  if (!Array.isArray(list)) {
    console.error(`${file} moet een lijst ([...]) met projecten bevatten.`);
    return [];
  }
  const seen = new Set();
  return list.filter((p) => {
    if (!p || !/^[a-z0-9_-]+$/i.test(p.name || '') || seen.has(p.name)) {
      console.error('Project overgeslagen (naam ontbreekt, is ongeldig of dubbel):', JSON.stringify(p));
      return false;
    }
    seen.add(p.name);
    return true;
  }).map((p) => ({
    name: p.name,
    label: p.label || p.name,
    type: TYPES.includes(p.type) ? p.type : 'static',
    domain: p.domain || null,
    url: p.url || (p.domain ? `https://${p.domain}/` : null),
    healthUrlSet: !!p.url,
    dir: p.dir || null,
    pool: p.pool || null,
    services: [].concat(p.services || []).map((s) => (s.endsWith('.service') ? s : s + '.service')),
    accessLog: p.accessLog === undefined ? `/var/log/nginx/${p.name}.access.log` : p.accessLog,
  }));
}

// ---------- CPU and memory ----------

function readCgroup(service) {
  const dir = `/sys/fs/cgroup/system.slice/${service}`;
  try {
    const cpu = fs.readFileSync(`${dir}/cpu.stat`, 'utf8').match(/^usage_usec (\d+)/m);
    const anon = fs.readFileSync(`${dir}/memory.stat`, 'utf8').match(/^anon (\d+)/m);
    return { usageUsec: cpu ? Number(cpu[1]) : null, mem: anon ? Number(anon[1]) : null };
  } catch {
    return null;
  }
}

/** Finds PHP-FPM workers ("php-fpm: pool <name>") and returns them grouped by pool. */
function scanPhpPools() {
  const pools = new Map();
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return pools;
  }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const m = cmd.match(/^php-fpm: pool (\S+)/);
      if (!m) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
      const startTime = fields[19];
      const [, resident, shared] = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ').map(Number);
      if (!pools.has(m[1])) pools.set(m[1], []);
      // resident - shared leaves out opcache and libraries that all workers share
      pools.get(m[1]).push({ key: `${pid}:${startTime}`, ticks, mem: Math.max(0, resident - shared) * PAGE_SIZE });
    } catch {
      // Process exited while reading
    }
  }
  return pools;
}

// ---------- nginx access log ----------

class LogTail {
  constructor(file) {
    this.file = file;
    this.ino = null;
    this.offset = null;
    this.rest = '';
  }

  /** Returns { requests, errors } since the previous call, or null if the log is unreadable. */
  read() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return null;
    }
    if (this.offset === null) {
      // First read: start at the end so old log lines don't count as a spike
      this.ino = st.ino;
      this.offset = st.size;
      return { requests: 0, errors: 0 };
    }
    if (st.ino !== this.ino || st.size < this.offset) {
      // Log was rotated: read the new file from the start
      this.ino = st.ino;
      this.offset = 0;
      this.rest = '';
    }
    const length = Math.min(st.size - this.offset, MAX_LOG_READ);
    if (length <= 0) return { requests: 0, errors: 0 };

    let text;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, this.offset);
        text = this.rest + buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    this.offset += length;
    // Skip what we couldn't read in one go after a big burst
    if (st.size - this.offset > MAX_LOG_READ) this.offset = st.size;

    const lines = text.split('\n');
    this.rest = lines.pop();
    let requests = 0;
    let errors = 0;
    for (const line of lines) {
      const m = line.match(/" (\d{3}) /);
      if (!m) continue;
      requests++;
      if (m[1][0] === '5') errors++;
    }
    return { requests, errors };
  }
}

// ---------- Slow checks ----------

async function checkHealth(url, strict) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    // On a dedicated health URL only 2xx/3xx is healthy. On the domain root anything
    // below 500 means the app answered; an API root returning 404 is normal.
    const ok = strict ? res.status < 400 : res.status < 500;
    return { ok, status: res.status, ms: Date.now() - started, checkedAt: Date.now() };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Time-out' : (err.cause && err.cause.code) || err.message;
    return { ok: false, status: null, ms: null, error: reason, checkedAt: Date.now() };
  }
}

function checkCert(domain) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve({ error: 'Geen certificaat ontvangen' });
      const validTo = new Date(cert.valid_to).getTime();
      const names = (cert.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean);
      resolve({
        validTo,
        daysLeft: Math.floor((validTo - Date.now()) / (24 * HOUR)),
        trusted: socket.authorized,
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || null,
        names,
      });
    });
    socket.on('error', (err) => resolve({ error: err.code || err.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ error: 'Time-out' }); });
  });
}

const RENEWAL_DIR = '/etc/letsencrypt/renewal';
// apt installs certbot.timer, the snap package installs snap.certbot.renew.timer
const CERTBOT_TIMERS = ['certbot.timer', 'snap.certbot.renew.timer'];

/** Which certificates certbot manages, and whether its renewal timer runs. */
async function certbotStatus() {
  let lineages = null;
  let error = null;
  try {
    lineages = fs.readdirSync(RENEWAL_DIR).filter((f) => f.endsWith('.conf')).map((f) => f.slice(0, -5));
  } catch (err) {
    error = err.code === 'ENOENT' ? 'Certbot niet gevonden op deze server' : `Geen toegang tot ${RENEWAL_DIR}`;
  }

  let timer = null;
  for (const unit of CERTBOT_TIMERS) {
    const { err, stdout } = await run('systemctl', ['show', unit, '--property=LoadState,ActiveState'], 10000);
    if (err) continue;
    const props = Object.fromEntries(stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (props.LoadState !== 'loaded') continue;
    timer = { unit, active: props.ActiveState === 'active' };
    break;
  }
  return { lineages, error, timer };
}

function autoRenewFor(cert, certbot) {
  if (!cert) return null;
  if (!certbot.lineages) return { state: 'unknown', reason: certbot.error };
  // Certbot names a lineage after the first domain, with -0001 etc. for duplicates
  const lineage = certbot.lineages.find((l) => cert.names.includes(l.replace(/-\d{4}$/, '')));
  if (!lineage) {
    const isLetsEncrypt = /let's encrypt/i.test(cert.issuer || '');
    return { state: 'off', reason: isLetsEncrypt ? 'Geen certbot-configuratie voor dit domein' : `Uitgegeven door ${cert.issuer || 'onbekend'}, niet door certbot` };
  }
  if (!certbot.timer) return { state: 'off', lineage, reason: 'Geen certbot-timer gevonden' };
  if (!certbot.timer.active) return { state: 'off', lineage, reason: `${certbot.timer.unit} staat uit` };
  return { state: 'on', lineage };
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

async function diskUsage(dir) {
  // du exits non-zero on unreadable subfolders but still prints the total
  const { stdout } = await run('du', ['-sk', dir], 5 * MINUTE);
  const kb = parseInt(stdout, 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

async function lastCommit(dir) {
  // safe.directory: the repo is owned by root while the monitor runs as www-data
  const { err, stdout } = await run('git', ['-c', 'safe.directory=*', '-C', dir, 'log', '-1', '--format=%h%x1f%s%x1f%cI'], 10000);
  if (err || !stdout.trim()) return null;
  const [hash, subject, date] = stdout.trim().split('\x1f');
  return { hash, subject, date };
}

// ---------- Monitor ----------

class ProjectMonitor {
  constructor({ configFile, dataDir, intervalSec = 5, retentionDays = 30 }) {
    this.projects = loadConfig(configFile);
    this.file = path.join(dataDir, 'projects-history.json');
    this.intervalMs = Math.max(1, intervalSec) * 1000;
    this.cores = os.cpus().length || 1;
    this.dirty = false;
    this.lastSample = null;
    this.prevCgroup = new Map();
    this.prevProcs = null; // null until the first scan, so existing workers don't count as a spike

    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8')).projects || {};
    } catch {
      // No history yet
    }

    this.state = new Map();
    for (const p of this.projects) {
      const series = new Series({ aggregate, retentionMs: retentionDays * 24 * HOUR, intervalMs: this.intervalMs });
      series.load(saved[p.name]);
      this.state.set(p.name, {
        series,
        log: p.accessLog ? new LogTail(p.accessLog) : null,
        counts: [], // [timestamp, requests, errors] for the last hour
        current: { cpu: null, mem: null },
        health: null,
        cert: null,
        disk: null,
        git: null,
      });
    }
  }

  sample() {
    const now = Date.now();
    const elapsedMs = this.lastSample ? now - this.lastSample : this.intervalMs;
    this.lastSample = now;
    const pools = this.projects.some((p) => p.pool) ? scanPhpPools() : new Map();

    // CPU ticks per worker since the previous scan
    const procTicks = new Map();
    for (const workers of pools.values()) for (const w of workers) procTicks.set(w.key, w.ticks);
    const firstScan = this.prevProcs === null;
    const tickDelta = (w) => (firstScan ? 0 : w.ticks - (this.prevProcs.get(w.key) ?? 0));

    for (const p of this.projects) {
      const s = this.state.get(p.name);
      let cpuSec = null;
      let mem = null;

      for (const svc of p.services) {
        const cg = readCgroup(svc);
        if (!cg) continue;
        const prev = this.prevCgroup.get(svc);
        this.prevCgroup.set(svc, cg.usageUsec);
        if (prev != null && cg.usageUsec != null) cpuSec = (cpuSec || 0) + Math.max(0, cg.usageUsec - prev) / 1e6;
        if (cg.mem != null) mem = (mem || 0) + cg.mem;
      }

      if (p.pool) {
        const workers = pools.get(p.pool) || [];
        // An idle ondemand pool has no workers; that is real zero usage, not missing data
        if (workers.length || process.platform === 'linux') {
          cpuSec = (cpuSec || 0) + workers.reduce((sum, w) => sum + Math.max(0, tickDelta(w)), 0) / CLK_TCK;
          mem = (mem || 0) + workers.reduce((sum, w) => sum + w.mem, 0);
        }
      }

      const cpu = cpuSec == null ? null : Math.min(100, (cpuSec / (elapsedMs / 1000) / this.cores) * 100);

      let reqRate = null;
      let errRate = null;
      const log = s.log && s.log.read();
      if (log) {
        s.counts.push([now, log.requests, log.errors]);
        reqRate = (log.requests * MINUTE) / elapsedMs;
        errRate = (log.errors * MINUTE) / elapsedMs;
      }
      while (s.counts.length && s.counts[0][0] < now - HOUR) s.counts.shift();

      s.current = { cpu, mem, hasLog: !!log };
      const row = [now, cpu == null ? null : round(cpu, 2), mem, reqRate == null ? null : round(reqRate), errRate == null ? null : round(errRate, 2)];
      if (s.series.add(row)) this.dirty = true;
    }

    this.prevProcs = procTicks;
  }

  async runChecks(kind, onlyFailed = false) {
    const certbot = kind === 'cert' ? await certbotStatus() : null;
    for (const p of this.projects) {
      const s = this.state.get(p.name);
      if (onlyFailed && !(s.cert && s.cert.error)) continue;
      try {
        if (kind === 'health' && p.url) s.health = await checkHealth(p.url, p.healthUrlSet);
        if (kind === 'cert' && p.domain) {
          const cert = await checkCert(p.domain);
          s.cert = cert.error
            ? { error: cert.error, checkedAt: Date.now() }
            : { ...cert, autoRenew: autoRenewFor(cert, certbot), checkedAt: Date.now() };
          if (cert.error) console.error(`Certificaat van ${p.domain} niet uitgelezen: ${cert.error}`);
        }
        if (kind === 'disk' && p.dir) s.disk = { bytes: await diskUsage(p.dir), checkedAt: Date.now() };
        if (kind === 'git' && p.dir) s.git = await lastCommit(p.dir);
      } catch (err) {
        console.error(`Controle '${kind}' voor ${p.name} mislukt:`, err.message);
      }
    }
  }

  start() {
    if (!this.projects.length) return;
    this.sample();
    this.timers = [
      setInterval(() => this.sample(), this.intervalMs),
      setInterval(() => this.trySave(), MINUTE),
      setInterval(() => this.runChecks('health'), MINUTE),
      setInterval(() => this.runChecks('git'), 5 * MINUTE),
      setInterval(() => this.runChecks('disk'), HOUR),
      setInterval(() => this.runChecks('cert'), 6 * HOUR),
      // A failed certificate check shouldn't stay failed for 6 hours
      setInterval(() => this.runChecks('cert', true), 5 * MINUTE),
    ];
    this.runChecks('health');
    this.runChecks('git');
    this.runChecks('cert');
    // du can take a while on big projects; don't compete with startup
    setTimeout(() => this.runChecks('disk'), 15000).unref();
  }

  stop() {
    (this.timers || []).forEach(clearInterval);
    for (const s of this.state.values()) if (s.series.flush()) this.dirty = true;
    this.trySave();
  }

  trySave() {
    if (!this.dirty) return;
    try {
      const projects = {};
      for (const [name, s] of this.state) projects[name] = s.series.minutes;
      writeJsonAtomic(this.file, { version: 1, projects });
      this.dirty = false;
    } catch (err) {
      console.error('Kon projecthistorie niet opslaan:', err.message);
    }
  }

  current() {
    const now = Date.now();
    return this.projects.map((p) => {
      const s = this.state.get(p.name);
      const lastMinute = s.counts.filter((c) => c[0] >= now - MINUTE);
      const sum = (rows, i) => rows.reduce((acc, c) => acc + c[i], 0);
      return {
        name: p.name,
        label: p.label,
        type: p.type,
        domain: p.domain,
        dir: p.dir,
        cpu: s.current.cpu == null ? null : round(s.current.cpu, 2),
        mem: s.current.mem,
        requestsPerMin: s.current.hasLog ? sum(lastMinute, 1) : null,
        requests1h: s.current.hasLog ? sum(s.counts, 1) : null,
        errors1h: s.current.hasLog ? sum(s.counts, 2) : null,
        disk: s.disk,
        health: s.health,
        cert: s.cert,
        git: s.git,
      };
    });
  }

  history(rangeMs) {
    return this.projects.map((p) => ({ name: p.name, ...this.state.get(p.name).series.history(rangeMs) }));
  }
}

module.exports = { ProjectMonitor };
