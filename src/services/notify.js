'use strict';
/**
 * Seller notifications: stored in DB and shown on the dashboard.
 * If NOTIFY_WEBHOOK_URL is set, also POSTs JSON there (hook up SMS / Messenger / Telegram).
 */
const db = require('../db');

async function notify(sellerId, orderId, message) {
  await db.run('INSERT INTO notifications (seller_id, order_id, message, created_at) VALUES (?,?,?,?)', [sellerId, orderId, message, db.now()]);
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (url) {
    const seller = await db.one('SELECT phone, page_name FROM sellers WHERE id=?', [sellerId]);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller_id: sellerId, seller_phone: seller?.phone, order_id: orderId, message }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => console.error('[notify]', e.message));
  }
}

module.exports = { notify };
