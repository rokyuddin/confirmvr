'use strict';
// Runs on SQLite by default. Set TEST_DATABASE_URL=postgres://... to run the same suite on Postgres.
process.env.DB_PATH = ':memory:';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
process.env.VOICE_PROVIDER = 'mock';
process.env.MOCK_AUTO_ANSWER = '';
process.env.FREE_CALLS_PER_MONTH = '2';
process.env.COURIER_DRY_RUN = '1';
process.env.ADMIN_TOKEN = 'admintok';
process.env.CRON_SECRET = 'cronsec';
process.env.OPENROUTER_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const util = require('../src/util');
const { createOrder } = require('../src/services/orders');
const calls = require('../src/services/calls');
const billing = require('../src/services/billing');
const sheets = require('../src/services/sheets');
const risk = require('../src/services/risk');
const { buildScript } = require('../src/voice/ivr');
const { creditsForPayment } = require('../src/pricing');
const mock = require('../src/voice/mock');
const { createApp } = require('../src/app');

const PG = process.env.TEST_DATABASE_URL;

test.before(async () => {
  if (PG) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query('DROP TABLE IF EXISTS tts_cache, topup_requests, webhook_events, notifications, ledger, calls, orders, sellers CASCADE');
    await c.end();
  }
  await db.init({ url: PG || '', file: ':memory:', force: true });
});
test.after(() => db.close());

let n = 0;
async function seller(extra = {}) {
  n++;
  const id = await db.insert('INSERT INTO sellers (email,password_hash,page_name,phone,webhook_token,created_at) VALUES (?,?,?,?,?,?)',
    [`s${n}@x.com`, util.hashPassword('secret1'), 'রঙিন শাড়ি', '+8801711111111', `tok${n}`, db.now()]);
  for (const [k, v] of Object.entries(extra)) await db.run(`UPDATE sellers SET ${k}=? WHERE id=?`, [v, id]);
  return db.one('SELECT * FROM sellers WHERE id=?', [id]);
}
const order = (id) => db.one('SELECT * FROM orders WHERE id=?', [id]);
const lastCall = (orderId) => db.one('SELECT * FROM calls WHERE order_id=? ORDER BY id DESC', [orderId]);
// 11:00 Dhaka = 05:00 UTC
const DAY = new Date('2026-11-19T05:00:00Z');

test('phone normalization', () => {
  assert.equal(util.normalizeBdPhone('01711-234567'), '+8801711234567');
  assert.equal(util.normalizeBdPhone('+880 1811234567'), '+8801811234567');
  assert.equal(util.normalizeBdPhone('০১৯১১২৩৪৫৬৭'), '+8801911234567');
  assert.equal(util.normalizeBdPhone('1711234567'), '+8801711234567');
  assert.equal(util.normalizeBdPhone('01211234567'), null);
  assert.equal(util.normalizeBdPhone('12345'), null);
});

test('bangla taka formatting', () => {
  assert.equal(util.bnTaka(1250), '১,২৫০ টাকা');
  assert.equal(util.bnTaka(125000), '১,২৫,০০০ টাকা');
  assert.equal(util.bnTaka(99), '৯৯ টাকা');
});

test('call window clamps night orders to next morning 9am Dhaka', () => {
  assert.equal(util.clampToCallWindow(new Date('2026-11-19T16:30:00Z')).toISOString(), '2026-11-20T03:00:00.000Z');
  assert.equal(util.clampToCallWindow(new Date('2026-11-19T00:00:00Z')).toISOString(), '2026-11-19T03:00:00.000Z');
  assert.equal(util.clampToCallWindow(DAY).toISOString(), DAY.toISOString());
});

test('IVR script uses spoken product when available', () => {
  const s = buildScript({ page_name: 'রঙিন শাড়ি', phone: '+8801711111111', voice_mode: 'tts' }, { product: 'Jamdani x1', product_spoken: 'একটা জামদানি', amount: 1250 });
  assert.match(s.text, /রঙিন শাড়ি থেকে বলছি/);
  assert.match(s.text, /একটা জামদানি অর্ডার করেছেন, মোট ১,২৫০ টাকা/);
  assert.equal(s.onDigit[3].action, 'forward');
});

test('pricing: pack price gets pack credits, other amounts base rate', () => {
  assert.equal(creditsForPayment(1500), 1400);
  assert.equal(creditsForPayment(150), 100);
});

test('full flow: call, retry 30m then 2h, then no_answer', async () => {
  const s = await seller();
  const { order: o } = await createOrder(s.id, { phone: '01712345678', product: 'শার্ট', amount: 800 }, DAY);
  assert.equal(o.status, 'pending');

  await calls.tick(DAY); // not due yet (2 min delay)
  assert.equal((await order(o.id)).status, 'pending');

  let t = new Date(DAY.getTime() + 3 * 60e3);
  assert.equal((await calls.tick(t)).placed, 1);
  assert.equal((await order(o.id)).status, 'calling');
  await calls.handleCallResult({ call_id: (await lastCall(o.id)).id, status: 'no_answer' }, t);
  let ord = await order(o.id);
  assert.equal(ord.status, 'pending');
  assert.equal(new Date(ord.next_call_at) - t, 30 * 60e3);

  t = new Date(ord.next_call_at);
  await calls.tick(t);
  await calls.handleCallResult({ call_id: (await lastCall(o.id)).id, status: 'busy' }, t);
  ord = await order(o.id);
  assert.equal(new Date(ord.next_call_at) - t, 120 * 60e3);

  t = new Date(ord.next_call_at);
  await calls.tick(t);
  await calls.handleCallResult({ call_id: (await lastCall(o.id)).id, status: 'no_answer' }, t);
  assert.equal((await order(o.id)).status, 'no_answer');
  assert.equal((await order(o.id)).attempts, 3);
});

test('stale calls with no provider callback are treated as no-answer', async () => {
  const s = await seller();
  const { order: o } = await createOrder(s.id, { phone: '01712345670', product: 'x', amount: 1 }, DAY);
  await calls.placeCallForOrder(await order(o.id), DAY);
  await calls.tick(new Date(DAY.getTime() + 16 * 60e3));
  assert.equal((await lastCall(o.id)).status, 'no_answer');
  assert.equal((await order(o.id)).status, 'pending');
});

test('concurrent ticks never double-dial the same order', async () => {
  const s = await seller();
  const { order: o } = await createOrder(s.id, { phone: '01712345671', product: 'x', amount: 1 }, DAY);
  const fresh = await order(o.id);
  await Promise.all([calls.placeCallForOrder(fresh, DAY), calls.placeCallForOrder({ ...fresh }, DAY)]);
  const { n: count } = await db.one('SELECT COUNT(*) AS n FROM calls WHERE order_id=?', [o.id]);
  assert.equal(count, 1);
});

async function callAndPress(s, digit, phone = '01812345678') {
  const { order: o } = await createOrder(s.id, { phone, product: 'ঘড়ি', amount: 1500 }, DAY);
  await calls.placeCallForOrder(await order(o.id), DAY);
  const call = await lastCall(o.id);
  if (call) await calls.handleCallResult({ call_id: call.id, status: 'answered', dtmf: digit }, DAY);
  return { o: await order(o.id), call };
}

test('dtmf 1 confirms, 2 cancels, 3 requests callback + notifies; duplicate callback ignored', async () => {
  const s = await seller();
  await billing.topUp(s.id, 30, 'TRXDTMF01');
  assert.equal((await callAndPress(s, '1')).o.status, 'confirmed');
  assert.equal((await callAndPress(s, '2')).o.status, 'cancelled');
  const { o, call } = await callAndPress(s, '3');
  assert.equal(o.status, 'callback');
  assert.ok(await db.one('SELECT * FROM notifications WHERE order_id=?', [o.id]));
  const dup = await calls.handleCallResult({ call_id: call.id, status: 'answered', dtmf: '2' });
  assert.equal(dup.duplicate, true);
  assert.equal((await order(o.id)).status, 'callback');
  assert.ok(mock.placed.length > 0);
});

test('invalid phone goes straight to wrong_number; provider invalid_number too', async () => {
  const s = await seller();
  assert.equal((await createOrder(s.id, { phone: '123', product: 'x', amount: 1 })).order.status, 'wrong_number');
  const { order: o } = await createOrder(s.id, { phone: '01912345678', product: 'x', amount: 1 }, DAY);
  await calls.placeCallForOrder(await order(o.id), DAY);
  await calls.handleCallResult({ call_id: (await lastCall(o.id)).id, status: 'invalid_number' });
  assert.equal((await order(o.id)).status, 'wrong_number');
});

test('billing: free tier, then credits, then no_credit pause; topup idempotent', async () => {
  const s = await seller();
  await callAndPress(s, '1');
  await callAndPress(s, '1');
  assert.equal((await billing.summary(s.id)).freeLeft, 0);
  const { o } = await callAndPress(s, '1');
  assert.equal(o.status, 'no_credit');

  assert.equal(await billing.topUp(s.id, 15, 'TRX123ABC'), true);
  assert.equal(await billing.topUp(s.id, 15, 'trx123abc'), false);
  assert.equal((await billing.summary(s.id)).credits, 10);
  await callAndPress(s, '1');
  assert.equal((await billing.summary(s.id)).credits, 9);
});

test('sheet CSV import (with BOM, Bangla headers) is idempotent', async () => {
  const s = await seller();
  const csv = '﻿অর্ডার,নাম,মোবাইল,প্রোডাক্ট,দাম,ঠিকানা\n101,করিম,01711000001,"পাঞ্জাবি, নীল",1200,ঢাকা\n102,রহিম,01711000002,শাড়ি,২৫০০,খুলনা\n';
  assert.deepEqual(await sheets.importCsv(s.id, csv), { created: 2, skipped: 0, errors: [] });
  assert.deepEqual(await sheets.importCsv(s.id, csv), { created: 0, skipped: 2, errors: [] });
  const o = await db.one("SELECT * FROM orders WHERE seller_id=? AND external_id='101'", [s.id]);
  assert.equal(o.product, 'পাঞ্জাবি, নীল');
  assert.equal((await db.one("SELECT amount FROM orders WHERE seller_id=? AND external_id='102'", [s.id])).amount, 2500);
});

test('risk flags numbers that cancel repeatedly', async () => {
  const s = await seller();
  await billing.topUp(s.id, 30, 'TRXRISK01');
  await callAndPress(s, '2', '01555555555');
  await callAndPress(s, '2', '01555555555');
  assert.equal((await risk.phoneStats(['+8801555555555']))['+8801555555555'].risky, true);
});

test('steadfast client: booking payload, inner-status errors, duplicate detection', async () => {
  const steadfast = require('../src/services/steadfast');
  const seen = [];
  const fake = (status, body) => async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  let sf = steadfast.client({ api_key: 'k', secret_key: 's' }, {
    fetchImpl: fake(200, { status: 200, consignment: { consignment_id: 77, tracking_code: 'AB12', status: 'in_review' } }),
  });
  const cons = await sf.createOrder({ invoice: 'CVR-1', recipient_name: 'Rahim<b>', recipient_phone: '+8801711222333', recipient_address: 'Mirpur 10, Dhaka', cod_amount: 1250.4 });
  assert.equal(cons.consignment_id, 77);
  const sent = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url, 'https://portal.packzy.com/api/v1/create_order');
  assert.equal(seen[0].init.headers['Api-Key'], 'k');
  assert.equal(sent.recipient_phone, '01711222333');
  assert.equal(sent.cod_amount, 1250);
  assert.equal(sent.recipient_name, 'Rahim b');

  sf = steadfast.client({ api_key: 'k', secret_key: 's' }, { fetchImpl: fake(200, { status: 400, errors: { invoice: ['The invoice has already been taken.'] } }) });
  await assert.rejects(sf.createOrder({ invoice: 'CVR-1', recipient_phone: '01711222333', recipient_address: 'Dhaka x', cod_amount: 1 }), /already been taken/);
  await assert.rejects(sf.createOrder({ invoice: 'bad invoice!', recipient_phone: '01711222333', recipient_address: 'Dhaka', cod_amount: 1 }), (e) => e.kind === 'validation');
});

// ---------- HTTP ----------
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('HTTP: signup, pages, woo webhook, api, voice callback, courier, steadfast webhook, cron, admin topup', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/pricing`);
    assert.match(await res.text(), /গ্রোথ/);

    res = await fetch(`${base}/signup`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.com', password: 'secret1', page_name: 'টেস্ট পেজ', phone: '01711111111' }),
    });
    assert.equal(res.status, 302);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    for (const p of ['/dashboard', '/orders/new', '/risk', '/billing', '/settings']) {
      res = await fetch(base + p, { headers: { cookie } });
      assert.equal(res.status, 200, p);
    }

    const s = await db.one("SELECT * FROM sellers WHERE email='a@b.com'");
    await db.run("UPDATE sellers SET woo_secret='wsec' WHERE id=?", [s.id]);
    const body = JSON.stringify({ id: 555, total: '990.00', billing: { first_name: 'Rahim', phone: '01711222333', address_1: 'Mirpur' }, line_items: [{ name: 'Shoe', quantity: 2 }] });
    res = await fetch(`${base}/webhooks/woocommerce/${s.webhook_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Signature': 'bad' }, body });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/webhooks/woocommerce/${s.webhook_token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Signature': util.hmac('wsec', body, 'base64') }, body,
    });
    assert.equal(res.status, 201);
    assert.equal((await order((await res.json()).order_id)).product, 'Shoe 2টি');

    res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': s.webhook_token }, body: JSON.stringify({ phone: '01711999888', product: 'Bag', amount: 700, external_id: 'A1', address: 'Dhanmondi, Dhaka' }) });
    assert.equal(res.status, 201);
    const apiOrder = (await res.json()).order_id;

    // cron requires the secret
    assert.equal((await fetch(`${base}/api/cron/tick`)).status, 401);
    assert.equal((await fetch(`${base}/api/cron/tick`, { headers: { Authorization: 'Bearer cronsec' } })).status, 200);

    await calls.placeCallForOrder(await order(apiOrder), DAY);
    const call = await lastCall(apiOrder);
    res = await fetch(`${base}/voice/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_id: call.id, status: 'answered', dtmf: '1' }) });
    assert.equal(res.status, 200);
    assert.equal((await order(apiOrder)).status, 'confirmed');

    await fetch(`${base}/orders/${apiOrder}/courier`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal((await order(apiOrder)).courier_status, 'failed'); // no courier configured yet
    await db.run("UPDATE sellers SET courier='steadfast', steadfast_webhook_token='sftok' WHERE id=?", [s.id]);
    await fetch(`${base}/orders/${apiOrder}/courier`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal((await order(apiOrder)).courier_ref, `DRY-steadfast-${apiOrder}`);

    // Steadfast delivery webhook: auth + update + idempotency
    const sfBody = JSON.stringify({ notification_type: 'delivery_status', consignment_id: 1, invoice: `CVR-${apiOrder}`, status: 'delivered', cod_amount: 700 });
    res = await fetch(`${base}/webhooks/steadfast/${s.webhook_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: sfBody });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/webhooks/steadfast/${s.webhook_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sftok', 'Idempotency-Key': 'ev1' }, body: sfBody });
    assert.equal(res.status, 200);
    assert.equal((await order(apiOrder)).courier_delivery_status, 'delivered');
    res = await fetch(`${base}/webhooks/steadfast/${s.webhook_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sftok', 'Idempotency-Key': 'ev1' }, body: sfBody });
    assert.equal((await res.json()).message, 'duplicate');

    res = await fetch(`${base}/admin/topup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admintok' }, body: JSON.stringify({ seller_id: `CVR${s.id}`, amount: 500, trx_id: 'BK1' }) });
    assert.deepEqual(await res.json(), { ok: true, credited: true, balance: 400 });

    // another seller cannot touch this order
    const other = await seller();
    const auth = require('../src/auth');
    res = await fetch(`${base}/orders/${apiOrder}/recall`, { method: 'POST', headers: { cookie: `cvr_session=${auth.sign(other.id)}` } });
    assert.equal(res.status, 404);
  });
});

test('Azure TTS: prompts become cached audio URLs, synthesized once per text', async () => {
  const config = require('../src/config');
  const tts = require('../src/services/tts');
  Object.assign(config, { azureSpeechKey: 'k', azureSpeechRegion: 'southeastasia' });
  try {
    let hits = 0;
    const fetchImpl = async (url, init) => {
      hits++;
      assert.equal(url, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1');
      assert.match(init.body, /bn-BD-NabanitaNeural/);
      assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'k');
      return new Response(Buffer.from('ID3fakeaudio'), { status: 200 });
    };
    const script = buildScript({ page_name: 'পেজ', phone: null, voice_mode: 'tts' }, { product: 'শাড়ি', amount: 900 });
    const out = await tts.resolveScript(script, { fetchImpl });
    assert.ok(out.prompts.every((p) => p.type === 'audio' && /\/tts\/[a-f0-9]{32}\.mp3$/.test(p.url)));
    const firstHits = hits;
    await tts.resolveScript(script, { fetchImpl });
    assert.equal(hits, firstHits); // all cached
    const clip = await tts.getClip(out.prompts[0].url.match(/([a-f0-9]{32})/)[1]);
    assert.equal(clip.audio.toString(), 'ID3fakeaudio');

    // Azure down -> falls back to text prompts
    const down = await tts.resolveScript(buildScript({ page_name: 'অন্য', voice_mode: 'tts' }, { product: 'নতুন', amount: 1 }),
      { fetchImpl: async () => new Response('err', { status: 500 }) });
    assert.ok(down.prompts.some((p) => p.type === 'tts'));
  } finally {
    Object.assign(config, { azureSpeechKey: '', azureSpeechRegion: '' });
  }
});

test('top-up requests: submit, duplicate rejected, approve credits once and releases paused orders', async () => {
  const topups = require('../src/services/topups');
  const s = await seller();
  assert.equal((await topups.submit(s.id, 500, 'abc12345')).ok, true);
  assert.equal((await topups.submit(s.id, 500, 'ABC12345')).ok, false);
  assert.equal((await topups.submit(s.id, 500, 'x')).ok, false);
  const { order: o } = await createOrder(s.id, { phone: '01712345690', product: 'x', amount: 1 }, DAY);
  await db.run(`UPDATE orders SET status='no_credit', next_call_at=NULL WHERE id=?`, [o.id]);
  const req = await db.one('SELECT * FROM topup_requests WHERE seller_id=?', [s.id]);
  assert.equal(await topups.approve(req.id), true);
  assert.equal((await billing.summary(s.id)).credits, 400); // starter pack
  assert.equal((await order(o.id)).status, 'pending');
  await assert.rejects(topups.approve(req.id), /আগেই/);
});

test('admin panel: login required, approve request via HTTP', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/admin`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    res = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=wrong' });
    assert.match(res.headers.get('location'), /err=/);
    res = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=admintok' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    for (const p of ['/admin', '/admin/sellers', '/admin/stats']) {
      res = await fetch(base + p, { headers: { cookie } });
      assert.equal(res.status, 200, p);
    }
    const s = await seller();
    const topups = require('../src/services/topups');
    await topups.submit(s.id, 150, 'HTTPTRX01');
    const req = await db.one("SELECT * FROM topup_requests WHERE trx_id='HTTPTRX01'");
    assert.match(await (await fetch(`${base}/admin`, { headers: { cookie } })).text(), /HTTPTRX01/);
    await fetch(`${base}/admin/topups/${req.id}/approve`, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'amount=150' });
    assert.equal((await billing.summary(s.id)).credits, 100);
    await fetch(`${base}/admin/sellers/${s.id}/adjust`, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'credits=-10&reason=test' });
    assert.equal((await billing.summary(s.id)).credits, 90);
  });
});
