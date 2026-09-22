// Builds the GitHub Pages site.
//
// The site gives two ways to use the application:
//
//  1. The relay. Download one binary, run it, open the page that it serves.
//     This needs no Chrome flag and no bundle.
//  2. The signed web bundle, for a Chrome that supports Isolated Web Apps.
//
// GitHub Pages cannot run the application itself. A web page cannot open a TCP
// socket, and an Isolated Web App reads its manifest from the absolute path
// /.well-known/manifest.webmanifest, which a project site cannot answer.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBundleId } from 'wbn-sign';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const BIN = join(ROOT, 'bin');
const SITE = join(ROOT, 'site');

const manifest = JSON.parse(
  readFileSync(join(DIST, '.well-known', 'manifest.webmanifest'), 'utf8'),
);

const RELAYS = [
  ['browser-ssh-linux-amd64', 'Linux', 'x86-64'],
  ['browser-ssh-linux-arm64', 'Linux', 'ARM64'],
  ['browser-ssh-macos-arm64', 'macOS', 'Apple silicon'],
  ['browser-ssh-windows-amd64.exe', 'Windows', 'x86-64'],
];

mkdirSync(SITE, { recursive: true });
copyFileSync(join(DIST, 'icon.png'), join(SITE, 'icon.png'));

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const megabytes = (path) => `${(statSync(path).size / (1024 * 1024)).toFixed(1)} MB`;

// The relay binaries.
const rows = [];
for (const [name, system, chip] of RELAYS) {
  const from = join(BIN, name);
  if (!existsSync(from)) {
    console.warn(`! ${name} is absent. Run make relay-all.`);
    continue;
  }
  copyFileSync(from, join(SITE, name));
  rows.push(
    `<tr><td>${escape(system)}</td><td>${escape(chip)}</td>` +
      `<td><a href="${escape(name)}" download>${escape(name)}</a></td>` +
      `<td>${megabytes(from)}</td></tr>`,
  );
}

// The signed web bundle.
const bundlePath = join(DIST, 'app.swbn');
const signed = existsSync(bundlePath);
let bundleId = null;
if (signed) {
  copyFileSync(bundlePath, join(SITE, 'app.swbn'));
  copyFileSync(join(DIST, 'update.json'), join(SITE, 'update.json'));
  bundleId = getBundleId(readFileSync(bundlePath));
}

const bundleSection = signed
  ? `<p><a class="button ghost" href="app.swbn" download>Download app.swbn (${megabytes(bundlePath)})</a></p>
    <p class="id">Web Bundle ID<br /><code>${escape(bundleId)}</code></p>
    <ol>
      <li>Open <code>chrome://flags/#enable-isolated-web-apps</code> and turn it on.</li>
      <li>Open <code>chrome://flags/#enable-isolated-web-app-dev-mode</code> and turn it on.</li>
      <li>Restart Chrome.</li>
      <li>Open <code>chrome://web-app-internals</code>.</li>
      <li>Find "Install IWA from Signed Web Bundle" and choose the file.</li>
    </ol>
    <p>
      Chrome reads the flags only at start. If the flags are absent from your
      Chrome, use the relay instead.
    </p>`
  : `<p class="warn">No signed bundle is available. The build had no signing key.</p>`;

writeFileSync(
  join(SITE, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(manifest.name)} ${escape(manifest.version)}</title>
    <link rel="icon" href="icon.png" />
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0 auto; padding: 32px 20px; max-width: 48rem;
        background: #0b0d12; color: #d7dae0;
        font: 16px/1.6 system-ui, sans-serif;
      }
      h1 { display: flex; align-items: center; gap: 12px; font-size: 26px; }
      h1 img { width: 44px; height: 44px; border-radius: 9px; }
      h2 { margin-top: 36px; font-size: 19px; color: #4f9cf9; }
      code, pre {
        background: #161922; border: 1px solid #262b38; border-radius: 6px;
        font-family: ui-monospace, monospace; font-size: 13px;
      }
      code { padding: 2px 5px; word-break: break-all; }
      pre { padding: 12px; overflow-x: auto; }
      pre code { border: 0; padding: 0; background: none; }
      a { color: #4f9cf9; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #262b38; }
      th { color: #8b93a5; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
      .button {
        display: inline-block; padding: 10px 18px; border-radius: 6px;
        background: #4f9cf9; color: #06101f; font-weight: 600; text-decoration: none;
      }
      .button.ghost { background: transparent; border: 1px solid #262b38; color: #d7dae0; font-weight: 400; }
      .id { color: #8b93a5; font-size: 14px; }
      .warn { color: #f97066; }
      .note { padding: 12px 14px; background: #131a26; border-left: 3px solid #4f9cf9; border-radius: 4px; }
      ol, ul { padding-left: 20px; }
      li { margin: 6px 0; }
    </style>
  </head>
  <body>
    <h1><img src="icon.png" alt="" />${escape(manifest.name)}</h1>
    <p>${escape(manifest.description)}</p>
    <p class="id">Version ${escape(manifest.version)}</p>

    <div class="note">
      This page cannot run the terminal. A web page cannot open a TCP socket,
      so the application needs one of the two methods below.
    </div>

    <h2>Method 1: the relay (recommended)</h2>
    <p>
      One file holds the relay and the web application. The relay serves the
      page and carries its bytes to port 22. The private key stays in the
      browser, because the SSH encryption happens there. The relay never sees
      plaintext.
    </p>
    <table>
      <tr><th>System</th><th>Chip</th><th>File</th><th>Size</th></tr>
      ${rows.join('\n      ')}
    </table>
    <p>On Linux or macOS:</p>
<pre><code>chmod +x browser-ssh-linux-amd64
./browser-ssh-linux-amd64</code></pre>
    <p>Then open <code>http://localhost:9432</code>.</p>
    <p>
      The relay connects only to loopback and private addresses. To permit a
      public address, add <code>-allow-any-host</code>.
    </p>

    <h2>Method 2: the Isolated Web App</h2>
    <p>
      Chrome gives raw TCP to an installed Isolated Web App through the Direct
      Sockets API. This method needs no relay, but it needs a Chrome that
      supports Isolated Web Apps.
    </p>
    ${bundleSection}

    <h2>Updates</h2>
    <p>
      Chrome reads <a href="update.json">update.json</a> to find a new version
      of the bundle. The manifest points to it with
      <code>update_manifest_url</code>.
    </p>

    <h2>Source</h2>
    <p><a href="https://github.com/o16s/browser-ssh">github.com/o16s/browser-ssh</a></p>
  </body>
</html>
`,
);

console.log(`Wrote site/index.html for version ${manifest.version}`);
console.log(`Relay binaries on the site: ${rows.length}`);
if (bundleId) {
  console.log(`Web Bundle ID: ${bundleId}`);
}
