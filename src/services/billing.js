'use strict';
/**
 * Billing: first N answered calls per calendar month (Dhaka) are free, then prepaid
 * credits (topped up via bKash) are deducted per answered call.
 */
const db = require('../db');
const config = require('../config');

function monthStartUtc(now = new Date()) {
  const local = new Date(now.getTime() + 6 * 3600e3);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 6 * 3600e3);
}
const sqlTs = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

function freeCallsUsed(sellerId, now = new Date()) {
  return db.get()
    .prepare(`SELECT COUNT(*) n FROM ledger WHERE seller_id=? AND kind='free_call' AND created_at >= ?`)
    .get(sellerId, sqlTs(monthStartUtc(now))).n;
}

function summary(sellerId) {
  const s = db.get().prepare('SELECT credits FROM sellers WHERE id=?').get(sellerId);
  const used = freeCallsUsed(sellerId);
  return {
    credits: s ? s.credits : 0,
    freeUsed: used,
    freeLeft: Math.max(0, config.freeCallsPerMonth - used),
    freeTotal: config.freeCallsPerMonth,
  };
}

function canPlaceCall(sellerId) {
  const b = summary(sellerId);
  return b.freeLeft > 0 || b.credits >= config.creditsPerCall;
}

/** Charge one call. Returns credits charged (0 when covered by the free tier). */
function chargeCall(sellerId, callId) {
  return db.tx((d) => {
    if (freeCallsUsed(sellerId) < config.freeCallsPerMonth) {
      d.prepare(`INSERT INTO ledger (seller_id, kind, credits, ref) VALUES (?, 'free_call', 0, ?)`).run(sellerId, `call:${callId}`);
      return 0;
    }
    const c = config.creditsPerCall;
    d.prepare('UPDATE sellers SET credits = credits - ? WHERE id=?').run(c, sellerId);
    d.prepare(`INSERT INTO ledger (seller_id, kind, credits, ref) VALUES (?, 'call', ?, ?)`).run(sellerId, -c, `call:${callId}`);
    return c;
  });
}

/**
 * Add credits for a bKash payment. `trxId` is unique, so replaying the same
 * transaction is a no-op. Returns true if credited.
 */
function topUp(sellerId, takaAmount, trxId) {
  const credits = Math.floor((Number(takaAmount) / config.takaPerCredit) * 100) / 100;
  if (!(credits > 0) || !trxId) throw new Error('invalid top-up');
  return db.tx((d) => {
    const exists = d.prepare(`SELECT 1 FROM ledger WHERE kind='topup' AND ref=?`).get(`bkash:${trxId}`);
    if (exists) return false;
    d.prepare(`INSERT INTO ledger (seller_id, kind, credits, ref) VALUES (?, 'topup', ?, ?)`).run(sellerId, credits, `bkash:${trxId}`);
    d.prepare('UPDATE sellers SET credits = credits + ? WHERE id=?').run(credits, sellerId);
    return true;
  });
}

module.exports = { summary, canPlaceCall, chargeCall, topUp, freeCallsUsed, monthStartUtc };
