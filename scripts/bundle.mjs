// Packs dist/ into a web bundle and signs it, then writes the update manifest.
//
// Documentation:
//   https://github.com/WICG/webpackage/tree/main/js/bundle
//   https://github.com/WICG/webpackage/tree/main/js/sign
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleBuilder } from 'wbn';
import {
  NodeCryptoSigningStrategy,
  SignedWebBundle,
  WebBundleId,
  parsePemKey,
} from 'wbn-sign';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const KEY_FILE = process.env.KEYFILE ?? join(ROOT, 'private.pem');

// Files that this script writes. They must never go inside the bundle.
const OUTPUTS = new Set(['app.swbn', 'app.wbn', 'update.json']);

const MIME = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function mimeOf(path) {
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] ?? 'application/octet-stream';
}

/** Every file under a directory, as paths relative to it, sorted. */
function walk(directory, prefix = '') {
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, rel));
    } else {
      found.push(rel);
    }
  }
  return found;
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html is missing. Run make build first.');
  process.exit(1);
}

const manifestPath = join(DIST, '.well-known', 'manifest.webmanifest');
if (!existsSync(manifestPath)) {
  console.error('dist/.well-known/manifest.webmanifest is missing. Run make build first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
if (typeof version !== 'string') {
  console.error('The manifest has no version field. An Isolated Web App needs one.');
  process.exit(1);
}

// The signing key decides the identity of the application. Without it the
// script still builds an unsigned bundle, which is useful in a pull request.
let privateKey = null;
if (existsSync(KEY_FILE)) {
  privateKey = parsePemKey(readFileSync(KEY_FILE, 'utf8'), process.env.KEY_PASSPHRASE);
} else {
  console.warn(`! ${KEY_FILE} is absent. The bundle will not be signed.`);
  console.warn('! Run make key to generate one.');
}

// A signed bundle holds absolute URLs under its own isolated-app origin.
const baseURL = privateKey
  ? new WebBundleId(privateKey).serializeWithIsolatedWebAppOrigin()
  : '/';

const builder = new BundleBuilder('b2');
builder.setPrimaryURL(baseURL);

const files = walk(DIST).filter((path) => !OUTPUTS.has(path));
for (const path of files) {
  const url = baseURL === '/' ? `/${path}` : `${baseURL}${path}`;
  const body = readFileSync(join(DIST, path.split('/').join(sep)));
  builder.addExchange(url, 200, { 'Content-Type': mimeOf(path) }, body);
}

// The start URL of the manifest is /index.html, and a click on the icon opens
// the origin root. Both must answer, so the root repeats the start page.
builder.addExchange(
  baseURL,
  200,
  { 'Content-Type': MIME['.html'] },
  readFileSync(join(DIST, 'index.html')),
);

const webBundle = builder.createBundle();
console.log(`Packed ${files.length + 1} files, ${webBundle.length} bytes.`);

let outputName = 'app.wbn';
let bundleId = null;
let output = webBundle;

if (privateKey) {
  const signed = await SignedWebBundle.fromWebBundle(webBundle, [
    new NodeCryptoSigningStrategy(privateKey),
  ]);
  output = signed.getSignedWebBundleBytes();
  bundleId = signed.getWebBundleId();
  outputName = 'app.swbn';
}

const outputPath = join(DIST, outputName);
writeFileSync(outputPath, output);

// The update manifest tells Chrome which versions exist. Its version field and
// the manifest version field are the same value, so they cannot drift.
writeFileSync(
  join(DIST, 'update.json'),
  `${JSON.stringify({ versions: [{ version, src: outputName }] }, null, 2)}\n`,
);

console.log('');
console.log(`Wrote  dist/${outputName}   (${output.length} bytes, version ${version})`);
console.log('Wrote  dist/update.json');
if (bundleId) {
  console.log('');
  console.log(`  Web Bundle ID:           ${bundleId}`);
  console.log(`  Isolated Web App Origin: isolated-app://${bundleId}/`);
  console.log('');
  console.log('To install the bundle:');
  console.log('  1. Open chrome://flags/#enable-isolated-web-app-dev-mode and turn it on.');
  console.log('  2. Restart Chrome.');
  console.log('  3. Open chrome://web-app-internals.');
  console.log('  4. Under "Install IWA from Signed Web Bundle", choose dist/app.swbn.');
  console.log('');
  console.log('The command line does the same thing:');
  console.log('  google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \\');
  console.log(`      --install-isolated-web-app-from-file=${outputPath}`);
} else {
  console.log('');
  console.log('The bundle is not signed, so Chrome cannot install it.');
}
