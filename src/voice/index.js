'use strict';
/**
 * Voice provider abstraction.
 *
 * Every provider implements:
 *   placeCall({ callId, to, callerId, script, callbackUrl }) -> Promise<{ providerCallId }>
 *
 * The provider must later POST the outcome to `callbackUrl` (see routes/voice.js):
 *   { call_id, status: answered|no_answer|busy|failed|invalid_number, dtmf: "1"|"2"|"3"|"", duration }
 *
 * `script` is a provider-neutral IVR description built by ivr.js. Adapters for a specific
 * BTRC-licensed IPTSP translate it into that provider's format (XML/JSON call-flow).
 */
const config = require('../config');
const mock = require('./mock');
const http = require('./http');

const providers = { mock, http };

function getProvider(name = config.voiceProvider) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown VOICE_PROVIDER "${name}"`);
  return p;
}

module.exports = { getProvider, providers };
