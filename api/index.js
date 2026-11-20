'use strict';
// Vercel serverless entry: every request is routed here (see vercel.json).
// The call scheduler runs via GET /api/cron/tick (external cron every minute).
const { createApp } = require('../src/app');

module.exports = createApp();
