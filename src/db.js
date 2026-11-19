'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  page_name TEXT NOT NULL,
  phone TEXT,                         -- seller phone for call forwarding (press 3)
  webhook_token TEXT UNIQUE NOT NULL, -- used in WooCommerce/Shopify webhook URLs
  woo_secret TEXT,
  shopify_secret TEXT,
  sheet_csv_url TEXT,
  sheet_last_sync TEXT,
  voice_mode TEXT NOT NULL DEFAULT 'tts', -- tts | recorded
  recorded_intro_url TEXT,            -- seller's own recorded greeting
  courier TEXT,                       -- steadfast | pathao | redx
  courier_config TEXT,                -- JSON credentials
  credits REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  source TEXT NOT NULL,               -- manual | sheet | woocommerce | shopify | api
  external_id TEXT,
  customer_name TEXT,
  phone TEXT NOT NULL,                -- normalized +8801XXXXXXXXX or raw if invalid
  product TEXT NOT NULL,
  amount REAL NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | calling | confirmed | cancelled | no_answer | wrong_number | callback | no_credit
  attempts INTEGER NOT NULL DEFAULT 0,
  next_call_at TEXT,                  -- ISO UTC; null when no call scheduled
  courier_status TEXT,                -- null | sent | failed
  courier_ref TEXT,
  courier_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (seller_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(next_call_at) WHERE next_call_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  attempt INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'initiated', -- initiated | answered | no_answer | busy | failed | invalid_number
  dtmf TEXT,
  duration_sec INTEGER,
  charged REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  kind TEXT NOT NULL,       -- free_call | call | topup | adjust
  credits REAL NOT NULL,    -- +topup, -call
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_topup_ref ON ledger(ref) WHERE kind = 'topup';

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  order_id INTEGER,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db;
function open(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function tx(fn) {
  const d = get();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, get, tx };
