'use strict';
process.env.DB_PATH = ':memory:';
process.env.VOICE_PROVIDER = 'mock';
process.env.MOCK_AUTO_ANSWER = '';
process.env.FREE_CALLS_PER_MONTH = '2';
process.env.COURIER_DRY_RUN = '1';
process.env.ADMIN_TOKEN = 'admintok';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
db.open(':memory:');
const util = require('../src/util');
const { createOrder } = require('../src/services/orders');
const calls = require('../src/services/calls');
const billing = require('../src/services/billing');
const sheets = require('../src/services/sheets');
const risk = require('../src/services/risk');
const { buildScript } = require('../src/voice/ivr');
const mock = require('../src/voice/mock');
const { createApp } = require('../src/app');

const seller = (n = 1) => {
  const id = db.get().prepare('INSERT INTO sellers (email,password_hash,page_name,phone,webhook_token) VALUES (?,?,?,?,?)')
    .run(`s${n}-${Math.random()}@x.com`, util.hashPassword('secret1'), 'রঙিন শাড়ি', '+8801711111111', `tok${n}${Math.random()}`).lastInsertRowid;
  return db.get().prepare('SELECT * FROM sellers WHERE id=?').get(id);
};
const order = (id) => db.get().prepare('SELECT * FROM orders WHERE id=?').get(id);
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
  const night = new Date('2026-11-19T16:30:00Z'); // 22:30 Dhaka
  assert.equal(util.clampToCallWindow(night).toISOString(), '2026-11-20T03:00:00.000Z');
  const early = new Date('2026-11-19T00:00:00Z'); // 06:00 Dhaka
  assert.equal(util.clampToCallWindow(early).toISOString(), '2026-11-19T03:00:00.000Z');
  assert.equal(util.clampToCallWindow(DAY).toISOString(), DAY.toISOString());
});

test('IVR script contains page, product and Bangla amount', () => {
  const s = buildScript({ page_name: 'রঙিন শাড়ি', phone: '+8801711111111', voice_mode: 'tts' }, { product: 'জামদানি', amount: 1250 });
  assert.match(s.text, /রঙিন শাড়ি থেকে বলছি/);
  assert.match(s.text, /জামদানি অর্ডার করেছেন, মোট ১,২৫০ টাকা/);
  assert.equal(s.onDigit[3].action, 'forward');
  assert.equal(s.onDigit[3].to, '+8801711111111');
});

test('full flow: call, retry 30m then 2h, then no_answer', async () => {
  const s = seller();
  const { order: o } = createOrder(s.id, { phone: '01712345678', product: 'শার্ট', amount: 800 }, DAY);
  assert.equal(o.status, 'pending');

  await calls.tick(DAY); // not due yet (2 min delay)
  assert.equal(order(o.id).status, 'pending');

  let t = new Date(DAY.getTime() + 3 * 60e3);
  await calls.tick(t);
  assert.equal(order(o.id).status, 'calling');
  let call = db.get().prepare('SELECT * FROM calls WHERE order_id=? ORDER BY id DESC').get(o.id);
  await calls.handleCallResult({ call_id: call.id, status: 'no_answer' }, t);
  let ord = order(o.id);
  assert.equal(ord.status, 'pending');
  assert.equal(new Date(ord.next_call_at).getTime() - t.getTime(), 30 * 60e3);

  t = new Date(ord.next_call_at);
  await calls.tick(t);
  call = db.get().prepare('SELECT * FROM calls WHERE order_id=? ORDER BY id DESC').get(o.id);
  await calls.handleCallResult({ call_id: call.id, status: 'busy' }, t);
  ord = order(o.id);
  assert.equal(new Date(ord.next_call_at).getTime() - t.getTime(), 120 * 60e3);

  t = new Date(ord.next_call_at);
  await calls.tick(t);
  call = db.get().prepare('SELECT * FROM calls WHERE order_id=? ORDER BY id DESC').get(o.id);
  await calls.handleCallResult({ call_id: call.id, status: 'no_answer' }, t);
  assert.equal(order(o.id).status, 'no_answer');
  assert.equal(order(o.id).attempts, 3);
});

async function callAndPress(s, digit, phone = '01812345678') {
  const { order: o } = createOrder(s.id, { phone, product: 'ঘড়ি', amount: 1500 }, DAY);
  await calls.placeCallForOrder(order(o.id), DAY);
  const call = db.get().prepare('SELECT * FROM calls WHERE order_id=? ORDER BY id DESC').get(o.id);
  if (call) await calls.handleCallResult({ call_id: call.id, status: 'answered', dtmf: digit }, DAY);
  return { o: order(o.id), call };
}

test('dtmf 1 confirms, 2 cancels, 3 requests callback + notifies; duplicate callback ignored', async () => {
  const s = seller();
  billing.topUp(s.id, 30, 'TRXDTMF01');
  assert.equal((await callAndPress(s, '1')).o.status, 'confirmed');
  assert.equal((await callAndPress(s, '2')).o.status, 'cancelled');
  const { o, call } = await callAndPress(s, '3');
  assert.equal(o.status, 'callback');
  assert.ok(db.get().prepare('SELECT * FROM notifications WHERE order_id=?').get(o.id));
  const dup = await calls.handleCallResult({ call_id: call.id, status: 'answered', dtmf: '2' });
  assert.equal(dup.duplicate, true);
  assert.equal(order(o.id).status, 'callback');
  assert.ok(mock.placed.length > 0);
});

test('invalid phone goes straight to wrong_number; provider invalid_number too', async () => {
  const s = seller();
  assert.equal(createOrder(s.id, { phone: '123', product: 'x', amount: 1 }).order.status, 'wrong_number');
  const { order: o } = createOrder(s.id, { phone: '01912345678', product: 'x', amount: 1 }, DAY);
  await calls.placeCallForOrder(order(o.id), DAY);
  const call = db.get().prepare('SELECT * FROM calls WHERE order_id=?').get(o.id);
  await calls.handleCallResult({ call_id: call.id, status: 'invalid_number' });
  assert.equal(order(o.id).status, 'wrong_number');
});

test('billing: free tier, then credits, then no_credit pause; topup idempotent', async () => {
  const s = seller();
  await callAndPress(s, '1'); // free 1
  await callAndPress(s, '1'); // free 2
  assert.equal(billing.summary(s.id).freeLeft, 0);
  const { o } = await callAndPress(s, '1'); // no credit -> paused
  assert.equal(o.status, 'no_credit');

  assert.equal(billing.topUp(s.id, 15, 'TRX123ABC'), true);
  assert.equal(billing.topUp(s.id, 15, 'TRX123ABC'), false);
  assert.equal(billing.summary(s.id).credits, 10);
  await callAndPress(s, '1');
  assert.equal(billing.summary(s.id).credits, 9);
});

test('sheet CSV import is idempotent and maps Bangla headers', () => {
  const s = seller();
  const csv = 'অর্ডার,নাম,মোবাইল,প্রোডাক্ট,দাম,ঠিকানা\n101,করিম,01711000001,"পাঞ্জাবি, নীল",1200,ঢাকা\n102,রহিম,01711000002,শাড়ি,2500,খুলনা\n';
  assert.deepEqual(sheets.importCsv(s.id, csv), { created: 2, skipped: 0, errors: [] });
  assert.deepEqual(sheets.importCsv(s.id, csv), { created: 0, skipped: 2, errors: [] });
  const o = db.get().prepare("SELECT * FROM orders WHERE seller_id=? AND external_id='101'").get(s.id);
  assert.equal(o.product, 'পাঞ্জাবি, নীল');
  assert.equal(o.amount, 1200);
});

test('risk flags numbers that cancel repeatedly', async () => {
  const s = seller();
  await callAndPress(s, '2', '01555555555');
  await callAndPress(s, '2', '01555555555');
  const st = risk.phoneStats(['+8801555555555'])['+8801555555555'];
  assert.equal(st.risky, true);
});

// ---------- HTTP ----------
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('HTTP: signup, dashboard, woo webhook with signature, api, voice callback, admin topup', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/signup`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.com', password: 'secret1', page_name: 'টেস্ট পেজ', phone: '01711111111' }),
    });
    assert.equal(res.status, 302);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    res = await fetch(`${base}/dashboard`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /কনফার্মড/);

    const s = db.get().prepare("SELECT * FROM sellers WHERE email='a@b.com'").get();
    db.get().prepare("UPDATE sellers SET woo_secret='wsec' WHERE id=?").run(s.id);
    const body = JSON.stringify({ id: 555, total: '990.00', billing: { first_name: 'Rahim', phone: '01711222333', address_1: 'Mirpur' }, line_items: [{ name: 'Shoe', quantity: 2 }] });
    res = await fetch(`${base}/webhooks/woocommerce/${s.webhook_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Signature': 'bad' }, body });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/webhooks/woocommerce/${s.webhook_token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Signature': util.hmac('wsec', body, 'base64') }, body,
    });
    assert.equal(res.status, 201);
    const { order_id } = await res.json();
    assert.equal(order(order_id).product, 'Shoe 2টি');

    res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': s.webhook_token }, body: JSON.stringify({ phone: '01711999888', product: 'Bag', amount: 700, external_id: 'A1' }) });
    assert.equal(res.status, 201);
    const apiOrder = (await res.json()).order_id;

    await calls.placeCallForOrder(order(apiOrder), DAY);
    const call = db.get().prepare('SELECT * FROM calls WHERE order_id=?').get(apiOrder);
    res = await fetch(`${base}/voice/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_id: call.id, status: 'answered', dtmf: '1' }) });
    assert.equal(res.status, 200);
    assert.equal(order(apiOrder).status, 'confirmed');

    res = await fetch(`${base}/orders/${apiOrder}/courier`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal(order(apiOrder).courier_status, 'failed'); // no courier configured yet
    db.get().prepare("UPDATE sellers SET courier='steadfast' WHERE id=?").run(s.id);
    res = await fetch(`${base}/orders/${apiOrder}/courier`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal(order(apiOrder).courier_ref, `DRY-steadfast-${apiOrder}`);

    res = await fetch(`${base}/admin/topup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admintok' }, body: JSON.stringify({ seller_id: `CVR${s.id}`, amount: 150, trx_id: 'BK1' }) });
    assert.deepEqual(await res.json(), { ok: true, credited: true, balance: 100 });

    // other seller cannot touch this order
    const other = seller(9);
    const auth = require('../src/auth');
    res = await fetch(`${base}/orders/${apiOrder}/recall`, { method: 'POST', headers: { cookie: `cvr_session=${auth.sign(other.id)}` } });
    assert.equal(res.status, 404);
  });
});
