'use strict';
/**
 * Admin panel at /admin (login with ADMIN_TOKEN).
 * - Approve / reject bKash top-up requests
 * - Sellers overview (credits, orders, confirm rate), manual credit adjustment
 * - Platform totals (calls today/this month, answered rate, credits sold)
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const topups = require('../services/topups');
const billing = require('../services/billing');
const { layout } = require('../views/layout');
const { esc, hmac, safeEqual, toBnDigits, bnTaka } = require('../util');

const r = express.Router();
const COOKIE = 'cvr_admin';
const MAX_AGE = 12 * 3600;

function signAdmin() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return `${exp}.${hmac(config.sessionSecret, `admin.${exp}`)}`;
}
function isAdmin(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  return Boolean(exp && sig && Number(exp) > Date.now() / 1000 && safeEqual(sig, hmac(config.sessionSecret, `admin.${exp}`)));
}
const secure = () => (config.baseUrl.startsWith('https') ? '; Secure' : '');
const page = (req, res, title, body) => res.send(layout({
  title, body: `<nav class="tabs"><a href="/admin">টপআপ</a><a href="/admin/sellers">সেলার</a><a href="/admin/stats">পরিসংখ্যান</a>
    <form method="post" action="/admin/logout" class="inline right"><button class="link">লগআউট</button></form></nav>${body}`,
  flash: req.query.ok ? { type: 'ok', msg: req.query.ok } : req.query.err ? { type: 'err', msg: req.query.err } : null,
}));
const back = (res, path, kind, msg) => res.redirect(`${path}?${kind}=${encodeURIComponent(msg)}`);
const dhaka = (s) => (s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

r.get('/admin/login', (req, res) => res.send(layout({
  title: 'অ্যাডমিন',
  flash: req.query.err ? { type: 'err', msg: req.query.err } : null,
  body: `<form method="post" action="/admin/login" class="card narrow"><h2>অ্যাডমিন লগইন</h2>
    <label>ADMIN_TOKEN<input type="password" name="token" required></label><button class="btn">লগইন</button></form>`,
})));
r.post('/admin/login', (req, res) => {
  if (!config.adminToken || !safeEqual(req.body.token || '', config.adminToken)) return back(res, '/admin/login', 'err', 'ভুল token');
  res.setHeader('Set-Cookie', `${COOKIE}=${signAdmin()}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure()}`);
  res.redirect('/admin');
});
r.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.redirect('/admin/login');
});

r.use('/admin', (req, res, next) => (isAdmin(req) ? next() : res.redirect('/admin/login')));

// ---- Top-up requests ----
r.get('/admin', async (req, res) => {
  const pending = await db.all(`SELECT t.*, s.page_name, s.email FROM topup_requests t JOIN sellers s ON s.id=t.seller_id WHERE t.status='pending' ORDER BY t.id`);
  const recent = await db.all(`SELECT t.*, s.page_name FROM topup_requests t JOIN sellers s ON s.id=t.seller_id WHERE t.status!='pending' ORDER BY t.decided_at DESC LIMIT 20`);
  page(req, res, 'অ্যাডমিন: টপআপ', `
<h2>অপেক্ষমাণ রিচার্জ (${toBnDigits(pending.length)})</h2>
<p class="muted">bKash মার্চেন্ট অ্যাপে TrxID আর টাকার পরিমাণ মিলিয়ে তারপর অনুমোদন দিন। পরিমাণ ভুল হলে ঠিক করে দিন।</p>
<table class="orders"><thead><tr><th>সময়</th><th>সেলার</th><th>TrxID</th><th>টাকা</th><th></th></tr></thead><tbody>
${pending.map((t) => `<tr><td>${dhaka(t.created_at)}</td><td>${esc(t.page_name)}<br><small class="muted">CVR${t.seller_id} · ${esc(t.email)}</small></td>
  <td class="mono">${esc(t.trx_id)}</td><td>${bnTaka(t.amount)}</td>
  <td class="actions">
    <form method="post" action="/admin/topups/${t.id}/approve"><input name="amount" type="number" value="${t.amount}" style="width:100px;display:inline"><button class="btn sm">অনুমোদন</button></form>
    <form method="post" action="/admin/topups/${t.id}/reject"><input name="note" placeholder="কারণ" style="width:140px;display:inline"><button class="btn sm ghost">বাতিল</button></form>
  </td></tr>`).join('') || '<tr><td colspan="5" class="muted">কোনো অপেক্ষমাণ রিকোয়েস্ট নেই</td></tr>'}
</tbody></table>
<h3>সাম্প্রতিক নিষ্পত্তি</h3>
<table class="orders"><tbody>${recent.map((t) => `<tr><td>${dhaka(t.decided_at)}</td><td>${esc(t.page_name)}</td><td class="mono">${esc(t.trx_id)}</td><td>${bnTaka(t.amount)}</td>
  <td><span class="badge ${t.status === 'approved' ? 's-confirmed' : 's-cancelled'}">${t.status === 'approved' ? 'অনুমোদিত' : 'বাতিল'}</span> ${esc(t.note || '')}</td></tr>`).join('')}</tbody></table>`);
});

r.post('/admin/topups/:id/approve', async (req, res) => {
  try {
    const ok = await topups.approve(Number(req.params.id), Number(req.body.amount));
    back(res, '/admin', ok ? 'ok' : 'err', ok ? 'ক্রেডিট যোগ হয়েছে' : 'এই TrxID আগেই ক্রেডিট করা হয়েছে');
  } catch (e) { back(res, '/admin', 'err', e.message); }
});
r.post('/admin/topups/:id/reject', async (req, res) => {
  try { await topups.reject(Number(req.params.id), String(req.body.note || '').slice(0, 200)); back(res, '/admin', 'ok', 'বাতিল করা হয়েছে'); }
  catch (e) { back(res, '/admin', 'err', e.message); }
});

// ---- Sellers ----
r.get('/admin/sellers', async (req, res) => {
  const rows = await db.all(`
    SELECT s.id, s.page_name, s.email, s.phone, s.credits, s.courier, s.created_at,
           COUNT(o.id) AS total,
           SUM(CASE WHEN o.status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
           SUM(CASE WHEN o.status='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM sellers s LEFT JOIN orders o ON o.seller_id=s.id
     GROUP BY s.id, s.page_name, s.email, s.phone, s.credits, s.courier, s.created_at
     ORDER BY s.id DESC LIMIT 500`);
  const free = {};
  for (const s of rows) free[s.id] = (await billing.summary(s.id)).freeLeft;
  page(req, res, 'অ্যাডমিন: সেলার', `
<h2>সেলার (${toBnDigits(rows.length)})</h2>
<table class="orders"><thead><tr><th>সেলার</th><th>অর্ডার</th><th>কনফার্ম রেট</th><th>ক্রেডিট</th><th>ক্রেডিট সমন্বয়</th></tr></thead><tbody>
${rows.map((s) => {
    const done = (s.confirmed || 0) + (s.cancelled || 0);
    return `<tr><td>${esc(s.page_name)} <small class="muted">CVR${s.id}</small><br><small>${esc(s.email)} · ${esc(s.phone || '')} · ${esc(s.courier || 'কুরিয়ার নেই')}</small></td>
    <td>${toBnDigits(s.total || 0)}</td><td>${done ? toBnDigits(Math.round((100 * s.confirmed) / done)) + '%' : '-'}</td>
    <td>${toBnDigits(s.credits)}<br><small class="muted">ফ্রি বাকি ${toBnDigits(free[s.id])}</small></td>
    <td><form method="post" action="/admin/sellers/${s.id}/adjust" class="inline"><input name="credits" type="number" step="1" placeholder="+/-" style="width:80px;display:inline" required>
      <input name="reason" placeholder="কারণ" style="width:120px;display:inline" required><button class="btn sm ghost">সেভ</button></form></td></tr>`;
  }).join('')}
</tbody></table>`);
});

r.post('/admin/sellers/:id/adjust', async (req, res) => {
  const id = Number(req.params.id);
  const c = Number(req.body.credits);
  if (!Number.isFinite(c) || c === 0 || !req.body.reason) return back(res, '/admin/sellers', 'err', 'ক্রেডিট আর কারণ দিন');
  await db.tx(async (q) => {
    await q.run('UPDATE sellers SET credits = credits + ? WHERE id=?', [c, id]);
    await q.run(`INSERT INTO ledger (seller_id, kind, credits, ref, created_at) VALUES (?, 'adjust', ?, ?, ?)`, [id, c, `admin:${String(req.body.reason).slice(0, 100)}`, db.now()]);
  });
  back(res, '/admin/sellers', 'ok', `CVR${id}: ${c > 0 ? '+' : ''}${c} ক্রেডিট`);
});

// ---- Stats ----
r.get('/admin/stats', async (req, res) => {
  const now = new Date();
  const dayStart = new Date(new Date(now.getTime() + 6 * 3600e3).setUTCHours(0, 0, 0, 0) - 6 * 3600e3).toISOString();
  const monthStart = billing.monthStartUtc(now).toISOString();
  const callStats = async (since) => db.one(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) AS answered,
      SUM(charged) AS charged FROM calls WHERE created_at >= ?`, [since]);
  const today = await callStats(dayStart);
  const month = await callStats(monthStart);
  const sold = await db.one(`SELECT SUM(amount) AS taka, COUNT(*) AS n FROM topup_requests WHERE status='approved' AND decided_at >= ?`, [monthStart]);
  const sellers = await db.one('SELECT COUNT(*) AS n FROM sellers');
  const orders = await db.one('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?', [monthStart]);
  const pct = (a, b) => (b ? `${toBnDigits(Math.round((100 * (a || 0)) / b))}%` : '-');
  page(req, res, 'অ্যাডমিন: পরিসংখ্যান', `
<div class="stats">
  <div class="card stat"><b>${toBnDigits(today.total || 0)}</b>আজকের কল</div>
  <div class="card stat"><b>${pct(today.answered, today.total)}</b>আজ ধরেছে</div>
  <div class="card stat"><b>${toBnDigits(month.total || 0)}</b>এই মাসের কল</div>
  <div class="card stat"><b>${pct(month.answered, month.total)}</b>এই মাসে ধরেছে</div>
  <div class="card stat"><b>${toBnDigits(month.charged || 0)}</b>এই মাসে কাটা ক্রেডিট</div>
  <div class="card stat"><b>${bnTaka(sold.taka || 0)}</b>এই মাসে রিচার্জ (${toBnDigits(sold.n || 0)}টা)</div>
  <div class="card stat"><b>${toBnDigits(orders.n)}</b>এই মাসের অর্ডার</div>
  <div class="card stat"><b>${toBnDigits(sellers.n)}</b>মোট সেলার</div>
</div>
<p class="muted">প্রতিটা কলের খরচ প্রোভাইডারের বিলের সাথে মিলিয়ে দেখুন। "ধরেছে" কলের সংখ্যাই মূলত খরচ ঠিক করে।</p>`);
});

module.exports = r;
