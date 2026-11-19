'use strict';
/**
 * Generic REST adapter for a local BTRC-licensed IPTSP / voice API that supports
 * outbound IVR + DTMF. Most Bangladeshi providers expose something similar:
 *   POST {VOICE_API_URL}   Authorization: Bearer {VOICE_API_KEY}
 *   { to, caller_id, reference, callback_url, flow: {...} }
 *
 * Adjust `toProviderPayload` once you have the chosen provider's API docs —
 * the rest of the system does not need to change.
 */
const config = require('../config');

function toProviderPayload({ callId, to, callerId, script, callbackUrl }) {
  return {
    to: to.replace(/^\+/, ''),
    caller_id: callerId || config.voiceCallerId,
    reference: String(callId),
    callback_url: callbackUrl,
    flow: {
      play: script.prompts, // [{type:'audio',url}|{type:'tts',text,lang:'bn-BD'}]
      gather: script.gather, // {num_digits, timeout_sec, repeat}
      on_digit: script.onDigit, // {"3": {action:'forward', to:'+8801...'}}
    },
  };
}

async function placeCall(opts) {
  if (!config.voiceApiUrl) throw new Error('VOICE_API_URL is not configured');
  const res = await fetch(config.voiceApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.voiceApiKey}` },
    body: JSON.stringify(toProviderPayload(opts)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Voice API ${res.status}: ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { providerCallId: data.call_id || data.id || data.uuid || null };
}

module.exports = { placeCall, toProviderPayload, name: 'http' };
