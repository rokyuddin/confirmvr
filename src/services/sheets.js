'use strict';
/**
 * Google Sheet sync. The seller publishes the sheet as CSV
 * (File → Share → Publish to web → CSV) and pastes the link.
 *
 * Header row is matched flexibly (English or Bangla):
 *   order_id/অর্ডার, name/নাম, phone/মোবাইল/ফোন, product/প্রোডাক্ট, amount/price/দাম/টাকা, address/ঠিকানা
 * Rows without an order id use the row number as the id, so re-syncing never duplicates.
 */
const db = require('../db');
const config = require('../config');
const { parseCsv } = require('../util');
const { createOrder } = require('./orders');

const HEADERS = {
  external_id: ['order_id', 'order id', 'id', 'অর্ডার', 'অর্ডার আইডি', 'invoice'],
  customer_name: ['name', 'customer', 'customer name', 'নাম', 'কাস্টমার'],
  phone: ['phone', 'mobile', 'number', 'phone number', 'মোবাইল', 'ফোন', 'নম্বর'],
  product: ['product', 'item', 'products', 'প্রোডাক্ট', 'পণ্য'],
  amount: ['amount', 'price', 'total', 'cod', 'দাম', 'টাকা', 'মোট'],
  address: ['address', 'ঠিকানা'],
};

function mapHeader(row) {
  const idx = {};
  row.forEach((h, i) => {
    const k = h.replace(/^\ufeff/, '').trim().toLowerCase();
    for (const [field, names] of Object.entries(HEADERS)) if (idx[field] === undefined && names.includes(k)) idx[field] = i;
  });
  return idx;
}

async function importCsv(sellerId, csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { created: 0, skipped: 0, errors: [] };
  const idx = mapHeader(rows[0]);
  for (const f of ['phone', 'product', 'amount']) if (idx[f] === undefined) throw new Error(`Sheet column missing: ${f}`);
  let created = 0, skipped = 0;
  const errors = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const pick = (f) => (idx[f] === undefined ? '' : (r[idx[f]] || '').trim());
    try {
      const res = await createOrder(sellerId, {
        source: 'sheet',
        external_id: pick('external_id') || `row-${i + 2}`,
        customer_name: pick('customer_name'),
        phone: pick('phone'),
        product: pick('product'),
        amount: pick('amount'),
        address: pick('address'),
      });
      res.created ? created++ : skipped++;
    } catch (e) {
      errors.push(`row ${i + 2}: ${e.message}`);
    }
  }
  return { created, skipped, errors };
}

async function syncSeller(seller) {
  if (!seller.sheet_csv_url) return null;
  const res = await fetch(seller.sheet_csv_url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const out = await importCsv(seller.id, await res.text());
  await db.run('UPDATE sellers SET sheet_last_sync=? WHERE id=?', [db.now(), seller.id]);
  return out;
}

/** Sync every seller whose sheet was not synced in the last SHEET_SYNC_INTERVAL_MIN. */
async function syncAll(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.sheetSyncIntervalMin * 60e3 + 30e3).toISOString();
  const sellers = await db.all(
    `SELECT * FROM sellers WHERE sheet_csv_url IS NOT NULL AND sheet_csv_url != '' AND (sheet_last_sync IS NULL OR sheet_last_sync <= ?) LIMIT 20`, [cutoff]);
  for (const s of sellers) {
    try { await syncSeller(s); } catch (e) { console.error(`[sheets] seller #${s.id}:`, e.message); }
  }
}

function start() {
  const t = setInterval(() => syncAll().catch(console.error), config.sheetSyncIntervalMin * 60e3);
  t.unref();
  return t;
}

module.exports = { importCsv, syncSeller, syncAll, start, mapHeader };
