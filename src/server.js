const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { Collector } = require('./collector');
const { ProjectMonitor } = require('./projects');
const { createAuth } = require('./auth');

const env = process.env;
const PUBLIC = path.join(__dirname, '..', 'public');

if (!env.MONITOR_USER || !env.MONITOR_PASSWORD) {
  console.error('MONITOR_USER en MONITOR_PASSWORD moeten in .env staan.');
  process.exit(1);
}

let secret = env.SESSION_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET ontbreekt in .env; sessies vervallen bij elke herstart.');
}

const collector = new Collector({
  dataDir: path.join(__dirname, '..', 'data'),
  intervalSec: Number(env.SAMPLE_INTERVAL_SECONDS) || 5,
  retentionDays: Number(env.RETENTION_DAYS) || 30,
  diskPath: env.DISK_PATH || '/',
});
collector.start();

const projectMonitor = new ProjectMonitor({
  configFile: path.join(__dirname, '..', 'projects.json'),
  dataDir: path.join(__dirname, '..', 'data'),
  intervalSec: Number(env.SAMPLE_INTERVAL_SECONDS) || 5,
  retentionDays: Number(env.RETENTION_DAYS) || 30,
});
projectMonitor.start();

const auth = createAuth({
  user: env.MONITOR_USER,
  password: env.MONITOR_PASSWORD,
  secret,
  secureCookie: env.COOKIE_SECURE === 'true',
});

const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const app = express();
app.disable('x-powered-by');
if (env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.urlencoded({ extended: false }));

app.use('/static', express.static(path.join(PUBLIC, 'static')));
const CHARTJS = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
app.get('/static/chart.js', (req, res) => res.sendFile(CHARTJS));

app.get('/login', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});
app.post('/login', auth.login);
app.post('/logout', auth.logout);

app.get('/', auth.requirePage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.get('/api/current', auth.requireApi, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...collector.current, intervalMs: collector.intervalMs });
});

app.get('/api/history', auth.requireApi, (req, res) => {
  const rangeMs = RANGES[req.query.range] || RANGES['24h'];
  res.set('Cache-Control', 'no-store');
  res.json(collector.history(rangeMs));
});

app.get('/api/projects', auth.requireApi, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ projects: projectMonitor.current() });
});

app.get('/api/projects/history', auth.requireApi, (req, res) => {
  const rangeMs = RANGES[req.query.range] || RANGES['24h'];
  res.set('Cache-Control', 'no-store');
  res.json({ projects: projectMonitor.history(rangeMs) });
});

const port = Number(env.PORT) || 3000;
const host = env.HOST || '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`Monitor draait op http://${host}:${port}`);
});

function shutdown() {
  collector.stop();
  projectMonitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
