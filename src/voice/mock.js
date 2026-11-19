'use strict';
/**
 * Mock provider for local development. No real call is placed.
 * - Outcomes can be simulated from the dashboard ("Simulate" buttons) or via
 *   POST /voice/callback.
 * - If MOCK_AUTO_ANSWER is set (e.g. "1"), the call auto-completes with that digit
 *   ("none" = no answer, "invalid" = wrong number).
 */
const crypto = require('node:crypto');
const config = require('../config');

const placed = []; // in-memory log for tests

async function placeCall({ callId, to, script, callbackUrl }) {
  const providerCallId = 'mock-' + crypto.randomUUID();
  placed.push({ callId, to, script, providerCallId });
  if (config.mockAutoAnswer) {
    setTimeout(() => {
      const a = config.mockAutoAnswer;
      const body =
        a === 'none' ? { call_id: callId, status: 'no_answer' }
        : a === 'invalid' ? { call_id: callId, status: 'invalid_number' }
        : { call_id: callId, status: 'answered', dtmf: a, duration: 20 };
      // Use the in-process handler directly to avoid needing a public URL.
      require('../services/calls').handleCallResult(body).catch((e) => console.error('[mock]', e));
    }, 500).unref();
  }
  console.log(`[mock-voice] call #${callId} -> ${to}\n  ${script.prompts.map((p) => p.text || p.url).join(' | ')}`);
  return { providerCallId };
}

module.exports = { placeCall, placed, name: 'mock' };
