'use strict';

// Writes the v3 patches permanently into public/index.html.  Usage: npm run bake
// Afterwards the runtime patch layer finds everything "already applied" and does nothing.
const fs = require('node:fs');
const path = require('node:path');
const { applyPatches } = require('../functions/html-patches');

const file = path.join(__dirname, '..', 'public', 'index.html');
const { html, report } = applyPatches(fs.readFileSync(file, 'utf8'), { version: String(Date.now()) });
report.forEach((item) => console.log(item.status.padEnd(16), item.name));
fs.writeFileSync(file, html);
console.log('Wrote ' + file);
