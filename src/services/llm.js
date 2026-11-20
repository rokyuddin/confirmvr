'use strict';
/**
 * OpenRouter (OpenAI-compatible chat API) helpers. Every function degrades gracefully:
 * with no OPENROUTER_API_KEY or on any error, it returns a safe fallback so calls and
 * order intake never depend on the LLM being up.
 *
 * Uses:
 *  1. speakableProduct  – turn "Men's Polo T-shirt (XL) x2" into natural spoken Bangla
 *                         for the TTS part of the IVR call.
 *  2. parseOrderText    – pull name/phone/product/amount/address out of a pasted
 *                         Messenger/WhatsApp order message.
 */
const config = require('../config');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

async function chatJson(system, user, { maxTokens = 300, timeoutMs = 12000 } = {}) {
  if (!config.openrouterApiKey) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.baseUrl,
        'X-Title': 'Confirm Call',
      },
      body: JSON.stringify({
        model: config.openrouterModel,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const json = text.match(/\{[\s\S]*\}/);
    return json ? JSON.parse(json[0]) : null;
  } catch (e) {
    console.error('[llm]', e.message);
    return null;
  }
}

const SPEAK_SYSTEM = `You prepare product names for a Bangla text-to-speech phone call in Bangladesh.
Rewrite the product as it should be SPOKEN in natural Bangla (Bengali script), short (max 12 words).
Transliterate English brand/product words into Bengali script, write quantities as Bangla words
(e.g. "x2" -> "দুইটা"), sizes like XL as "এক্স এল". Drop SKU codes, emojis and symbols.
Do not add anything that is not in the input. Reply JSON: {"spoken": "..."}`;

/** Returns spoken-Bangla product text, or the original product on fallback. */
async function speakableProduct(product) {
  const p = String(product || '').trim();
  if (!p) return p;
  // Already plain Bangla without digits/symbols: nothing to fix.
  if (/^[ঀ-৿\s,।]+$/.test(p)) return p;
  const out = await chatJson(SPEAK_SYSTEM, p.slice(0, 300), { maxTokens: 120 });
  const spoken = typeof out?.spoken === 'string' ? out.spoken.trim() : '';
  return spoken && spoken.length <= 200 ? spoken : p;
}

const PARSE_SYSTEM = `Extract one e-commerce order from a customer's message (Bangla, English or Banglish).
Reply JSON with keys: customer_name, phone, product, amount, address.
- phone: Bangladeshi mobile as written (digits only), or "" if absent.
- amount: total payable in taka as a number, or null if not stated. Never guess a price.
- Use "" for unknown text fields. Do not invent data.`;

/** Returns {customer_name, phone, product, amount, address} or null. */
async function parseOrderText(text) {
  const out = await chatJson(PARSE_SYSTEM, String(text || '').slice(0, 2000));
  if (!out || typeof out !== 'object') return null;
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    customer_name: s(out.customer_name),
    phone: s(out.phone),
    product: s(out.product),
    amount: typeof out.amount === 'number' || /^\d+(\.\d+)?$/.test(String(out.amount)) ? Number(out.amount) : null,
    address: s(out.address),
  };
}

const enabled = () => Boolean(config.openrouterApiKey);

module.exports = { speakableProduct, parseOrderText, chatJson, enabled };
