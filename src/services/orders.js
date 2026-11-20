'use strict';
const db = require('../db');
const config = require('../config');
const { normalizeBdPhone, clampToCallWindow, addMin, iso } = require('../util');

/**
 * Create an order and schedule its first confirmation call.
 * Idempotent per (seller, source, external_id). Returns { order, created }.
 */
async function createOrder(sellerId, input, now = new Date()) {
  const product = String(input.product || '').trim();
  const rawAmount = String(input.amount ?? '').trim();
  const amount = Number(rawAmount.replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)).replace(/[^\d.]/g, ''));
  if (!product) throw new Error('product is required');
  if (!rawAmount || !(amount >= 0)) throw new Error('amount is required');
  if (!input.phone) throw new Error('phone is required');

  const source = input.source || 'manual';
  const externalId = input.external_id != null && input.external_id !== '' ? String(input.external_id) : null;
  if (externalId) {
    const existing = await db.one('SELECT * FROM orders WHERE seller_id=? AND source=? AND external_id=?', [sellerId, source, externalId]);
    if (existing) return { order: existing, created: false };
  }

  const phone = normalizeBdPhone(input.phone);
  const status = phone ? 'pending' : 'wrong_number';
  const nextCall = phone ? iso(clampToCallWindow(addMin(now, config.firstCallDelayMin))) : null;
  const ts = db.now();
  try {
    const id = await db.insert(
      `INSERT INTO orders (seller_id, source, external_id, customer_name, phone, product, amount, address, status, next_call_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sellerId, source, externalId, input.customer_name || null, phone || String(input.phone), product.slice(0, 300), amount,
        input.address ? String(input.address).slice(0, 490) : null, status, nextCall, ts, ts]);
    return { order: await db.one('SELECT * FROM orders WHERE id=?', [id]), created: true };
  } catch (e) {
    // Two webhook deliveries racing on the same external id.
    if (externalId && /unique|duplicate/i.test(e.message)) {
      return { order: await db.one('SELECT * FROM orders WHERE seller_id=? AND source=? AND external_id=?', [sellerId, source, externalId]), created: false };
    }
    throw e;
  }
}

async function setStatus(orderId, status, extra = {}, q = db) {
  const fields = ['status=?', 'updated_at=?'];
  const vals = [status, db.now()];
  for (const [k, v] of Object.entries(extra)) { fields.push(`${k}=?`); vals.push(v); }
  await q.run(`UPDATE orders SET ${fields.join(', ')} WHERE id=?`, [...vals, orderId]);
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
