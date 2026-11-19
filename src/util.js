'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toBnDigits = (s) => String(s).replace(/\d/g, (d) => BN_DIGITS[d]);

/** Format amount in Bangla: 1250 -> "১,২৫০ টাকা" (South-Asian grouping). */
function bnTaka(amount) {
  const n = Math.round(Number(amount) || 0);
  const s = String(n);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return toBnDigits(rest ? `${rest},${last3}` : last3) + ' টাকা';
}

/** Normalize Bangladeshi mobile numbers to +8801XXXXXXXXX; returns null if invalid. */
function normalizeBdPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[০-৯]/g, (c) => BN_DIGITS.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  else if (d.startsWith('88')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return /^01[3-9]\d{8}$/.test(d) ? '+88' + d : null;
}

// Dhaka is UTC+6 with no DST.
const DHAKA_OFFSET_MS = 6 * 3600 * 1000;

/**
 * Given a desired call time, push it into the allowed call window (Dhaka local time).
 * Calls after the window end go to the next morning's window start.
 */
function clampToCallWindow(date, startHour = config.callWindowStartHour, endHour = config.callWindowEndHour) {
  const local = new Date(date.getTime() + DHAKA_OFFSET_MS);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  if (h >= startHour && h < endHour) return date;
  const target = new Date(local);
  if (h >= endHour) target.setUTCDate(target.getUTCDate() + 1);
  target.setUTCHours(startHour, 0, 0, 0);
  return new Date(target.getTime() - DHAKA_OFFSET_MS);
}

const iso = (d) => d.toISOString();
const addMin = (d, m) => new Date(d.getTime() + m * 60000);

function hmac(secret, data, enc = 'hex') {
  return crypto.createHmac('sha256', secret).update(data).digest(enc);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  return safeEqual(crypto.scryptSync(pw, salt, 64).toString('hex'), h);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Small CSV parser that handles quoted fields. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

module.exports = {
  toBnDigits, bnTaka, normalizeBdPhone, clampToCallWindow, iso, addMin,
  hmac, safeEqual, hashPassword, verifyPassword, esc, parseCsv,
};
