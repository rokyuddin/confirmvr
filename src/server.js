'use strict';
// Long-running server (local dev, VPS, Railway...). On Vercel, api/index.js is used instead.
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const calls = require('./services/calls');
const sheets = require('./services/sheets');

if (config.sessionSecret === 'dev-secret-change-me') console.warn('[warn] SESSION_SECRET is not set; using an insecure default');

db.init().then(() => {
  createApp().listen(config.port, () => {
    console.log(`Confirm Call running on ${config.baseUrl} (port ${config.port}, db=${db.get().dialect}, voice=${config.voiceProvider})`);
  });
  calls.start();
  sheets.start();
}).catch((e) => { console.error('DB init failed:', e); process.exit(1); });
