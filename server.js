'use strict';

const express = require('express');
const path = require('node:path');
const { chatHandler } = require('./functions/api/chat');
const runtimeConfig = require('./config/runtime-config.json');

const app = express();
const publicDirectory = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Firebase web configuration is public client configuration. Secrets and Google
// credentials are never returned from this endpoint.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const firebaseConfig = runtimeConfig.firebase;
  const configured = ['apiKey', 'authDomain', 'projectId', 'appId']
    .every((key) => typeof firebaseConfig[key] === 'string' && firebaseConfig[key].length > 0);
  res.status(200).json({
    configured,
    firebaseConfig: configured ? firebaseConfig : null
  });
});

app.post('/api/chat', chatHandler);

// The runtime configuration file lives outside public/. Block direct URL guesses explicitly.
app.use('/config', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(publicDirectory, {
  dotfiles: 'ignore',
  index: 'index.html',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDirectory, 'index.html'));
});

const port = Number(process.env.PORT || 8080);

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log('TruX Code listening on port ' + port);
  });
}

module.exports = app;
