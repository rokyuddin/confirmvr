'use strict';
/**
 * Async database layer with two backends:
 *  - Postgres (Neon / Vercel) when DATABASE_URL is set
 *  - built-in node:sqlite otherwise (local dev, tests)
 *
 * Write SQL once with `?` placeholders; the Postgres adapter rewrites them to $1..$n.
 * Timestamps are stored as ISO-8601 TEXT generated in JS (now()), so comparisons are
 * plain string comparisons on both backends.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const now = () => new Date().toISOString();

const TABLES = `
CREATE TABLE IF NOT EXISTS sellers (
  id @PK,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  page_name TEXT NOT NULL,
  phone TEXT,
  webhook_token TEXT UNIQUE NOT NULL,
  woo_secret TEXT,
  shopify_secret TEXT,
  sheet_csv_url TEXT,
  sheet_last_sync TEXT,
  voice_mode TEXT NOT NULL DEFAULT 'tts',
  recorded_intro_url TEXT,
  courier TEXT,
  courier_config TEXT,
  steadfast_webhook_token TEXT,
  credits @REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id @PK,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  source TEXT NOT NULL,
  external_id TEXT,
  customer_name TEXT,
  phone TEXT NOT NULL,
  product TEXT NOT NULL,
  product_spoken TEXT,
  amount @REAL NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_call_at TEXT,
  courier_status TEXT,
  courier_ref TEXT,
  courier_tracking TEXT,
  courier_delivery_status TEXT,
  courier_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (seller_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(next_call_at) WHERE next_call_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, status);
CREATE TABLE IF NOT EXISTS calls (
  id @PK,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  attempt INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'initiated',
  dtmf TEXT,
  duration_sec INTEGER,
  charged @REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_open ON calls(created_at) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS ledger (
  id @PK,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  kind TEXT NOT NULL,
  credits @REAL NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_topup_ref ON ledger(ref) WHERE kind = 'topup';
CREATE INDEX IF NOT EXISTS idx_ledger_seller ON ledger(seller_id, kind, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id @PK,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  order_id INTEGER,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tts_cache (
  hash TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  audio_b64 TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topup_requests (
  id @PK,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  amount @REAL NOT NULL,
  trx_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
`;

function schemaFor(dialect) {
  return dialect === 'pg'
    ? TABLES.replaceAll('@PK', 'SERIAL PRIMARY KEY').replaceAll('@REAL', 'DOUBLE PRECISION')
    : TABLES.replaceAll('@PK', 'INTEGER PRIMARY KEY AUTOINCREMENT').replaceAll('@REAL', 'REAL');
}

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

// node:sqlite may return BigInt for large integers; normalize to Number.
function fixRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

function makeSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const h = {
    dialect: 'sqlite',
    async all(sql, p = []) { return d.prepare(sql).all(...p).map(fixRow); },
    async one(sql, p = []) { return fixRow(d.prepare(sql).get(...p)) || null; },
    async run(sql, p = []) { return { changes: Number(d.prepare(sql).run(...p).changes) }; },
    async insert(sql, p = []) { return Number(d.prepare(sql).run(...p).lastInsertRowid); },
    async exec(sql) { d.exec(sql); },
    async close() { d.close(); },
  };
  let chain = Promise.resolve(); // serialize transactions on the single connection
  h.tx = (fn) => {
    const run = chain.then(async () => {
      d.exec('BEGIN');
      try { const r = await fn(h); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
    });
    chain = run.catch(() => {});
    return run;
  };
  return h;
}

function makePg(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, Number); // COUNT()/SUM() of ints come back as int8 -> number
  types.setTypeParser(1700, Number); // NUMERIC -> number
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 5), ssl: local ? false : { rejectUnauthorized: true } });
  const wrap = (q) => ({
    dialect: 'pg',
    async all(sql, p = []) { return (await q.query(toPg(sql), p)).rows.map(fixRow); },
    async one(sql, p = []) { return fixRow((await q.query(toPg(sql), p)).rows[0]) || null; },
    async run(sql, p = []) { return { changes: (await q.query(toPg(sql), p)).rowCount }; },
    async insert(sql, p = []) { return Number((await q.query(toPg(sql) + ' RETURNING id', p)).rows[0].id); },
    async exec(sql) { await q.query(sql); },
  });
  const h = wrap(pool);
  h.tx = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(wrap(c));
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  };
  h.close = () => pool.end();
  return h;
}

let handle = null;
let ready = null;

/** Open (once) and migrate. Safe to call on every request in serverless. */
function init(opts = {}) {
  if (ready && !opts.force) return ready;
  const url = opts.url !== undefined ? opts.url : config.databaseUrl;
  handle = url ? makePg(url) : makeSqlite(opts.file || config.dbPath);
  ready = handle.exec(schemaFor(handle.dialect)).then(() => handle);
  return ready;
}

function get() {
  if (!handle) throw new Error('db.init() has not been called');
  return handle;
}

// Proxy helpers so callers can write `db.one(...)` directly.
module.exports = {
  init,
  get,
  now,
  all: (...a) => get().all(...a),
  one: (...a) => get().one(...a),
  run: (...a) => get().run(...a),
  insert: (...a) => get().insert(...a),
  tx: (fn) => get().tx(fn),
  close: async () => { if (handle) await handle.close(); handle = null; ready = null; },
  schemaFor,
};
