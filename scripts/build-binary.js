'use strict';

// Builds a standalone program (no Node.js needed on the user's computer) for the platform this runs on, using
// Node's single-executable support. The CLI is bundled and minified first, then injected into a copy of the node
// binary. Run it on each target operating system (see .github/workflows/build-cli.yml).
//   node scripts/build-binary.js            -> dist/bin/trux-code-<os>-<arch>[.exe]
// Honest note: this makes the code harder to read, not impossible. Keep real secrets and logic on the server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trux-sea-'));
const plat = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform];
if (!plat) throw new Error('Unsupported platform: ' + process.platform);
const name = `trux-code-${plat}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const outDir = path.join(root, 'dist', 'bin');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, name);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' failed');
}

// 1. One minified CommonJS file (single-executable apps load a CommonJS entry).
const bundle = path.join(work, 'trux-code.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'cli', 'trux-code.mjs')], outfile: bundle, bundle: true, minify: true,
  format: 'cjs', platform: 'node', target: 'node22', legalComments: 'none', charset: 'utf8', logLevel: 'warning',
  banner: { js: '' }
});

// 2. Blob for the single-executable app.
const config = path.join(work, 'sea-config.json');
const blob = path.join(work, 'sea.blob');
fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', config]);

// 3. Copy node, inject the blob.
fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (process.platform === 'darwin') spawnSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
const inject = [require.resolve('postject/dist/cli.js'), out, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') inject.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, inject);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', out]); // macOS refuses to run unsigned binaries on Apple silicon

fs.rmSync(work, { recursive: true, force: true });
console.log('Built ' + path.relative(root, out) + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB)');
