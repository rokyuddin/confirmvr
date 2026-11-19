'use strict';
/**
 * Seller notifications: stored in DB and shown on the dashboard.
 * If NOTIFY_WEBHOOK_URL is set, also POSTs JSON there (hook up SMS / Messenger / Telegram).
 */
const db = require('../db');

function notify(sellerId, orderId, message) {
  db.get().prepare('INSERT INTO notifications (seller_id, order_id, message) VALUES (?,?,?)').run(sellerId, orderId, message);
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (url) {
    const seller = db.get().prepare('SELECT phone, page_name FROM sellers WHERE id=?').get(sellerId);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller_id: sellerId, seller_phone: seller?.phone, order_id: orderId, message }),
    }).catch((e) => console.error('[notify]', e.message));
  }
}

module.exports = { notify };
