// Builds the GitHub Pages site.
//
// GitHub Pages cannot run the application. An Isolated Web App reads its
// manifest from the absolute path /.well-known/manifest.webmanifest, and a
// GitHub Pages project site answers under /browser-ssh/. So the site holds the
// signed bundle, the update manifest and the install steps.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBundleId } from 'wbn-sign';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SITE = join(ROOT, 'site');

const manifest = JSON.parse(
  readFileSync(join(DIST, '.well-known', 'manifest.webmanifest'), 'utf8'),
);
const bundlePath = join(DIST, 'app.swbn');
const signed = existsSync(bundlePath);

mkdirSync(SITE, { recursive: true });

let bundleId = null;
if (signed) {
  copyFileSync(bundlePath, join(SITE, 'app.swbn'));
  copyFileSync(join(DIST, 'update.json'), join(SITE, 'update.json'));
  bundleId = getBundleId(readFileSync(bundlePath));
} else {
  console.warn('! dist/app.swbn is absent. The site will hold no bundle.');
}
copyFileSync(join(DIST, 'icon.png'), join(SITE, 'icon.png'));

const size = signed
  ? `${(readFileSync(bundlePath).length / (1024 * 1024)).toFixed(1)} MB`
  : '';

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const download = signed
  ? `<p><a class="button" href="app.swbn" download>Download app.swbn (${size})</a></p>
     <p class="id">Web Bundle ID<br /><code>${escape(bundleId)}</code></p>
     <p class="id">Isolated Web App origin<br /><code>isolated-app://${escape(bundleId)}/</code></p>`
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
        margin: 0 auto; padding: 32px 20px; max-width: 46rem;
        background: #0b0d12; color: #d7dae0;
        font: 16px/1.6 system-ui, sans-serif;
      }
      h1 { display: flex; align-items: center; gap: 12px; font-size: 26px; }
      h1 img { width: 44px; height: 44px; border-radius: 9px; }
      h2 { margin-top: 32px; font-size: 18px; color: #4f9cf9; }
      code, pre {
        background: #161922; border: 1px solid #262b38; border-radius: 6px;
        font-family: ui-monospace, monospace; font-size: 13px;
      }
      code { padding: 2px 5px; word-break: break-all; }
      pre { padding: 12px; overflow-x: auto; }
      pre code { border: 0; padding: 0; background: none; }
      a { color: #4f9cf9; }
      .button {
        display: inline-block; padding: 10px 18px; border-radius: 6px;
        background: #4f9cf9; color: #06101f; font-weight: 600;
        text-decoration: none;
      }
      .id { color: #8b93a5; font-size: 14px; }
      .warn { color: #f97066; }
      ol { padding-left: 20px; }
      li { margin: 6px 0; }
    </style>
  </head>
  <body>
    <h1><img src="icon.png" alt="" />${escape(manifest.name)}</h1>
    <p>${escape(manifest.description)}</p>
    <p class="id">Version ${escape(manifest.version)}</p>

    <h2>Before you install</h2>
    <p>
      This page cannot run the application. Chrome gives raw TCP only to an
      installed Isolated Web App, so the bundle below must be installed.
    </p>

    <h2>Install the application</h2>
    ${download}
    <ol>
      <li>Open <code>chrome://flags/#enable-isolated-web-apps</code> and turn it on.</li>
      <li>Open <code>chrome://flags/#enable-isolated-web-app-dev-mode</code> and turn it on.</li>
      <li>Restart Chrome.</li>
      <li>Open <code>chrome://web-app-internals</code>.</li>
      <li>Find "Install IWA from Signed Web Bundle" and choose the file that you downloaded.</li>
    </ol>
    <p>The command line does the same thing:</p>
<pre><code>google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \\
    --install-isolated-web-app-from-file=$PWD/app.swbn</code></pre>
    <p>The flags work only on a Chrome that starts with them.</p>

    <h2>Updates</h2>
    <p>
      Chrome reads <a href="update.json">update.json</a> to find new versions.
      The manifest points to it with <code>update_manifest_url</code>.
    </p>

    <h2>Source</h2>
    <p><a href="https://github.com/o16s/browser-ssh">github.com/o16s/browser-ssh</a></p>
  </body>
</html>
`,
);

console.log(`Wrote site/index.html for version ${manifest.version}`);
if (bundleId) {
  console.log(`Wrote site/app.swbn and site/update.json`);
  console.log(`Web Bundle ID: ${bundleId}`);
}
