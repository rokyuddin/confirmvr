'use strict';
/**
 * One-click courier booking for confirmed orders: Steadfast, Pathao, RedX.
 * Seller stores credentials as JSON in settings (sellers.courier_config).
 * Set COURIER_DRY_RUN=1 to fake bookings during development.
 *
 * Steadfast: { "api_key": "...", "secret_key": "..." }
 * Pathao:    { "client_id", "client_secret", "username", "password", "store_id",
 *              "city_id", "zone_id", "base_url"? }   (default city/zone for MVP)
 * RedX:      { "token": "...", "delivery_area": "...", "delivery_area_id": 1, "base_url"? }
 */
const db = require('../db');

async function postJson(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return data;
}

const couriers = {
  async steadfast(order, c) {
    const data = await postJson('https://portal.packzy.com/api/v1/create_order',
      { 'Api-Key': c.api_key, 'Secret-Key': c.secret_key },
      {
        invoice: `CVR-${order.id}`,
        recipient_name: order.customer_name || 'Customer',
        recipient_phone: order.phone.replace('+88', ''),
        recipient_address: order.address || 'N/A',
        cod_amount: order.amount,
        note: order.product,
      });
    return data?.consignment?.tracking_code || data?.consignment?.consignment_id || 'ok';
  },

  async pathao(order, c) {
    const base = c.base_url || 'https://api-hermes.pathao.com';
    const tok = await postJson(`${base}/aladdin/api/v1/issue-token`, {}, {
      client_id: c.client_id, client_secret: c.client_secret, username: c.username, password: c.password, grant_type: 'password',
    });
    const data = await postJson(`${base}/aladdin/api/v1/orders`, { Authorization: `Bearer ${tok.access_token}` }, {
      store_id: c.store_id,
      merchant_order_id: `CVR-${order.id}`,
      recipient_name: order.customer_name || 'Customer',
      recipient_phone: order.phone.replace('+88', ''),
      recipient_address: order.address || 'N/A',
      recipient_city: c.city_id,
      recipient_zone: c.zone_id,
      delivery_type: 48,
      item_type: 2,
      item_quantity: 1,
      item_weight: 0.5,
      amount_to_collect: order.amount,
      item_description: order.product,
    });
    return data?.data?.consignment_id || 'ok';
  },

  async redx(order, c) {
    const base = c.base_url || 'https://openapi.redx.com.bd/v1.0.0-beta';
    const data = await postJson(`${base}/parcel`, { 'API-ACCESS-TOKEN': `Bearer ${c.token}` }, {
      customer_name: order.customer_name || 'Customer',
      customer_phone: order.phone.replace('+88', ''),
      delivery_area: c.delivery_area,
      delivery_area_id: c.delivery_area_id,
      customer_address: order.address || 'N/A',
      merchant_invoice_id: `CVR-${order.id}`,
      cash_collection_amount: String(order.amount),
      parcel_weight: 500,
      value: order.amount,
      instruction: order.product,
    });
    return data?.tracking_id || 'ok';
  },
};

async function sendToCourier(seller, order) {
  if (order.status !== 'confirmed') throw new Error('Only confirmed orders can be sent');
  if (order.courier_status === 'sent') return order.courier_ref;
  let ref;
  try {
    if (!seller.courier || !couriers[seller.courier]) throw new Error('Courier not configured in settings');
    if (process.env.COURIER_DRY_RUN === '1') ref = `DRY-${seller.courier}-${order.id}`;
    else ref = await couriers[seller.courier](order, JSON.parse(seller.courier_config || '{}'));
    db.get().prepare("UPDATE orders SET courier_status='sent', courier_ref=?, courier_error=NULL, updated_at=datetime('now') WHERE id=?").run(String(ref), order.id);
    return ref;
  } catch (e) {
    db.get().prepare("UPDATE orders SET courier_status='failed', courier_error=?, updated_at=datetime('now') WHERE id=?").run(e.message.slice(0, 300), order.id);
    throw e;
  }
}

module.exports = { sendToCourier, couriers };
