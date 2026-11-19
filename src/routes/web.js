'use strict';
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const billing = require('../services/billing');
const calls = require('../services/calls');
const courier = require('../services/courier');
const sheets = require('../services/sheets');
const risk = require('../services/risk');
const { createOrder, STATUS_LABELS } = require('../services/orders');
const { fullText } = require('../voice/ivr');
const { layout } = require('../views/layout');
const { esc, bnTaka, toBnDigits, hashPassword, verifyPassword } = require('../util');

const r = express.Router();
const flashOf = (q) => (q.ok ? { type: 'ok', msg: q.ok } : q.err ? { type: 'err', msg: q.err } : null);
const back = (res, path, kind, msg) => res.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);
const page = (req, res, title, body) => res.send(layout({ title, seller: req.seller, body, flash: flashOf(req.query) }));
const ownOrder = (req) => db.get().prepare('SELECT * FROM orders WHERE id=? AND seller_id=?').get(Number(req.params.id), req.seller.id);

// ---------- Landing ----------
r.get('/', (req, res) => {
  if (req.seller) return res.redirect('/dashboard');
  page(req, res, 'হোম', `
<section class="hero">
  <h1>প্রতিটা ফেক অর্ডারে কুরিয়ার চার্জ গুনছেন?</h1>
  <p>শিপ করার আগে রোবট কল দিয়ে যাচাই করুন। অর্ডার আসার কয়েক মিনিটের মধ্যে কাস্টমারের কাছে বাংলায় অটো কল যাবে —
     ১ চাপলে কনফার্মড, ২ চাপলে বাতিল, ৩ চাপলে আপনার সাথে কথা।</p>
  <a class="btn big" href="/signup">প্রথম ${toBnDigits(config.freeCallsPerMonth)} কল ফ্রি — শুরু করুন</a>
</section>
<section class="grid3">
  <div class="card"><h3>Google Sheet / WooCommerce / Shopify</h3><p>যেখানেই অর্ডার রাখুন, অটো কল চলে যাবে।</p></div>
  <div class="card"><h3>অটো রিট্রাই</h3><p>না ধরলে ৩০ মিনিট পরে, তারপর ২ ঘণ্টা পরে আবার কল।</p></div>
  <div class="card"><h3>এক ক্লিকে কুরিয়ার</h3><p>কনফার্মড অর্ডার Steadfast / Pathao / RedX-এ পাঠান।</p></div>
</section>`);
});

// ---------- Auth ----------
const authForm = (mode) => `
<form method="post" class="card narrow">
  <h2>${mode === 'signup' ? 'একাউন্ট খুলুন' : 'লগইন'}</h2>
  ${mode === 'signup' ? `<label>পেজের নাম (কলে এটাই বলা হবে)<input name="page_name" required></label>
  <label>আপনার মোবাইল (৩ চাপলে কল এখানে আসবে)<input name="phone" placeholder="01XXXXXXXXX"></label>` : ''}
  <label>ইমেইল<input type="email" name="email" required></label>
  <label>পাসওয়ার্ড<input type="password" name="password" minlength="6" required></label>
  <button class="btn">${mode === 'signup' ? 'শুরু করুন' : 'লগইন'}</button>
  <p class="muted">${mode === 'signup' ? '<a href="/login">আগে থেকেই একাউন্ট আছে?</a>' : '<a href="/signup">নতুন একাউন্ট</a>'}</p>
</form>`;

r.get('/signup', (req, res) => page(req, res, 'সাইনআপ', authForm('signup')));
r.post('/signup', (req, res) => {
  const { email, password, page_name, phone } = req.body;
  if (!email || !password || password.length < 6 || !page_name) return back(res, '/signup', 'err', 'সব তথ্য দিন (পাসওয়ার্ড কমপক্ষে ৬ অক্ষর)');
  const { normalizeBdPhone } = require('../util');
  try {
    const id = db.get().prepare('INSERT INTO sellers (email, password_hash, page_name, phone, webhook_token) VALUES (?,?,?,?,?)')
      .run(email.toLowerCase().trim(), hashPassword(password), page_name.trim(), normalizeBdPhone(phone), crypto.randomBytes(16).toString('hex')).lastInsertRowid;
    auth.login(res, id);
    back(res, '/dashboard', 'ok', 'স্বাগতম! প্রথম অর্ডার যোগ করুন বা Google Sheet কানেক্ট করুন।');
  } catch (e) {
    back(res, '/signup', 'err', /UNIQUE/.test(e.message) ? 'এই ইমেইলে একাউন্ট আছে' : e.message);
  }
});
r.get('/login', (req, res) => page(req, res, 'লগইন', authForm('login')));
r.post('/login', (req, res) => {
  const s = db.get().prepare('SELECT * FROM sellers WHERE email=?').get(String(req.body.email || '').toLowerCase().trim());
  if (!s || !verifyPassword(req.body.password || '', s.password_hash)) return back(res, '/login', 'err', 'ইমেইল বা পাসওয়ার্ড ভুল');
  auth.login(res, s.id);
  res.redirect('/dashboard');
});
r.post('/logout', (req, res) => { auth.logout(res); res.redirect('/'); });

r.use(auth.requireSeller);

// ---------- Dashboard ----------
const TABS = ['all', 'confirmed', 'cancelled', 'no_answer', 'wrong_number', 'callback', 'pending', 'calling', 'no_credit'];

r.get('/dashboard', (req, res) => {
  const d = db.get();
  const sid = req.seller.id;
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'all';
  const counts = Object.fromEntries(d.prepare('SELECT status, COUNT(*) n FROM orders WHERE seller_id=? GROUP BY status').all(sid).map((x) => [x.status, x.n]));
  counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
  const orders = tab === 'all'
    ? d.prepare('SELECT * FROM orders WHERE seller_id=? ORDER BY id DESC LIMIT 200').all(sid)
    : d.prepare('SELECT * FROM orders WHERE seller_id=? AND status=? ORDER BY id DESC LIMIT 200').all(sid, tab);
  const stats = risk.phoneStats(orders.map((o) => o.phone));
  const b = billing.summary(sid);
  const notes = d.prepare('SELECT * FROM notifications WHERE seller_id=? AND read=0 ORDER BY id DESC LIMIT 10').all(sid);
  const mock = config.voiceProvider === 'mock';

  const tabLabel = (t) => (t === 'all' ? 'সব' : STATUS_LABELS[t]);
  const rows = orders.map((o) => {
    const st = stats[o.phone];
    return `<tr>
      <td>#${o.id}<br><small class="muted">${esc(o.source)}</small></td>
      <td>${esc(o.customer_name || '')}<br><span class="mono">${esc(o.phone)}</span>
        ${st?.risky ? `<br><span class="badge risk" title="সব সেলারের ডাটা থেকে">⚠ ${esc(st.flags.join(', '))}</span>` : ''}</td>
      <td>${esc(o.product)}<br><b>${bnTaka(o.amount)}</b></td>
      <td><span class="badge s-${o.status}">${STATUS_LABELS[o.status]}</span>
        <br><small class="muted">কল: ${toBnDigits(o.attempts)}${o.next_call_at ? ` · পরের কল ${new Date(o.next_call_at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}` : ''}</small></td>
      <td class="actions">
        ${o.status === 'confirmed' ? (o.courier_status === 'sent'
          ? `<span class="badge s-confirmed">কুরিয়ার: ${esc(o.courier_ref)}</span>`
          : `<form method="post" action="/orders/${o.id}/courier"><button class="btn sm">কুরিয়ারে পাঠান</button></form>${o.courier_error ? `<small class="err">${esc(o.courier_error)}</small>` : ''}`) : ''}
        ${['no_answer', 'no_credit', 'wrong_number', 'callback', 'cancelled'].includes(o.status) ? `<form method="post" action="/orders/${o.id}/recall"><button class="btn sm ghost">আবার কল</button></form>` : ''}
        ${!['confirmed', 'cancelled'].includes(o.status) ? `
          <form method="post" action="/orders/${o.id}/mark"><input type="hidden" name="status" value="confirmed"><button class="btn sm ghost">✓ ম্যানুয়াল কনফার্ম</button></form>
          <form method="post" action="/orders/${o.id}/mark"><input type="hidden" name="status" value="cancelled"><button class="btn sm ghost">✗ বাতিল</button></form>` : ''}
        ${mock && o.status === 'calling' ? `<div class="sim">টেস্ট: ${['1', '2', '3'].map((k) => `<form method="post" action="/orders/${o.id}/simulate"><input type="hidden" name="dtmf" value="${k}"><button class="btn sm">${toBnDigits(k)}</button></form>`).join('')}
          <form method="post" action="/orders/${o.id}/simulate"><input type="hidden" name="dtmf" value="none"><button class="btn sm ghost">ধরেনি</button></form></div>` : ''}
      </td></tr>`;
  }).join('');

  page(req, res, 'ড্যাশবোর্ড', `
<div class="stats">
  <div class="card stat"><b>${toBnDigits(counts.confirmed || 0)}</b>কনফার্মড</div>
  <div class="card stat"><b>${toBnDigits(counts.cancelled || 0)}</b>বাতিল</div>
  <div class="card stat"><b>${toBnDigits(counts.no_answer || 0)}</b>ধরেনি</div>
  <div class="card stat"><b>${toBnDigits(counts.wrong_number || 0)}</b>নম্বর ভুল</div>
  <div class="card stat"><b>${toBnDigits(b.freeLeft)}</b>ফ্রি কল বাকি</div>
  <div class="card stat"><b>${toBnDigits(b.credits)}</b>ক্রেডিট</div>
</div>
${notes.length ? `<div class="card notes"><h3>🔔 নোটিফিকেশন</h3><ul>${notes.map((n) => `<li>${esc(n.message)} <small class="muted">${esc(n.created_at)}</small></li>`).join('')}</ul>
  <form method="post" action="/notifications/read"><button class="btn sm ghost">সব পড়া হয়েছে</button></form></div>` : ''}
${mock ? '<p class="muted">⚙ টেস্ট মোড (VOICE_PROVIDER=mock): আসল কল যাচ্ছে না। "কল চলছে" অর্ডারে ১/২/৩ চেপে ফলাফল সিমুলেট করুন।</p>' : ''}
<div class="tabs">${TABS.filter((t) => t === 'all' || counts[t] || ['confirmed', 'cancelled', 'no_answer', 'wrong_number'].includes(t))
    .map((t) => `<a class="${t === tab ? 'active' : ''}" href="/dashboard?tab=${t}">${tabLabel(t)} (${toBnDigits(counts[t] || 0)})</a>`).join('')}
  <a href="/orders/export.csv" class="right">CSV ডাউনলোড</a></div>
<table class="orders"><thead><tr><th>অর্ডার</th><th>কাস্টমার</th><th>প্রোডাক্ট</th><th>স্ট্যাটাস</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">কোনো অর্ডার নেই। <a href="/orders/new">নতুন অর্ডার যোগ করুন</a></td></tr>'}</tbody></table>`);
});

r.post('/notifications/read', (req, res) => {
  db.get().prepare('UPDATE notifications SET read=1 WHERE seller_id=?').run(req.seller.id);
  res.redirect('/dashboard');
});

// ---------- Orders ----------
r.get('/orders/new', (req, res) => {
  const preview = fullText(req.seller, { product: '[প্রোডাক্ট]', amount: 1250 });
  page(req, res, 'নতুন অর্ডার', `
<form method="post" action="/orders" class="card narrow">
  <h2>নতুন অর্ডার</h2>
  <label>কাস্টমারের নাম<input name="customer_name"></label>
  <label>মোবাইল নম্বর *<input name="phone" required placeholder="01XXXXXXXXX"></label>
  <label>প্রোডাক্ট *<input name="product" required></label>
  <label>মোট টাকা *<input name="amount" type="number" min="0" step="1" required></label>
  <label>ঠিকানা<textarea name="address" rows="2"></textarea></label>
  <button class="btn">সেভ করুন ও কল শিডিউল করুন</button>
  <p class="muted">কলে যা শুনবে: “${esc(preview)}”</p>
</form>
<form method="post" action="/orders/import" class="card narrow">
  <h3>CSV পেস্ট করে একসাথে অনেক অর্ডার</h3>
  <p class="muted">হেডার: order_id,name,phone,product,amount,address</p>
  <textarea name="csv" rows="5" placeholder="order_id,name,phone,product,amount,address"></textarea>
  <button class="btn ghost">ইমপোর্ট</button>
</form>`);
});

r.post('/orders', (req, res) => {
  try {
    const { order } = createOrder(req.seller.id, { ...req.body, source: 'manual' });
    back(res, '/dashboard', order.status === 'wrong_number' ? 'err' : 'ok',
      order.status === 'wrong_number' ? `অর্ডার #${order.id}: নম্বরটি সঠিক বাংলাদেশি মোবাইল নম্বর নয়` : `অর্ডার #${order.id} সেভ হয়েছে, কিছুক্ষণের মধ্যে কল যাবে`);
  } catch (e) { back(res, '/orders/new', 'err', e.message); }
});

r.post('/orders/import', (req, res) => {
  try {
    const out = sheets.importCsv(req.seller.id, String(req.body.csv || ''));
    back(res, '/dashboard', 'ok', `নতুন ${out.created}, আগে ছিল ${out.skipped}${out.errors.length ? `, ভুল ${out.errors.length}: ${out.errors.slice(0, 3).join('; ')}` : ''}`);
  } catch (e) { back(res, '/orders/new', 'err', e.message); }
});

r.get('/orders/export.csv', (req, res) => {
  const rows = db.get().prepare('SELECT * FROM orders WHERE seller_id=? ORDER BY id').all(req.seller.id);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv; charset=utf-8').attachment('confirm-call-orders.csv').send(
    '﻿id,source,external_id,name,phone,product,amount,address,status,attempts,courier_ref,created_at\n' +
    rows.map((o) => [o.id, o.source, o.external_id, o.customer_name, o.phone, o.product, o.amount, o.address, o.status, o.attempts, o.courier_ref, o.created_at].map(q).join(',')).join('\n'));
});

r.post('/orders/:id/courier', async (req, res) => {
  const o = ownOrder(req);
  if (!o) return res.status(404).send('Not found');
  try {
    const ref = await courier.sendToCourier(req.seller, o);
    back(res, '/dashboard?tab=confirmed', 'ok', `অর্ডার #${o.id} কুরিয়ারে গেছে: ${ref}`);
  } catch (e) { back(res, '/dashboard?tab=confirmed', 'err', `কুরিয়ার: ${e.message}`); }
});

r.post('/orders/:id/recall', (req, res) => {
  const o = ownOrder(req);
  if (!o) return res.status(404).send('Not found');
  calls.requeue(o.id);
  back(res, '/dashboard', 'ok', `অর্ডার #${o.id} আবার কলের তালিকায়`);
});

r.post('/orders/:id/mark', (req, res) => {
  const o = ownOrder(req);
  if (!o || !['confirmed', 'cancelled'].includes(req.body.status)) return res.status(400).send('Bad request');
  require('../services/orders').setStatus(o.id, req.body.status, { next_call_at: null });
  res.redirect('/dashboard');
});

// Mock-mode only: simulate the customer's key press.
r.post('/orders/:id/simulate', async (req, res) => {
  if (config.voiceProvider !== 'mock') return res.status(403).send('Only in mock mode');
  const o = ownOrder(req);
  const call = o && db.get().prepare('SELECT * FROM calls WHERE order_id=? AND ended_at IS NULL ORDER BY id DESC').get(o.id);
  if (!call) return back(res, '/dashboard', 'err', 'চলমান কল নেই');
  await calls.handleCallResult(req.body.dtmf === 'none'
    ? { call_id: call.id, status: 'no_answer' }
    : { call_id: call.id, status: 'answered', dtmf: req.body.dtmf, duration: 15 });
  res.redirect('/dashboard');
});

// ---------- Risk ----------
r.get('/risk', (req, res) => {
  const list = risk.riskyNumbers(req.seller.id);
  page(req, res, 'রিস্ক', `
<h2>⚠ ঝুঁকিপূর্ণ নম্বর</h2>
<p class="muted">যেসব নম্বর বারবার বাতিল করে বা কখনো কল ধরে না (সব সেলারের অর্ডার মিলিয়ে)। এদের অর্ডারে অগ্রিম ডেলিভারি চার্জ নিন।</p>
<table class="orders"><thead><tr><th>নম্বর</th><th>মোট অর্ডার</th><th>কনফার্মড</th><th>বাতিল</th><th>ধরেনি</th></tr></thead><tbody>
${list.map((s) => `<tr><td class="mono">${esc(s.phone)}</td><td>${toBnDigits(s.total)}</td><td>${toBnDigits(s.confirmed)}</td><td>${toBnDigits(s.cancelled)}</td><td>${toBnDigits(s.no_answer)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">এখনো কোনো ঝুঁকিপূর্ণ নম্বর নেই</td></tr>'}
</tbody></table>`);
});

// ---------- Billing ----------
r.get('/billing', (req, res) => {
  const b = billing.summary(req.seller.id);
  const ledger = db.get().prepare("SELECT * FROM ledger WHERE seller_id=? AND kind != 'free_call' ORDER BY id DESC LIMIT 50").all(req.seller.id);
  page(req, res, 'ক্রেডিট', `
<div class="stats">
  <div class="card stat"><b>${toBnDigits(b.freeLeft)}/${toBnDigits(b.freeTotal)}</b>এই মাসের ফ্রি কল বাকি</div>
  <div class="card stat"><b>${toBnDigits(b.credits)}</b>ক্রেডিট ব্যালেন্স</div>
  <div class="card stat"><b>${toBnDigits(config.creditsPerCall)}</b>প্রতি কলে ক্রেডিট</div>
</div>
<div class="card narrow">
  <h3>bKash দিয়ে রিচার্জ</h3>
  <ol>
    <li>bKash অ্যাপ থেকে <b>${esc(process.env.BKASH_MERCHANT_NUMBER || '01XXXXXXXXX')}</b> নম্বরে Payment করুন</li>
    <li>Reference এ লিখুন: <b class="mono">CVR${req.seller.id}</b></li>
    <li>TrxID নিচে দিন। ভেরিফাই হলে ক্রেডিট যোগ হবে (১ ক্রেডিট = ${toBnDigits(config.takaPerCredit)} টাকা)।</li>
  </ol>
  <form method="post" action="/billing/topup-request">
    <label>টাকার পরিমাণ<input name="amount" type="number" min="50" required></label>
    <label>bKash TrxID<input name="trx_id" required></label>
    <button class="btn">জমা দিন</button>
  </form>
</div>
<h3>লেনদেন</h3>
<table class="orders"><thead><tr><th>তারিখ</th><th>ধরন</th><th>ক্রেডিট</th><th>রেফ</th></tr></thead><tbody>
${ledger.map((l) => `<tr><td>${esc(l.created_at)}</td><td>${esc(l.kind)}</td><td>${l.credits}</td><td class="mono">${esc(l.ref)}</td></tr>`).join('')}
</tbody></table>`);
});

r.post('/billing/topup-request', (req, res) => {
  const trx = String(req.body.trx_id || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(trx)) return back(res, '/billing', 'err', 'TrxID সঠিক নয়');
  require('../services/notify').notify(req.seller.id, null, `রিচার্জ রিকোয়েস্ট জমা হয়েছে: ${req.body.amount} টাকা, TrxID ${trx}। ভেরিফাই হলে ক্রেডিট যোগ হবে।`);
  console.log(`[billing] top-up request seller=${req.seller.id} amount=${req.body.amount} trx=${trx}`);
  back(res, '/billing', 'ok', 'রিকোয়েস্ট জমা হয়েছে। ভেরিফাই হলে ক্রেডিট যোগ হবে।');
});

// ---------- Settings ----------
r.get('/settings', (req, res) => {
  const s = req.seller;
  const hook = (p) => `${config.baseUrl}/webhooks/${p}/${s.webhook_token}`;
  page(req, res, 'সেটিংস', `
<form method="post" action="/settings" class="card narrow">
  <h2>পেজ ও ভয়েস</h2>
  <label>পেজের নাম<input name="page_name" value="${esc(s.page_name)}" required></label>
  <label>আপনার মোবাইল (৩ চাপলে ফরওয়ার্ড)<input name="phone" value="${esc(s.phone || '')}"></label>
  <label>ভয়েস
    <select name="voice_mode">
      <option value="tts" ${s.voice_mode === 'tts' ? 'selected' : ''}>বাংলা TTS</option>
      <option value="recorded" ${s.voice_mode === 'recorded' ? 'selected' : ''}>আমার রেকর্ড করা গলা (শুভেচ্ছা অংশ)</option>
    </select></label>
  <label>রেকর্ড করা অডিওর লিংক (MP3, পাবলিক URL)<input name="recorded_intro_url" value="${esc(s.recorded_intro_url || '')}"></label>

  <h2>Google Sheet</h2>
  <p class="muted">Sheet → File → Share → Publish to web → CSV লিংক দিন। কলাম: order_id, name, phone, product, amount, address। প্রতি ${toBnDigits(config.sheetSyncIntervalMin)} মিনিটে সিঙ্ক হয়।</p>
  <label>CSV লিংক<input name="sheet_csv_url" value="${esc(s.sheet_csv_url || '')}"></label>
  ${s.sheet_last_sync ? `<p class="muted">শেষ সিঙ্ক: ${esc(s.sheet_last_sync)}</p>` : ''}

  <h2>কুরিয়ার</h2>
  <label>কুরিয়ার
    <select name="courier"><option value="">—</option>
      ${['steadfast', 'pathao', 'redx'].map((c) => `<option value="${c}" ${s.courier === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select></label>
  <label>ক্রেডেনশিয়াল (JSON)<textarea name="courier_config" rows="4" placeholder='{"api_key":"...","secret_key":"..."}'>${esc(s.courier_config || '')}</textarea></label>
  <button class="btn">সেভ</button>
</form>
<form method="post" action="/settings/sync" class="card narrow"><button class="btn ghost">এখনই শিট সিঙ্ক করুন</button></form>
<div class="card narrow">
  <h2>Webhook</h2>
  <p><b>WooCommerce</b> (Settings → Advanced → Webhooks, Topic: Order created):<br><code>${esc(hook('woocommerce'))}</code></p>
  <p><b>Shopify</b> (Settings → Notifications → Webhooks, Order creation, JSON):<br><code>${esc(hook('shopify'))}</code></p>
  <p><b>API</b> <code>POST ${esc(config.baseUrl)}/api/orders</code> header <code>X-Api-Key: ${esc(s.webhook_token)}</code></p>
  <form method="post" action="/settings/secrets">
    <label>WooCommerce webhook secret<input name="woo_secret" value="${esc(s.woo_secret || '')}"></label>
    <label>Shopify webhook signing secret<input name="shopify_secret" value="${esc(s.shopify_secret || '')}"></label>
    <button class="btn ghost">সেভ</button>
  </form>
</div>`);
});

r.post('/settings', (req, res) => {
  const b = req.body;
  if (b.courier_config) { try { JSON.parse(b.courier_config); } catch { return back(res, '/settings', 'err', 'কুরিয়ার JSON ভুল'); } }
  if (b.sheet_csv_url && !/^https:\/\//.test(b.sheet_csv_url)) return back(res, '/settings', 'err', 'Sheet লিংক https:// দিয়ে শুরু হতে হবে');
  const { normalizeBdPhone } = require('../util');
  db.get().prepare(`UPDATE sellers SET page_name=?, phone=?, voice_mode=?, recorded_intro_url=?, sheet_csv_url=?, courier=?, courier_config=? WHERE id=?`)
    .run(b.page_name || req.seller.page_name, normalizeBdPhone(b.phone), b.voice_mode === 'recorded' ? 'recorded' : 'tts',
      b.recorded_intro_url || null, b.sheet_csv_url || null, b.courier || null, b.courier_config || null, req.seller.id);
  back(res, '/settings', 'ok', 'সেভ হয়েছে');
});

r.post('/settings/secrets', (req, res) => {
  db.get().prepare('UPDATE sellers SET woo_secret=?, shopify_secret=? WHERE id=?').run(req.body.woo_secret || null, req.body.shopify_secret || null, req.seller.id);
  back(res, '/settings', 'ok', 'সেভ হয়েছে');
});

r.post('/settings/sync', async (req, res) => {
  try {
    const out = await sheets.syncSeller(req.seller);
    if (!out) return back(res, '/settings', 'err', 'আগে Sheet লিংক দিন');
    back(res, '/dashboard', 'ok', `শিট সিঙ্ক: নতুন ${out.created}, আগে ছিল ${out.skipped}${out.errors.length ? `, ভুল ${out.errors.length}` : ''}`);
  } catch (e) { back(res, '/settings', 'err', e.message); }
});

module.exports = r;
