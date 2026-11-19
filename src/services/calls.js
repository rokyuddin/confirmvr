'use strict';
/**
 * Call scheduler + result handling (DB-backed queue; no Redis needed for MVP).
 *
 * Lifecycle:
 *   pending --(due, in call window)--> calling --(result)-->
 *     dtmf 1 -> confirmed | dtmf 2 -> cancelled | dtmf 3 -> callback (forward + notify)
 *     no answer/busy/failed/answered-without-digit -> retry after 30m, then 2h, then no_answer
 *     invalid number -> wrong_number
 */
const db = require('../db');
const config = require('../config');
const billing = require('./billing');
const { setStatus } = require('./orders');
const { notify } = require('./notify');
const { getProvider } = require('../voice');
const { buildScript } = require('../voice/ivr');
const { clampToCallWindow, addMin, iso } = require('../util');

const STALE_CALL_MIN = 15; // a call with no callback after this is treated as no-answer

let running = false;

async function placeCallForOrder(order, now = new Date()) {
  const d = db.get();
  const seller = d.prepare('SELECT * FROM sellers WHERE id=?').get(order.seller_id);

  if (!billing.canPlaceCall(seller.id)) {
    setStatus(order.id, 'no_credit', { next_call_at: null });
    notify(seller.id, order.id, `ক্রেডিট শেষ: অর্ডার #${order.id} এর কল যায়নি। রিচার্জ করুন।`);
    return null;
  }

  const attempt = order.attempts + 1;
  const provider = getProvider();
  const callId = d.prepare('INSERT INTO calls (order_id, attempt, provider) VALUES (?,?,?)').run(order.id, attempt, provider.name).lastInsertRowid;
  // Claim the order before the network call so the next tick doesn't double-dial.
  setStatus(order.id, 'calling', { attempts: attempt, next_call_at: null });

  try {
    const { providerCallId } = await provider.placeCall({
      callId: Number(callId),
      to: order.phone,
      callerId: config.voiceCallerId,
      script: buildScript(seller, order),
      callbackUrl: `${config.baseUrl}/voice/callback`,
    });
    d.prepare('UPDATE calls SET provider_call_id=? WHERE id=?').run(providerCallId, callId);
  } catch (e) {
    console.error(`[calls] order #${order.id} placeCall failed:`, e.message);
    await handleCallResult({ call_id: callId, status: 'failed' }, now);
  }
  return Number(callId);
}

/** Apply a provider callback. Idempotent: a call that already ended is ignored. */
async function handleCallResult(body, now = new Date()) {
  const d = db.get();
  const call = body.call_id
    ? d.prepare('SELECT * FROM calls WHERE id=?').get(Number(body.call_id))
    : d.prepare('SELECT * FROM calls WHERE provider_call_id=?').get(String(body.provider_call_id || ''));
  if (!call) return { ok: false, error: 'call not found' };
  if (call.ended_at) return { ok: true, duplicate: true };

  const order = d.prepare('SELECT * FROM orders WHERE id=?').get(call.order_id);
  const seller = d.prepare('SELECT * FROM sellers WHERE id=?').get(order.seller_id);
  const status = ['answered', 'no_answer', 'busy', 'failed', 'invalid_number'].includes(body.status) ? body.status : 'failed';
  const dtmf = String(body.dtmf || '').trim().slice(0, 1);

  let charged = 0;
  if (status === 'answered') charged = billing.chargeCall(seller.id, call.id);
  d.prepare(`UPDATE calls SET status=?, dtmf=?, duration_sec=?, charged=?, ended_at=datetime('now') WHERE id=?`)
    .run(status, dtmf || null, Number(body.duration) || null, charged, call.id);

  if (status === 'invalid_number') {
    setStatus(order.id, 'wrong_number', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '1') {
    setStatus(order.id, 'confirmed', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '2') {
    setStatus(order.id, 'cancelled', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '3') {
    setStatus(order.id, 'callback', { next_call_at: null });
    notify(seller.id, order.id,
      `কাস্টমার কথা বলতে চায়: ${order.customer_name || ''} ${order.phone} (অর্ডার #${order.id}, ${order.product})। কল ব্যাক করুন।`);
  } else {
    scheduleRetry(order, now);
  }
  return { ok: true };
}

function scheduleRetry(order, now = new Date()) {
  const fresh = db.get().prepare('SELECT attempts FROM orders WHERE id=?').get(order.id);
  const delay = config.retryDelaysMin[fresh.attempts - 1];
  if (delay === undefined) {
    setStatus(order.id, 'no_answer', { next_call_at: null });
  } else {
    setStatus(order.id, 'pending', { next_call_at: iso(clampToCallWindow(addMin(now, delay))) });
  }
}

/** One scheduler tick: place due calls, time out stale calls. */
async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const d = db.get();
    // Calls whose provider never reported back.
    const stale = d.prepare(
      `SELECT c.id FROM calls c WHERE c.ended_at IS NULL AND c.created_at <= datetime(?, ?)`
    ).all(iso(now).replace('T', ' ').slice(0, 19), `-${STALE_CALL_MIN} minutes`);
    for (const c of stale) await handleCallResult({ call_id: c.id, status: 'no_answer' }, now);

    // Only dial inside the call window.
    if (clampToCallWindow(now).getTime() !== now.getTime()) return;
    const due = d.prepare(
      `SELECT * FROM orders WHERE status='pending' AND next_call_at IS NOT NULL AND next_call_at <= ? ORDER BY next_call_at LIMIT 50`
    ).all(iso(now));
    for (const o of due) await placeCallForOrder(o, now);
  } finally {
    running = false;
  }
}

/** Re-queue an order manually (e.g. after topping up credit). */
function requeue(orderId, now = new Date()) {
  setStatus(orderId, 'pending', { attempts: 0, next_call_at: iso(clampToCallWindow(now)) });
}

function start() {
  const t = setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), config.schedulerIntervalSec * 1000);
  t.unref();
  return t;
}

module.exports = { tick, start, handleCallResult, placeCallForOrder, requeue };
