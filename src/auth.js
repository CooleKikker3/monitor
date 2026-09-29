const crypto = require('crypto');

const COOKIE = 'monitor_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function createAuth({ user, password, secret, secureCookie }) {
  const failures = new Map(); // ip -> { count, first }

  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  // Hash both sides first so timingSafeEqual gets equal-length buffers
  const safeEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function isAuthenticated(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sign(payload), sig)) return false;
    try {
      const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return u === user && Date.now() < exp;
    } catch {
      return false;
    }
  }

  function setSession(res) {
    const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS })).toString('base64url');
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      maxAge: SESSION_MS,
      path: '/',
    });
  }

  function isBlocked(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > FAIL_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return f.count >= MAX_FAILS;
  }

  function registerFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
    else f.count++;
  }

  function login(req, res) {
    const ip = req.ip;
    if (isBlocked(ip)) return res.redirect('/login?error=blocked');

    const { username = '', password: pass = '' } = req.body || {};
    // Evaluate both comparisons so timing doesn't reveal which one failed
    const okUser = safeEqual(username, user);
    const okPass = safeEqual(pass, password);
    if (okUser && okPass) {
      failures.delete(ip);
      setSession(res);
      return res.redirect('/');
    }
    registerFailure(ip);
    res.redirect('/login?error=invalid');
  }

  function logout(req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/login');
  }

  function requirePage(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.redirect('/login');
  }

  function requireApi(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Niet ingelogd' });
  }

  return { login, logout, isAuthenticated, requirePage, requireApi };
}

module.exports = { createAuth };
