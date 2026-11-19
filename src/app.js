'use strict';
const path = require('node:path');
const express = require('express');
const auth = require('./auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const keepRaw = (req, _res, buf) => { req.rawBody = buf; };
  app.use(express.json({ limit: '1mb', verify: keepRaw }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', verify: keepRaw }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(require('./routes/integrations'));
  app.use(auth.loadSeller);
  app.use(require('./routes/web'));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).send('Server error');
  });
  return app;
}

module.exports = { createApp };
