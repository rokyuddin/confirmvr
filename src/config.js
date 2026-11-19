'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no dependency).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

module.exports = {
  port: num('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000'),
  dbPath: env('DB_PATH', path.join(__dirname, '..', 'data', 'confirmvr.db')),
  sessionSecret: env('SESSION_SECRET', 'dev-secret-change-me'),
  adminToken: env('ADMIN_TOKEN', ''),

  // Calling rules
  callWindowStartHour: num('CALL_WINDOW_START', 9), // 9am Dhaka
  callWindowEndHour: num('CALL_WINDOW_END', 21), // 9pm Dhaka
  firstCallDelayMin: num('FIRST_CALL_DELAY_MIN', 2),
  retryDelaysMin: env('RETRY_DELAYS_MIN', '30,120').split(',').map(Number), // 30 min, then 2 h
  schedulerIntervalSec: num('SCHEDULER_INTERVAL_SEC', 15),
  sheetSyncIntervalMin: num('SHEET_SYNC_INTERVAL_MIN', 5),

  // Billing
  freeCallsPerMonth: num('FREE_CALLS_PER_MONTH', 50),
  creditsPerCall: num('CREDITS_PER_CALL', 1),
  takaPerCredit: num('TAKA_PER_CREDIT', 1.5),

  // Voice provider: "mock" (local testing) or "http" (generic BTRC-licensed IPTSP REST API)
  voiceProvider: env('VOICE_PROVIDER', 'mock'),
  voiceApiUrl: env('VOICE_API_URL', ''),
  voiceApiKey: env('VOICE_API_KEY', ''),
  voiceCallerId: env('VOICE_CALLER_ID', ''),
  voiceWebhookSecret: env('VOICE_WEBHOOK_SECRET', ''),
  mockAutoAnswer: env('MOCK_AUTO_ANSWER', ''), // e.g. "1" to auto-press 1 in mock mode

  // Bangla TTS (optional). If unset, the provider receives text and synthesizes itself.
  ttsUrl: env('TTS_URL', ''),
  ttsApiKey: env('TTS_API_KEY', ''),

  // Risk flags
  riskCancelThreshold: num('RISK_CANCEL_THRESHOLD', 2),
  riskNoAnswerThreshold: num('RISK_NO_ANSWER_THRESHOLD', 2),

  // bKash top-up verification webhook secret
  bkashWebhookSecret: env('BKASH_WEBHOOK_SECRET', ''),
};
