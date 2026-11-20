'use strict';
/**
 * Billing: first N answered calls per calendar month (Dhaka) are free, then prepaid
 * credits (bKash top-up, see pricing.js) are deducted per answered call.
 */
const db = require('../db');
const config = require('../config');
const { creditsForPayment } = require('../pricing');

function monthStartUtc(now = new Date()) {
  const local = new Date(now.getTime() + 6 * 3600e3);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 6 * 3600e3);
}

async function freeCallsUsed(sellerId, now = new Date(), q = db) {
  const r = await q.one(`SELECT COUNT(*) AS n FROM ledger WHERE seller_id=? AND kind='free_call' AND created_at >= ?`,
    [sellerId, monthStartUtc(now).toISOString()]);
  return r.n;
}

async function summary(sellerId) {
  const s = await db.one('SELECT credits FROM sellers WHERE id=?', [sellerId]);
  const used = await freeCallsUsed(sellerId);
  return {
    credits: s ? s.credits : 0,
    freeUsed: used,
    freeLeft: Math.max(0, config.freeCallsPerMonth - used),
    freeTotal: config.freeCallsPerMonth,
  };
}

async function canPlaceCall(sellerId) {
  const b = await summary(sellerId);
  return b.freeLeft > 0 || b.credits >= config.creditsPerCall;
}

/** Charge one answered call. Returns credits charged (0 when covered by the free tier). */
function chargeCall(sellerId, callId) {
  return db.tx(async (q) => {
    if ((await freeCallsUsed(sellerId, new Date(), q)) < config.freeCallsPerMonth) {
      await q.run(`INSERT INTO ledger (seller_id, kind, credits, ref, created_at) VALUES (?, 'free_call', 0, ?, ?)`, [sellerId, `call:${callId}`, db.now()]);
      return 0;
    }
    const c = config.creditsPerCall;
    await q.run('UPDATE sellers SET credits = credits - ? WHERE id=?', [c, sellerId]);
    await q.run(`INSERT INTO ledger (seller_id, kind, credits, ref, created_at) VALUES (?, 'call', ?, ?, ?)`, [sellerId, -c, `call:${callId}`, db.now()]);
    return c;
  });
}

/** Add credits for a verified bKash payment. Same trxId twice is a no-op. */
async function topUp(sellerId, takaAmount, trxId) {
  const credits = creditsForPayment(takaAmount);
  if (!(credits > 0) || !trxId) throw new Error('invalid top-up');
  return db.tx(async (q) => {
    const ref = `bkash:${String(trxId).toUpperCase()}`;
    if (await q.one(`SELECT 1 AS x FROM ledger WHERE kind='topup' AND ref=?`, [ref])) return false;
    await q.run(`INSERT INTO ledger (seller_id, kind, credits, ref, created_at) VALUES (?, 'topup', ?, ?, ?)`, [sellerId, credits, ref, db.now()]);
    await q.run('UPDATE sellers SET credits = credits + ? WHERE id=?', [credits, sellerId]);
    return true;
  });
}

module.exports = { summary, canPlaceCall, chargeCall, topUp, freeCallsUsed, monthStartUtc };
