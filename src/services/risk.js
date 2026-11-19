'use strict';
/**
 * Risk flags per phone number, computed across ALL sellers (network effect):
 * numbers that cancel repeatedly or never pick up.
 */
const db = require('../db');
const config = require('../config');

function phoneStats(phones) {
  if (!phones.length) return {};
  const uniq = [...new Set(phones)];
  const rows = db.get().prepare(
    `SELECT phone,
            COUNT(*) total,
            SUM(status='confirmed') confirmed,
            SUM(status='cancelled') cancelled,
            SUM(status='no_answer') no_answer
       FROM orders WHERE phone IN (${uniq.map(() => '?').join(',')}) GROUP BY phone`
  ).all(...uniq);
  const out = {};
  for (const r of rows) {
    const flags = [];
    if (r.cancelled >= config.riskCancelThreshold) flags.push(`${r.cancelled} বার বাতিল`);
    if (r.no_answer >= config.riskNoAnswerThreshold) flags.push(`${r.no_answer} বার ধরেনি`);
    out[r.phone] = { ...r, flags, risky: flags.length > 0 };
  }
  return out;
}

function riskyNumbers(sellerId, limit = 50) {
  const phones = db.get().prepare('SELECT DISTINCT phone FROM orders WHERE seller_id=?').all(sellerId).map((r) => r.phone);
  return Object.values(phoneStats(phones)).filter((s) => s.risky).sort((a, b) => b.cancelled + b.no_answer - (a.cancelled + a.no_answer)).slice(0, limit);
}

module.exports = { phoneStats, riskyNumbers };
