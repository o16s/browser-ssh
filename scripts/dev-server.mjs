// Serves dist/ for the proxy-mode install of Chrome.
//
// Chrome installs an Isolated Web App from a running server when it gets
// --install-isolated-web-app-from-url. The server must answer on every path of
// the application, and it must give the manifest the right content type.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const HOST = process.env.DEV_HOST ?? '0.0.0.0';
const PORT = Number(process.env.DEV_PORT ?? 9432);

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

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html is missing. Run make build first.');
  process.exit(1);
}

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);

  // normalize removes "..", so a request cannot leave dist/.
  let file = join(DIST, normalize(path));
  if (!file.startsWith(DIST)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, 'index.html');
  }
  if (!existsSync(file)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    console.log(`404 ${path}`);
    return;
  }

  const dot = file.lastIndexOf('.');
  response.writeHead(200, {
    'Content-Type': MIME[file.slice(dot)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
  console.log(`200 ${path}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${DIST}`);
  console.log(`  http://localhost:${PORT}`);
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  http://${address.address}:${PORT}   (${name})`);
      }
    }
  }
  console.log('');
  console.log('To install the application in proxy mode, close every Chrome window,');
  console.log('then start Chrome with this command:');
  console.log('');
  console.log('  google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \\');
  console.log(`      --install-isolated-web-app-from-url=http://localhost:${PORT}`);
  console.log('');
  console.log('The flags work only on a Chrome that starts with them.');
  console.log('Press Ctrl-C to stop the server.');
});
