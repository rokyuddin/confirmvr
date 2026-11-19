'use strict';
/** Machine-facing routes: store webhooks, public API, voice provider callback, admin. */
const express = require('express');
const db = require('../db');
const config = require('../config');
const billing = require('../services/billing');
const { createOrder } = require('../services/orders');
const { handleCallResult } = require('../services/calls');
const { hmac, safeEqual } = require('../util');

const r = express.Router();
const sellerByToken = (t) => db.get().prepare('SELECT * FROM sellers WHERE webhook_token=?').get(String(t || ''));
const items = (lines = []) => lines.map((l) => (l.quantity > 1 ? `${l.name} ${l.quantity}টি` : l.name)).join(', ') || 'প্রোডাক্ট';

function respond(res, fn) {
  try {
    const { order, created } = fn();
    res.status(created ? 201 : 200).json({ ok: true, order_id: order.id, status: order.status, created });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message });
  }
}

// ---- WooCommerce: Topic "Order created" ----
r.post('/webhooks/woocommerce/:token', (req, res) => {
  const seller = sellerByToken(req.params.token);
  if (!seller) return res.status(404).json({ error: 'unknown token' });
  if (!req.body || !req.body.id) return res.json({ ok: true, ping: true }); // Woo sends a ping on webhook creation
  if (seller.woo_secret) {
    const sig = req.get('X-WC-Webhook-Signature') || '';
    if (!safeEqual(sig, hmac(seller.woo_secret, req.rawBody || '', 'base64'))) return res.status(401).json({ error: 'bad signature' });
  }
  const o = req.body;
  const b = o.billing || {};
  const s = o.shipping || {};
  respond(res, () => createOrder(seller.id, {
    source: 'woocommerce',
    external_id: o.id,
    customer_name: [b.first_name, b.last_name].filter(Boolean).join(' '),
    phone: b.phone || s.phone,
    product: items(o.line_items),
    amount: o.total,
    address: [s.address_1 || b.address_1, s.city || b.city].filter(Boolean).join(', '),
  }));
});

// ---- Shopify: "Order creation" webhook ----
r.post('/webhooks/shopify/:token', (req, res) => {
  const seller = sellerByToken(req.params.token);
  if (!seller) return res.status(404).json({ error: 'unknown token' });
  if (seller.shopify_secret) {
    const sig = req.get('X-Shopify-Hmac-Sha256') || '';
    if (!safeEqual(sig, hmac(seller.shopify_secret, req.rawBody || '', 'base64'))) return res.status(401).json({ error: 'bad signature' });
  }
  const o = req.body || {};
  const a = o.shipping_address || o.billing_address || {};
  respond(res, () => createOrder(seller.id, {
    source: 'shopify',
    external_id: o.id,
    customer_name: a.name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' '),
    phone: a.phone || o.phone || o.customer?.phone || o.billing_address?.phone,
    product: items(o.line_items?.map((l) => ({ name: l.title || l.name, quantity: l.quantity }))),
    amount: o.total_price,
    address: [a.address1, a.address2, a.city].filter(Boolean).join(', '),
  }));
});

// ---- Generic JSON API ----
r.post('/api/orders', (req, res) => {
  const seller = sellerByToken(req.get('X-Api-Key'));
  if (!seller) return res.status(401).json({ error: 'invalid X-Api-Key' });
  respond(res, () => createOrder(seller.id, { ...req.body, source: 'api' }));
});

r.get('/api/orders/:id', (req, res) => {
  const seller = sellerByToken(req.get('X-Api-Key'));
  if (!seller) return res.status(401).json({ error: 'invalid X-Api-Key' });
  const o = db.get().prepare('SELECT id, external_id, status, attempts, courier_ref FROM orders WHERE id=? AND seller_id=?').get(Number(req.params.id), seller.id);
  o ? res.json(o) : res.status(404).json({ error: 'not found' });
});

// ---- Voice provider result callback ----
r.post('/voice/callback', async (req, res) => {
  if (config.voiceWebhookSecret && !safeEqual(req.get('X-Webhook-Secret') || req.query.secret || '', config.voiceWebhookSecret)) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const out = await handleCallResult(req.body || {});
  res.status(out.ok ? 200 : 404).json(out);
});

// ---- bKash payment verification (from admin tool or payment-gateway webhook) ----
r.post('/admin/topup', (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  const ok = (config.adminToken && safeEqual(token || '', config.adminToken)) ||
    (config.bkashWebhookSecret && safeEqual(req.get('X-Bkash-Signature') || '', hmac(config.bkashWebhookSecret, req.rawBody || '')));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  const { seller_id, amount, trx_id } = req.body || {};
  const sellerId = Number(String(seller_id).replace(/^CVR/i, ''));
  if (!db.get().prepare('SELECT 1 FROM sellers WHERE id=?').get(sellerId)) return res.status(404).json({ error: 'seller not found' });
  try {
    const credited = billing.topUp(sellerId, amount, trx_id);
    if (credited) {
      // Release orders paused for lack of credit.
      const { requeue } = require('../services/calls');
      for (const o of db.get().prepare("SELECT id FROM orders WHERE seller_id=? AND status='no_credit'").all(sellerId)) requeue(o.id);
    }
    res.json({ ok: true, credited, balance: billing.summary(sellerId).credits });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

module.exports = r;
