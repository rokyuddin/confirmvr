'use strict';
/**
 * Steadfast Courier (Packzy) merchant API client.
 * Base: https://portal.packzy.com/api/v1  · Auth headers: Api-Key, Secret-Key
 *
 * Endpoints used:
 *   POST /create_order                     book a parcel (invoice must be unique per account)
 *   GET  /status_by_invoice/{invoice}      { status, delivery_status }
 *   GET  /status_by_cid/{consignment_id}
 *   GET  /get_balance                      { current_balance }
 *   GET  /fraud_check/score/{phone}        customer's delivery record across all merchants
 *
 * Webhook (merchant panel → Webhook): Steadfast POSTs to our callback URL with
 *   Authorization: Bearer <auth token>, optional X-Signature (hex HMAC-SHA256 of raw body),
 *   body { notification_type: "delivery_status", consignment_id, invoice, status, cod_amount, ... }
 *   It waits 5 s for a 2xx; 5xx is retried, 4xx is never retried.
 *
 * Steadfast has no sandbox: every booking on a live key is a real parcel.
 */
const BASE = process.env.STEADFAST_BASE_URL || 'https://portal.packzy.com/api/v1';

const LIMITS = { invoice: 100, recipient_name: 100, recipient_address: 490, note: 480, item_description: 255 };

const DELIVERY_STATUS_BN = {
  in_review: 'রিভিউতে',
  pending: 'ডেলিভারির অপেক্ষায়',
  hold: 'হোল্ড',
  delivered_approval_pending: 'ডেলিভারড (অনুমোদন বাকি)',
  partial_delivered_approval_pending: 'আংশিক ডেলিভারড (অনুমোদন বাকি)',
  cancelled_approval_pending: 'বাতিল (অনুমোদন বাকি)',
  unknown_approval_pending: 'অনুমোদন বাকি',
  delivered: 'ডেলিভারড',
  partial_delivered: 'আংশিক ডেলিভারড',
  cancelled: 'রিটার্ন',
  exceptional: 'সমস্যা',
  unknown: 'অজানা',
};

class SteadfastError extends Error {
  constructor(kind, message, httpStatus, body) {
    super(message);
    this.kind = kind; // validation | duplicate | auth | forbidden | not_found | rate_limited | unavailable
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

function kindFor(status) {
  if (status === 409) return 'duplicate';
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

function messageFrom(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.errors && typeof body.errors === 'object') {
    const first = Object.values(body.errors).flat()[0];
    if (first) return String(first);
  }
  return body.message ? String(body.message) : null;
}

/** "+880 1712-345678" -> "01712345678", or null. */
function sfPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

const clean = (s, max) => String(s ?? '').replace(/[<>;]/g, ' ').trim().slice(0, max);

function client({ api_key, secret_key }, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!api_key || !secret_key) throw new SteadfastError('auth', 'Steadfast api_key and secret_key are required');

  async function request(method, path, body) {
    let res, text;
    try {
      res = await fetchImpl(BASE + path, {
        method,
        headers: { 'Api-Key': api_key, 'Secret-Key': secret_key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', // never forward the key headers to a redirect target
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new SteadfastError('unavailable', `Steadfast request failed: ${e.message}`);
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new SteadfastError(kindFor(res.status), messageFrom(data) || `HTTP ${res.status} from ${path}`, res.status, data ?? text);
    if (!data || typeof data !== 'object') throw new SteadfastError('unavailable', `non-JSON response from ${path}`, res.status, text);
    // Steadfast sometimes answers HTTP 200 with { status: 4xx } in the body.
    if (typeof data.status === 'number' && data.status >= 400) {
      throw new SteadfastError(kindFor(data.status), messageFrom(data) || `status ${data.status} from ${path}`, res.status, data);
    }
    return data;
  }

  return {
    /** Book one parcel. Returns the consignment { consignment_id, tracking_code, status, ... }. */
    async createOrder(o) {
      const invoice = String(o.invoice || '');
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(invoice)) throw new SteadfastError('validation', 'invoice: letters, digits, - and _ only (max 100)');
      const phone = sfPhone(o.recipient_phone);
      if (!phone) throw new SteadfastError('validation', 'recipient_phone is not a valid BD mobile number');
      const address = clean(o.recipient_address, LIMITS.recipient_address);
      if (address.length < 3) throw new SteadfastError('validation', 'recipient_address is required');
      const cod = Math.round(Number(o.cod_amount));
      if (!(cod >= 0 && cod <= 1_000_000)) throw new SteadfastError('validation', 'cod_amount must be 0–1,000,000 taka');
      const payload = {
        invoice,
        recipient_name: clean(o.recipient_name || 'Customer', LIMITS.recipient_name),
        recipient_phone: phone,
        recipient_address: address,
        cod_amount: cod,
      };
      if (o.note) payload.note = clean(o.note, LIMITS.note);
      if (o.item_description) payload.item_description = clean(o.item_description, LIMITS.item_description);
      if (o.alternative_phone && sfPhone(o.alternative_phone)) payload.alternative_phone = sfPhone(o.alternative_phone);
      const data = await request('POST', '/create_order', payload);
      if (!data.consignment) throw new SteadfastError('unavailable', 'create_order response has no consignment', 200, data);
      return data.consignment;
    },
    async statusByInvoice(invoice) { return (await request('GET', `/status_by_invoice/${encodeURIComponent(invoice)}`)).delivery_status; },
    async statusByConsignmentId(id) { return (await request('GET', `/status_by_cid/${encodeURIComponent(id)}`)).delivery_status; },
    async balance() { return Number((await request('GET', '/get_balance')).current_balance); },
    async fraudCheck(phone) {
      const p = sfPhone(phone);
      if (!p) throw new SteadfastError('validation', 'invalid phone');
      const { status, ...score } = await request('GET', `/fraud_check/score/${p}`);
      return score; // { delivery_ratio, cancellation_ratio, volume_band, total_reports, ... }
    },
  };
}

module.exports = { client, SteadfastError, DELIVERY_STATUS_BN, sfPhone, BASE };
