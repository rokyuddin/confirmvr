'use strict';
/**
 * Risk flags per phone number, computed across ALL sellers (network effect):
 * numbers that cancel repeatedly or never pick up.
 */
const db = require('../db');
const config = require('../config');

async function phoneStats(phones) {
  const uniq = [...new Set(phones)];
  if (!uniq.length) return {};
  const rows = await db.all(
    `SELECT phone,
            COUNT(*) AS total,
            SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status='no_answer' THEN 1 ELSE 0 END) AS no_answer
       FROM orders WHERE phone IN (${uniq.map(() => '?').join(',')}) GROUP BY phone`, uniq);
  const out = {};
  for (const r of rows) {
    const flags = [];
    if (r.cancelled >= config.riskCancelThreshold) flags.push(`${r.cancelled} বার বাতিল`);
    if (r.no_answer >= config.riskNoAnswerThreshold) flags.push(`${r.no_answer} বার ধরেনি`);
    out[r.phone] = { ...r, flags, risky: flags.length > 0 };
  }
  return out;
}

async function riskyNumbers(sellerId, limit = 50) {
  const phones = (await db.all('SELECT DISTINCT phone FROM orders WHERE seller_id=?', [sellerId])).map((r) => r.phone);
  return Object.values(await phoneStats(phones))
    .filter((s) => s.risky)
    .sort((a, b) => b.cancelled + b.no_answer - (a.cancelled + a.no_answer))
    .slice(0, limit);
}

module.exports = { phoneStats, riskyNumbers };
