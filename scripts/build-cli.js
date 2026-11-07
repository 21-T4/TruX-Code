'use strict';

// Builds the file people download: cli/trux-code.mjs -> dist/trux-code.mjs, minified with comments removed and every
// local name shortened. The readable source in cli/ is never served; server.js only serves dist/.
// Usage: npm run build:cli
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const entry = path.join(root, 'cli', 'trux-code.mjs');
const outfile = path.join(root, 'dist', 'trux-code.mjs');

fs.mkdirSync(path.dirname(outfile), { recursive: true });
esbuild.buildSync({
  entryPoints: [entry],
  outfile,
  bundle: false,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning'
});

// esbuild keeps the #! line; make sure it is there so `trux-code` runs directly after chmod +x.
const built = fs.readFileSync(outfile, 'utf8');
if (!built.startsWith('#!')) fs.writeFileSync(outfile, '#!/usr/bin/env node\n' + built);

const kb = (fs.statSync(outfile).size / 1024).toFixed(1);
console.log('Built dist/trux-code.mjs (' + kb + ' KB, minified)');
