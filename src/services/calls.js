'use strict';
/**
 * Call scheduler + result handling. The queue is the orders table itself
 * (orders.next_call_at), so it works on a single server (setInterval) and on
 * serverless (an external cron hits GET /api/cron/tick every minute).
 *
 * Lifecycle:
 *   pending --(due, inside call window)--> calling --(provider callback)-->
 *     dtmf 1 -> confirmed | dtmf 2 -> cancelled | dtmf 3 -> callback (forward + notify)
 *     no answer/busy/failed/no digit -> retry after 30m, then 2h, then no_answer
 *     invalid number -> wrong_number
 */
const db = require('../db');
const config = require('../config');
const billing = require('./billing');
const llm = require('./llm');
const { setStatus } = require('./orders');
const { notify } = require('./notify');
const { getProvider } = require('../voice');
const { buildScript } = require('../voice/ivr');
const tts = require('./tts');
const { clampToCallWindow, addMin, iso } = require('../util');

const STALE_CALL_MIN = 15; // a call with no callback after this is treated as no-answer
const BATCH = 25;

async function placeCallForOrder(order, now = new Date()) {
  const seller = await db.one('SELECT * FROM sellers WHERE id=?', [order.seller_id]);

  if (!(await billing.canPlaceCall(seller.id))) {
    await setStatus(order.id, 'no_credit', { next_call_at: null });
    await notify(seller.id, order.id, `ক্রেডিট শেষ: অর্ডার #${order.id} এর কল যায়নি। রিচার্জ করুন।`);
    return null;
  }

  // Atomically claim the order so concurrent ticks (multiple serverless instances) never double-dial.
  const attempt = order.attempts + 1;
  const claimed = await db.run(
    `UPDATE orders SET status='calling', attempts=?, next_call_at=NULL, updated_at=? WHERE id=? AND status=? AND attempts=?`,
    [attempt, db.now(), order.id, order.status, order.attempts]);
  if (claimed.changes !== 1) return null;

  // Natural spoken-Bangla product name via OpenRouter (cached on the order).
  if (!order.product_spoken) {
    order.product_spoken = await llm.speakableProduct(order.product);
    await db.run('UPDATE orders SET product_spoken=? WHERE id=?', [order.product_spoken, order.id]);
  }

  const provider = getProvider();
  const callId = await db.insert('INSERT INTO calls (order_id, attempt, provider, created_at) VALUES (?,?,?,?)',
    [order.id, attempt, provider.name, iso(now)]);

  try {
    const { providerCallId } = await provider.placeCall({
      callId,
      to: order.phone,
      callerId: config.voiceCallerId,
      script: await tts.resolveScript(buildScript(seller, order)),
      callbackUrl: `${config.baseUrl}/voice/callback`,
    });
    await db.run('UPDATE calls SET provider_call_id=? WHERE id=?', [providerCallId, callId]);
  } catch (e) {
    console.error(`[calls] order #${order.id} placeCall failed:`, e.message);
    await handleCallResult({ call_id: callId, status: 'failed' }, now);
  }
  return callId;
}

/** Apply a provider callback. Idempotent: a call that already ended is ignored. */
async function handleCallResult(body, now = new Date()) {
  const call = body.call_id
    ? await db.one('SELECT * FROM calls WHERE id=?', [Number(body.call_id)])
    : await db.one('SELECT * FROM calls WHERE provider_call_id=?', [String(body.provider_call_id || '')]);
  if (!call) return { ok: false, error: 'call not found' };

  const status = ['answered', 'no_answer', 'busy', 'failed', 'invalid_number'].includes(body.status) ? body.status : 'failed';
  const dtmf = String(body.dtmf ?? '').trim().slice(0, 1);

  // Close the call exactly once (guards against duplicate provider callbacks).
  const closed = await db.run(`UPDATE calls SET status=?, dtmf=?, duration_sec=?, ended_at=? WHERE id=? AND ended_at IS NULL`,
    [status, dtmf || null, Number(body.duration) || null, iso(now), call.id]);
  if (closed.changes !== 1) return { ok: true, duplicate: true };

  const order = await db.one('SELECT * FROM orders WHERE id=?', [call.order_id]);
  if (status === 'answered') {
    const charged = await billing.chargeCall(order.seller_id, call.id);
    await db.run('UPDATE calls SET charged=? WHERE id=?', [charged, call.id]);
  }

  if (status === 'invalid_number') {
    await setStatus(order.id, 'wrong_number', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '1') {
    await setStatus(order.id, 'confirmed', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '2') {
    await setStatus(order.id, 'cancelled', { next_call_at: null });
  } else if (status === 'answered' && dtmf === '3') {
    await setStatus(order.id, 'callback', { next_call_at: null });
    await notify(order.seller_id, order.id,
      `কাস্টমার কথা বলতে চায়: ${order.customer_name || ''} ${order.phone} (অর্ডার #${order.id}, ${order.product})। কল ব্যাক করুন।`);
  } else {
    await scheduleRetry(order.id, now);
  }
  return { ok: true };
}

async function scheduleRetry(orderId, now = new Date()) {
  const { attempts } = await db.one('SELECT attempts FROM orders WHERE id=?', [orderId]);
  const delay = config.retryDelaysMin[attempts - 1];
  if (delay === undefined) await setStatus(orderId, 'no_answer', { next_call_at: null });
  else await setStatus(orderId, 'pending', { next_call_at: iso(clampToCallWindow(addMin(now, delay))) });
}

/** One scheduler tick: time out stale calls, then place due calls. Returns counts. */
async function tick(now = new Date()) {
  const staleBefore = iso(addMin(now, -STALE_CALL_MIN));
  const stale = await db.all('SELECT id FROM calls WHERE ended_at IS NULL AND created_at <= ? LIMIT 100', [staleBefore]);
  for (const c of stale) await handleCallResult({ call_id: c.id, status: 'no_answer' }, now);

  let placed = 0;
  if (clampToCallWindow(now).getTime() === now.getTime()) {
    const due = await db.all(
      `SELECT * FROM orders WHERE status='pending' AND next_call_at IS NOT NULL AND next_call_at <= ? ORDER BY next_call_at LIMIT ${BATCH}`,
      [iso(now)]);
    for (const o of due) if (await placeCallForOrder(o, now)) placed++;
  }
  return { stale: stale.length, placed };
}

/** Re-queue an order manually (e.g. after topping up credit). */
async function requeue(orderId, now = new Date()) {
  await setStatus(orderId, 'pending', { attempts: 0, next_call_at: iso(clampToCallWindow(now)) });
}

let running = false;
function start() {
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error('[scheduler]', e); } finally { running = false; }
  }, config.schedulerIntervalSec * 1000);
  t.unref();
  return t;
}

module.exports = { tick, start, handleCallResult, placeCallForOrder, requeue };
