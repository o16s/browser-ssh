// Runs the compiled WebAssembly SSH core in Node and drives it against a real
// sshd. This is the browser path without a browser.
//
// The browser gives the core a TCPSocket. Node gives it a net.Socket. The core
// sees the same seven functions in both places, so this test covers the
// JavaScript bridge, the net.Conn adapter and the write pump.
//
// Usage: node wasm-bridge.cjs <ssh.wasm> <host> <port> <user> <keyfile>

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const [wasmPath, host, port, user, keyFile] = process.argv.slice(2);
if (!wasmPath || !host || !port || !user || !keyFile) {
  console.error('Usage: node wasm-bridge.cjs <ssh.wasm> <host> <port> <user> <keyfile>');
  process.exit(1);
}

// The shims that the Go runtime glue needs outside a browser. They are the
// same ones that wasm_exec_node.js of the Go installation sets.
globalThis.require = require;
globalThis.fs = fs;
globalThis.path = path;
globalThis.TextEncoder = require('util').TextEncoder;
globalThis.TextDecoder = require('util').TextDecoder;
globalThis.performance ??= require('perf_hooks').performance;
globalThis.crypto ??= require('crypto');

const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
require(path.join(goRoot, 'lib', 'wasm', 'wasm_exec.js'));

let output = '';
const failures = [];

function check(name, condition) {
  if (condition) {
    console.log(`    PASS  ${name}`);
  } else {
    console.log(`    FAIL  ${name}`);
    failures.push(name);
  }
}

/** Waits until the output holds want at least count times. */
function waitFor(want, count, seconds) {
  const deadline = Date.now() + seconds * 1000;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (output.split(want).length - 1 >= count) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`${want} did not appear ${count} times. Output:\n${output}`));
      }
    }, 50);
  });
}

async function main() {
  const ready = new Promise((resolve) => {
    globalThis.__sshCoreReady = resolve;
  });

  const go = new Go();
  go.env = { ...process.env };
  const wasm = await WebAssembly.instantiate(fs.readFileSync(wasmPath), go.importObject);
  void go.run(wasm.instance);
  await ready;
  check('the WebAssembly module installs its functions', typeof globalThis.sshConnect === 'function');

  const socket = net.createConnection({ host, port: Number(port) });
  socket.on('data', (chunk) => globalThis.sshSocketData(new Uint8Array(chunk)));
  socket.on('close', () => globalThis.sshSocketClosed('the socket closed'));
  socket.on('error', (error) => globalThis.sshSocketClosed(String(error)));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const decoder = new TextDecoder();
  let fingerprint = '';
  let keyType = '';

  const shellReady = new Promise((resolve, reject) => {
    globalThis.sshConnect({
      host,
      port: Number(port),
      user,
      privateKey: fs.readFileSync(keyFile, 'utf8'),
      passphrase: '',
      cols: 80,
      rows: 24,
      onSocketWrite: (bytes) => socket.write(Buffer.from(bytes)),
      onSocketClose: () => socket.end(),
      onData: (bytes) => {
        output += decoder.decode(bytes);
      },
      onHostKey: (fp, kt) => {
        fingerprint = fp;
        keyType = kt;
        globalThis.sshHostKeyResponse(true);
      },
      onReady: resolve,
      onError: (message) => reject(new Error(message)),
      onClose: () => {},
    });
  });

  await Promise.race([
    shellReady,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the shell was not ready in 30 seconds')), 30_000),
    ),
  ]);
  check('the shell starts', true);
  check('the host key fingerprint is a SHA256 value', fingerprint.startsWith('SHA256:'));
  check('the host key type is reported', keyType.length > 0);

  const encoder = new TextEncoder();
  const send = (text) => globalThis.sshWrite(encoder.encode(text));

  send('echo ok\n');
  await waitFor('ok', 2, 15);
  check('echo ok returns ok', true);

  send('echo $((6*7))\n');
  await waitFor('42', 1, 15);
  check('the remote shell runs commands', true);

  globalThis.sshResize(120, 40);
  send('stty size\n');
  await waitFor('40 120', 1, 15);
  check('a resize reaches the remote terminal', true);

  send('sleep 300\n');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  globalThis.sshWrite(new Uint8Array([0x03])); // Ctrl-C
  await new Promise((resolve) => setTimeout(resolve, 500));
  send('echo BACK\n');
  await waitFor('BACK', 2, 15);
  check('Ctrl-C reaches the remote shell', true);

  globalThis.sshClose();
  socket.destroy();
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed.`);
      process.exit(1);
    }
    console.log('\nThe WebAssembly bridge works.');
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${error.message}`);
    process.exit(1);
  });
