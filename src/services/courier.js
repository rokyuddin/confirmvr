'use strict';
/**
 * One-click courier booking for confirmed orders.
 * Steadfast is the primary, fully supported courier (see steadfast.js).
 * Pathao and RedX are best-effort adapters (verify against their docs before live use).
 * COURIER_DRY_RUN=1 fakes bookings during development.
 *
 * sellers.courier_config JSON:
 *   Steadfast: { "api_key": "...", "secret_key": "..." }
 *   Pathao:    { "client_id","client_secret","username","password","store_id","city_id","zone_id" }
 *   RedX:      { "token": "...", "delivery_area": "...", "delivery_area_id": 1 }
 */
const db = require('../db');
const steadfast = require('./steadfast');

const invoiceFor = (order) => `CVR-${order.id}`;

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return data;
}

const couriers = {
  async steadfast(order, c) {
    const sf = steadfast.client(c);
    const invoice = invoiceFor(order);
    try {
      const cons = await sf.createOrder({
        invoice,
        recipient_name: order.customer_name || 'Customer',
        recipient_phone: order.phone,
        recipient_address: order.address || '',
        cod_amount: order.amount,
        item_description: order.product,
        note: 'কনফার্ম কলে কাস্টমার অর্ডার নিশ্চিত করেছেন',
      });
      return { ref: String(cons.consignment_id), tracking: cons.tracking_code || null, deliveryStatus: cons.status || 'in_review' };
    } catch (e) {
      // An earlier attempt (timeout, double click) already booked this invoice.
      if (e.kind === 'duplicate' || /already|exist|unique/i.test(e.message)) {
        const st = await sf.statusByInvoice(invoice).catch(() => null);
        return { ref: invoice, tracking: null, deliveryStatus: st || 'in_review' };
      }
      throw e;
    }
  },

  async pathao(order, c) {
    const base = c.base_url || 'https://api-hermes.pathao.com';
    const tok = await postJson(`${base}/aladdin/api/v1/issue-token`, {}, {
      client_id: c.client_id, client_secret: c.client_secret, username: c.username, password: c.password, grant_type: 'password',
    });
    const data = await postJson(`${base}/aladdin/api/v1/orders`, { Authorization: `Bearer ${tok.access_token}` }, {
      store_id: c.store_id, merchant_order_id: invoiceFor(order),
      recipient_name: order.customer_name || 'Customer', recipient_phone: order.phone.replace('+88', ''),
      recipient_address: order.address || 'N/A', recipient_city: c.city_id, recipient_zone: c.zone_id,
      delivery_type: 48, item_type: 2, item_quantity: 1, item_weight: 0.5,
      amount_to_collect: Math.round(order.amount), item_description: order.product,
    });
    return { ref: String(data?.data?.consignment_id || invoiceFor(order)), tracking: null, deliveryStatus: null };
  },

  async redx(order, c) {
    const base = c.base_url || 'https://openapi.redx.com.bd/v1.0.0-beta';
    const data = await postJson(`${base}/parcel`, { 'API-ACCESS-TOKEN': `Bearer ${c.token}` }, {
      customer_name: order.customer_name || 'Customer', customer_phone: order.phone.replace('+88', ''),
      delivery_area: c.delivery_area, delivery_area_id: c.delivery_area_id, customer_address: order.address || 'N/A',
      merchant_invoice_id: invoiceFor(order), cash_collection_amount: String(Math.round(order.amount)),
      parcel_weight: 500, value: Math.round(order.amount), instruction: order.product,
    });
    return { ref: String(data?.tracking_id || invoiceFor(order)), tracking: data?.tracking_id || null, deliveryStatus: null };
  },
};

async function sendToCourier(seller, order) {
  if (order.status !== 'confirmed') throw new Error('শুধু কনফার্মড অর্ডার কুরিয়ারে পাঠানো যায়');
  if (order.courier_status === 'sent') return order.courier_ref;
  // Claim so a double click can't book twice.
  const claim = await db.run(`UPDATE orders SET courier_status='sending', updated_at=? WHERE id=? AND (courier_status IS NULL OR courier_status='failed')`, [db.now(), order.id]);
  if (claim.changes !== 1) throw new Error('এই অর্ডার কুরিয়ারে পাঠানো হচ্ছে');
  try {
    if (!seller.courier || !couriers[seller.courier]) throw new Error('সেটিংসে কুরিয়ার সেট করা নেই');
    const out = process.env.COURIER_DRY_RUN === '1'
      ? { ref: `DRY-${seller.courier}-${order.id}`, tracking: 'DRYTRACK', deliveryStatus: 'in_review' }
      : await couriers[seller.courier](order, JSON.parse(seller.courier_config || '{}'));
    await db.run(`UPDATE orders SET courier_status='sent', courier_ref=?, courier_tracking=?, courier_delivery_status=?, courier_error=NULL, updated_at=? WHERE id=?`,
      [out.ref, out.tracking, out.deliveryStatus, db.now(), order.id]);
    return out.ref;
  } catch (e) {
    await db.run(`UPDATE orders SET courier_status='failed', courier_error=?, updated_at=? WHERE id=?`, [String(e.message).slice(0, 300), db.now(), order.id]);
    throw e;
  }
}

/** Bulk: send every confirmed, not-yet-sent order. Returns { sent, failed }. */
async function sendAllConfirmed(seller) {
  const orders = await db.all(`SELECT * FROM orders WHERE seller_id=? AND status='confirmed' AND (courier_status IS NULL OR courier_status='failed') ORDER BY id LIMIT 100`, [seller.id]);
  let sent = 0, failed = 0;
  for (const o of orders) {
    try { await sendToCourier(seller, o); sent++; } catch { failed++; }
  }
  return { sent, failed };
}

module.exports = { sendToCourier, sendAllConfirmed, couriers, invoiceFor };
