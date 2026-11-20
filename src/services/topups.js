'use strict';
/** bKash top-up requests (submitted by sellers, approved by admin or a payment webhook). */
const db = require('../db');
const billing = require('./billing');
const calls = require('./calls');
const { notify } = require('./notify');

/** Seller submits a TrxID. Returns { ok, error }. */
async function submit(sellerId, amount, trxId) {
  const trx = String(trxId || '').trim().toUpperCase();
  const amt = Number(amount);
  if (!/^[A-Z0-9]{8,12}$/.test(trx)) return { ok: false, error: 'TrxID সঠিক নয়' };
  if (!(amt >= 50)) return { ok: false, error: 'কমপক্ষে ৫০ টাকা' };
  try {
    await db.insert('INSERT INTO topup_requests (seller_id, amount, trx_id, created_at) VALUES (?,?,?,?)', [sellerId, amt, trx, db.now()]);
  } catch (e) {
    if (/unique|duplicate|constraint/i.test(e.message)) return { ok: false, error: 'এই TrxID আগেই জমা হয়েছে' };
    throw e;
  }
  await notify(sellerId, null, `রিচার্জ রিকোয়েস্ট জমা হয়েছে: ${amt} টাকা, TrxID ${trx}। ভেরিফাই হলে ক্রেডিট যোগ হবে।`);
  return { ok: true };
}

/** Credit a seller for a verified payment, release paused orders. Idempotent per trxId. */
async function credit(sellerId, amount, trxId) {
  const trx = String(trxId).trim().toUpperCase();
  const credited = await billing.topUp(sellerId, amount, trx);
  if (credited) {
    await db.run(`UPDATE topup_requests SET status='approved', decided_at=? WHERE trx_id=? AND status='pending'`, [db.now(), trx]);
    for (const o of await db.all("SELECT id FROM orders WHERE seller_id=? AND status='no_credit'", [sellerId])) await calls.requeue(o.id);
    await notify(sellerId, null, `রিচার্জ সফল: ${amount} টাকা (TrxID ${trx})। কল আবার চালু হয়েছে।`);
  }
  return credited;
}

async function approve(requestId, amountOverride) {
  const r = await db.one(`SELECT * FROM topup_requests WHERE id=? AND status='pending'`, [requestId]);
  if (!r) throw new Error('রিকোয়েস্ট পাওয়া যায়নি বা আগেই নিষ্পত্তি হয়েছে');
  const amount = amountOverride > 0 ? amountOverride : r.amount;
  if (amount !== r.amount) await db.run('UPDATE topup_requests SET amount=? WHERE id=?', [amount, r.id]);
  return credit(r.seller_id, amount, r.trx_id);
}

async function reject(requestId, note) {
  const r = await db.one(`SELECT * FROM topup_requests WHERE id=? AND status='pending'`, [requestId]);
  if (!r) throw new Error('রিকোয়েস্ট পাওয়া যায়নি বা আগেই নিষ্পত্তি হয়েছে');
  await db.run(`UPDATE topup_requests SET status='rejected', note=?, decided_at=? WHERE id=?`, [note || null, db.now(), r.id]);
  await notify(r.seller_id, null, `রিচার্জ রিকোয়েস্ট বাতিল (TrxID ${r.trx_id})${note ? `: ${note}` : ''}। প্রশ্ন থাকলে যোগাযোগ করুন।`);
}

module.exports = { submit, credit, approve, reject };
