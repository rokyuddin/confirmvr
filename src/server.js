'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const calls = require('./services/calls');
const sheets = require('./services/sheets');

db.open();
if (config.sessionSecret === 'dev-secret-change-me') console.warn('[warn] SESSION_SECRET is not set; using an insecure default');

createApp().listen(config.port, () => {
  console.log(`Confirm Call running on ${config.baseUrl} (port ${config.port}, voice=${config.voiceProvider})`);
});
calls.start();
sheets.start();
