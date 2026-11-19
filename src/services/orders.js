'use strict';
const db = require('../db');
const config = require('../config');
const { normalizeBdPhone, clampToCallWindow, addMin, iso } = require('../util');

/**
 * Create an order and schedule its first confirmation call.
 * Idempotent per (seller, source, external_id). Returns { order, created }.
 */
function createOrder(sellerId, input, now = new Date()) {
  const product = String(input.product || '').trim();
  const amount = Number(String(input.amount ?? '').replace(/[^\d.]/g, ''));
  if (!product) throw new Error('product is required');
  if (!(amount >= 0) || String(input.amount ?? '').trim() === '') throw new Error('amount is required');
  if (!input.phone) throw new Error('phone is required');

  const d = db.get();
  const source = input.source || 'manual';
  const externalId = input.external_id != null && input.external_id !== '' ? String(input.external_id) : null;
  if (externalId) {
    const existing = d.prepare('SELECT * FROM orders WHERE seller_id=? AND source=? AND external_id=?').get(sellerId, source, externalId);
    if (existing) return { order: existing, created: false };
  }

  const phone = normalizeBdPhone(input.phone);
  const status = phone ? 'pending' : 'wrong_number';
  const nextCall = phone ? iso(clampToCallWindow(addMin(now, config.firstCallDelayMin))) : null;

  const r = d.prepare(
    `INSERT INTO orders (seller_id, source, external_id, customer_name, phone, product, amount, address, status, next_call_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(sellerId, source, externalId, input.customer_name || null, phone || String(input.phone), product, amount, input.address || null, status, nextCall);
  return { order: d.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid), created: true };
}

function setStatus(orderId, status, extra = {}) {
  const fields = ['status=?', "updated_at=datetime('now')"];
  const vals = [status];
  for (const [k, v] of Object.entries(extra)) { fields.push(`${k}=?`); vals.push(v); }
  db.get().prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id=?`).run(...vals, orderId);
}

const STATUS_LABELS = {
  pending: 'কলের অপেক্ষায়',
  calling: 'কল চলছে',
  confirmed: 'কনফার্মড',
  cancelled: 'বাতিল',
  no_answer: 'ধরেনি',
  wrong_number: 'নম্বর ভুল',
  callback: 'কল ব্যাক করুন',
  no_credit: 'ক্রেডিট নেই',
};

module.exports = { createOrder, setStatus, STATUS_LABELS };
