'use strict';
/** Machine-facing routes: store webhooks, public API, voice callback, Steadfast webhook, cron, admin. */
const express = require('express');
const db = require('../db');
const config = require('../config');
const billing = require('../services/billing');
const calls = require('../services/calls');
const sheets = require('../services/sheets');
const topups = require('../services/topups');
const { createOrder } = require('../services/orders');
const { notify } = require('../services/notify');
const { hmac, safeEqual } = require('../util');

const r = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sellerByToken = (t) => db.one('SELECT * FROM sellers WHERE webhook_token=?', [String(t || '')]);
const items = (lines = []) => lines.map((l) => (l.quantity > 1 ? `${l.name} ${l.quantity}টি` : l.name)).join(', ') || 'প্রোডাক্ট';

async function respond(res, fn) {
  try {
    const { order, created } = await fn();
    res.status(created ? 201 : 200).json({ ok: true, order_id: order.id, status: order.status, created });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message });
  }
}

// ---- WooCommerce: Topic "Order created" ----
r.post('/webhooks/woocommerce/:token', wrap(async (req, res) => {
  const seller = await sellerByToken(req.params.token);
  if (!seller) return res.status(404).json({ error: 'unknown token' });
  if (!req.body || !req.body.id) return res.json({ ok: true, ping: true }); // Woo sends a ping on webhook creation
  if (seller.woo_secret) {
    const sig = req.get('X-WC-Webhook-Signature') || '';
    if (!safeEqual(sig, hmac(seller.woo_secret, req.rawBody || '', 'base64'))) return res.status(401).json({ error: 'bad signature' });
  }
  const o = req.body;
  const b = o.billing || {};
  const s = o.shipping || {};
  await respond(res, () => createOrder(seller.id, {
    source: 'woocommerce',
    external_id: o.id,
    customer_name: [b.first_name, b.last_name].filter(Boolean).join(' '),
    phone: b.phone || s.phone,
    product: items(o.line_items),
    amount: o.total,
    address: [s.address_1 || b.address_1, s.city || b.city].filter(Boolean).join(', '),
  }));
}));

// ---- Shopify: "Order creation" webhook ----
r.post('/webhooks/shopify/:token', wrap(async (req, res) => {
  const seller = await sellerByToken(req.params.token);
  if (!seller) return res.status(404).json({ error: 'unknown token' });
  if (seller.shopify_secret) {
    const sig = req.get('X-Shopify-Hmac-Sha256') || '';
    if (!safeEqual(sig, hmac(seller.shopify_secret, req.rawBody || '', 'base64'))) return res.status(401).json({ error: 'bad signature' });
  }
  const o = req.body || {};
  const a = o.shipping_address || o.billing_address || {};
  await respond(res, () => createOrder(seller.id, {
    source: 'shopify',
    external_id: o.id,
    customer_name: a.name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' '),
    phone: a.phone || o.phone || o.customer?.phone || o.billing_address?.phone,
    product: items(o.line_items?.map((l) => ({ name: l.title || l.name, quantity: l.quantity }))),
    amount: o.total_price,
    address: [a.address1, a.address2, a.city].filter(Boolean).join(', '),
  }));
}));

// ---- Steadfast delivery-status webhook ----
// Panel → Webhook: Callback URL = /webhooks/steadfast/:token, Auth token = seller's steadfast_webhook_token.
r.post('/webhooks/steadfast/:token', wrap(async (req, res) => {
  const seller = await sellerByToken(req.params.token);
  if (!seller || !seller.steadfast_webhook_token) return res.status(404).json({ status: 'error', message: 'unknown endpoint' });
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '')?.[1] || '';
  if (!safeEqual(bearer, seller.steadfast_webhook_token)) return res.status(401).json({ status: 'error', message: 'unauthorized' });

  const key = req.get('Idempotency-Key');
  if (key) {
    const seen = await db.one('SELECT 1 AS x FROM webhook_events WHERE key=?', [`sf:${key}`]);
    if (seen) return res.json({ status: 'success', message: 'duplicate' });
  }

  const e = req.body || {};
  const type = e.notification_type || 'delivery_status';
  if (type === 'delivery_status' && e.status) {
    const status = String(e.status).toLowerCase();
    const order = await db.one(
      `SELECT * FROM orders WHERE seller_id=? AND courier_status='sent' AND (courier_ref=? OR courier_ref=? OR ?=('CVR-' || id))`,
      [seller.id, String(e.consignment_id ?? ''), String(e.invoice ?? ''), String(e.invoice ?? '')]);
    if (order) {
      await db.run('UPDATE orders SET courier_delivery_status=?, updated_at=? WHERE id=?', [status, db.now(), order.id]);
      if (status === 'cancelled' || status === 'partial_delivered') {
        await notify(seller.id, order.id, `Steadfast: অর্ডার #${order.id} ${status === 'cancelled' ? 'রিটার্ন হচ্ছে' : 'আংশিক ডেলিভারি হয়েছে'} (${order.phone})।`);
      }
    }
  }
  if (key) await db.run('INSERT INTO webhook_events (key, created_at) VALUES (?,?)', [`sf:${key}`, db.now()]).catch(() => {});
  res.json({ status: 'success', message: 'Webhook received' });
}));

// ---- Cached TTS audio (fetched by the voice provider during the call) ----
r.get('/tts/:file', wrap(async (req, res) => {
  const m = /^([a-f0-9]{32})\.(mp3|wav|bin)$/.exec(req.params.file);
  const clip = m && await require('../services/tts').getClip(m[1]);
  if (!clip) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(clip.mime).send(clip.audio);
}));

// ---- Generic JSON API ----
r.post('/api/orders', wrap(async (req, res) => {
  const seller = await sellerByToken(req.get('X-Api-Key'));
  if (!seller) return res.status(401).json({ error: 'invalid X-Api-Key' });
  await respond(res, () => createOrder(seller.id, { ...req.body, source: 'api' }));
}));

r.get('/api/orders/:id', wrap(async (req, res) => {
  const seller = await sellerByToken(req.get('X-Api-Key'));
  if (!seller) return res.status(401).json({ error: 'invalid X-Api-Key' });
  const o = await db.one('SELECT id, external_id, status, attempts, courier_ref, courier_tracking, courier_delivery_status FROM orders WHERE id=? AND seller_id=?', [Number(req.params.id), seller.id]);
  o ? res.json(o) : res.status(404).json({ error: 'not found' });
}));

// ---- Voice provider result callback ----
r.post('/voice/callback', wrap(async (req, res) => {
  if (config.voiceWebhookSecret && !safeEqual(req.get('X-Webhook-Secret') || req.query.secret || '', config.voiceWebhookSecret)) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const out = await calls.handleCallResult(req.body || {});
  res.status(out.ok ? 200 : 404).json(out);
}));

// ---- Scheduler tick (Vercel / external cron, every minute) ----
r.get('/api/cron/tick', wrap(async (req, res) => {
  const token = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '')?.[1] || req.query.secret || '';
  if (!config.cronSecret || !safeEqual(token, config.cronSecret)) return res.status(401).json({ error: 'unauthorized' });
  const result = await calls.tick();
  await sheets.syncAll().catch((e) => console.error('[cron] sheets', e.message));
  res.json({ ok: true, ...result });
}));

// ---- bKash payment verification (admin tool or payment-gateway webhook) ----
r.post('/admin/topup', wrap(async (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  const ok = (config.adminToken && safeEqual(token || '', config.adminToken)) ||
    (config.bkashWebhookSecret && safeEqual(req.get('X-Bkash-Signature') || '', hmac(config.bkashWebhookSecret, req.rawBody || '')));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  const { seller_id, amount, trx_id } = req.body || {};
  const sellerId = Number(String(seller_id).replace(/^CVR/i, ''));
  if (!(await db.one('SELECT 1 AS x FROM sellers WHERE id=?', [sellerId]))) return res.status(404).json({ error: 'seller not found' });
  try {
    const credited = await topups.credit(sellerId, amount, trx_id);
    res.json({ ok: true, credited, balance: (await billing.summary(sellerId)).credits });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
}));

module.exports = r;
