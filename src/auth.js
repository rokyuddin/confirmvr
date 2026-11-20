'use strict';
/** Signed-cookie sessions (HMAC), no external dependency. */
const config = require('./config');
const db = require('./db');
const { hmac, safeEqual } = require('./util');

const COOKIE = 'cvr_session';
const MAX_AGE_SEC = 30 * 24 * 3600;

function sign(sellerId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = `${sellerId}.${exp}`;
  return `${payload}.${hmac(config.sessionSecret, payload)}`;
}

function verify(token) {
  const [id, exp, sig] = String(token || '').split('.');
  if (!id || !exp || !sig) return null;
  if (!safeEqual(sig, hmac(config.sessionSecret, `${id}.${exp}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return Number(id);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function login(res, sellerId) {
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${sign(sellerId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}${secure}`);
}
function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function loadSeller(req, _res, next) {
  try {
    const id = verify(parseCookies(req.headers.cookie)[COOKIE]);
    req.seller = id ? await db.one('SELECT * FROM sellers WHERE id=?', [id]) : null;
    next();
  } catch (e) { next(e); }
}
function requireSeller(req, res, next) {
  if (!req.seller) return res.redirect('/login');
  next();
}

module.exports = { login, logout, loadSeller, requireSeller, sign, verify };
