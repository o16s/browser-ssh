# LAN SSH

An SSH terminal that runs in Chrome. It connects to a host on the local network
on port 22 and logs in with a private key.

The SSH protocol runs in WebAssembly, from the Go package
`golang.org/x/crypto/ssh`. The terminal is xterm.js. The TCP socket comes from
the Direct Sockets API of Chrome.

## Why the application must be an Isolated Web App

An ordinary web page cannot open a TCP socket. Chrome gives raw TCP to web code
through the Direct Sockets API, and only inside an Isolated Web App. No other
browser path reaches port 22.

An Isolated Web App is a web application in a signed web bundle. Chrome gives it
a fixed origin of the form `isolated-app://<id>/`. The identifier comes from the
key that signed the bundle.

Chrome also gives every Isolated Web App this policy:

```
script-src 'self' 'wasm-unsafe-eval'; require-trusted-types-for 'script';
style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: blob: data:;
```

For an Isolated Web App, `'self'` means a file inside the bundle. It does not
include an inline script. The application is thus a set of files, and not one
HTML file. Read "Differences from the specification" for more information.

## What you need

| Tool | Version used here |
| --- | --- |
| Go | 1.26.1 |
| Node | 23.6.0 (wbn-sign needs 22.13 or later) |
| Docker | 29.4.1, for `make test` only |
| OpenSSL | any version, for the signing key |
| Chrome | 120 or later |

## Quick start

1. Generate the signing key:
   ```
   make key
   ```
2. Build the application and sign it:
   ```
   make bundle
   ```
3. Write down the Web Bundle ID that the command prints.
4. Install the bundle in Chrome. Read "Install the application".

## Make targets

| Target | Result |
| --- | --- |
| `make build` | Builds `dist/`, the installable application. |
| `make bundle` | Signs `dist/` into `dist/app.swbn` and writes `dist/update.json`. |
| `make dev` | Serves `dist/` on `0.0.0.0:9432` for the proxy-mode install. |
| `make test` | Runs the SSH core against a local sshd in Docker. |
| `make pages` | Builds `site/` for GitHub Pages. |
| `make key` | Generates `private.pem` with an Ed25519 key. |
| `make check` | Checks the format of the Go code and the types of the TypeScript code. |
| `make clean` | Removes the build products. |

## Install the application

Chrome reads the two flags only at start. Close every Chrome window before you
start Chrome again with a flag.

### First, turn on the flags

1. Open `chrome://flags/#enable-isolated-web-apps` and turn it on.
2. Open `chrome://flags/#enable-isolated-web-app-dev-mode` and turn it on.
3. Restart Chrome.

### Method 1: install the signed bundle

1. Run `make bundle`.
2. Open `chrome://web-app-internals`.
3. Find "Install IWA from Signed Web Bundle".
4. Choose the file `dist/app.swbn`.

The command line does the same thing:

```
google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
    --install-isolated-web-app-from-file=$PWD/dist/app.swbn
```

### Method 2: install from the development server

This method is for development. Chrome reads the files from the server at each
start, so a rebuild needs no new install.

1. Run `make dev`. The server listens on `0.0.0.0:9432`.
2. Close every Chrome window.
3. Start Chrome with this command:
   ```
   google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
       --install-isolated-web-app-from-url=http://localhost:9432
   ```

### Method 3: install from GitHub Pages

The page <https://o16s.github.io/browser-ssh/> holds the signed bundle and the
install steps. GitHub Pages cannot run the application. An Isolated Web App reads
its manifest from the absolute path `/.well-known/manifest.webmanifest`. A GitHub
Pages project site answers under `/browser-ssh/`, so that path is wrong there.

1. Open the page.
2. Download `app.swbn`.
3. Install it with Method 1, step 2 and later.

## Use the terminal

1. Start the installed application.
2. Type the host, for example `192.168.122.254`.
3. Type the port, for example `22`.
4. Type the user name, for example `root`.
5. Paste an OpenSSH or PEM private key into the key field.
6. If the key is encrypted, type the passphrase.
7. Click **Connect**.
8. Compare the fingerprint in the dialog with the fingerprint of the host.
9. Click **Accept**.

The shell opens in the terminal. A change of the window size reaches the remote
host. Ctrl-C reaches the remote shell.

To get the fingerprint of a host, run this command on that host:

```
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

## Security

- The private key stays in memory for the session. The application never writes
  it to storage.
- Accepted fingerprints stay in memory. The next start asks again.
- RSA, Ed25519 and ECDSA keys are supported, in OpenSSH format and in PEM
  format.
- The application does no cryptography of its own. The Go package
  `golang.org/x/crypto/ssh` does all of it.

## Microsoft Edge

**This is not tested.** No Edge, Chrome or Chromium is installed on the machine
that built this application. Microsoft publishes no statement about support for
Isolated Web Apps.

To find out, do these steps and record the result here:

1. Open `edge://flags/#enable-isolated-web-apps`.
2. Open `edge://flags/#enable-isolated-web-app-dev-mode`.
3. If both flags are present, turn them on and restart Edge.
4. Open `edge://web-app-internals` and look for "Install IWA from Signed Web
   Bundle".

## How it works

JavaScript owns the socket. Go owns the SSH protocol. Go never opens a network
connection.

```
xterm.js  <->  React  <->  ssh.ts  <->  TCPSocket        (JavaScript)
                             |
                             v
                        seven globals                    (the border)
                             |
                        jsConn (net.Conn)                (Go, WebAssembly)
                             |
                     golang.org/x/crypto/ssh
```

The Go module installs seven functions on the JavaScript global object:

| Function | Direction | Purpose |
| --- | --- | --- |
| `sshConnect(config)` | JS to Go | Starts the session. Returns at once. |
| `sshWrite(bytes)` | JS to Go | Keyboard input for the remote shell. |
| `sshResize(cols, rows)` | JS to Go | The terminal window changed size. |
| `sshClose()` | JS to Go | Ends the session. |
| `sshSocketData(bytes)` | JS to Go | Bytes that arrived on the socket. |
| `sshSocketClosed(reason)` | JS to Go | The socket ended. |
| `sshHostKeyResponse(accept)` | JS to Go | The answer to the fingerprint question. |

The `config` object carries the callbacks `onSocketWrite`, `onSocketClose`,
`onData`, `onHostKey`, `onReady`, `onError` and `onClose`.

A JavaScript callback must never block the event loop. Two parts of the Go code
follow from that rule:

- `jsConn` keeps incoming bytes in a queue that a mutex protects, and wakes a
  blocked read with a channel of capacity 1. A send on that channel never waits.
- `writePump` puts keyboard input in a queue. One goroutine does the write,
  because a write to the SSH channel can wait for the flow control window of the
  remote host.

### Repository layout

```
go/sshcore/     The SSH client. Pure Go, no syscall/js. Takes a net.Conn.
go/wasm/        The syscall/js bridge and the net.Conn over JavaScript.
web/            React, Vite and xterm.js.
web/manifest/   The Isolated Web App manifest.
scripts/        Bundle signing, the development server, the icon, the tests.
```

`go/sshcore` imports no browser package. That is what makes the test possible:
the same code runs in Chrome and on Linux.

## Tests

```
make test
```

The command starts an Alpine sshd in Docker with a throwaway key pair, then runs
two test programs against it:

- `go/sshcore/client_test.go` runs the SSH core on Linux. It covers `echo ok`, a
  window resize that the remote `stty` reports, Ctrl-C, and key parsing for RSA,
  Ed25519 and ECDSA.
- `scripts/test/wasm-bridge.cjs` runs the compiled WebAssembly module in Node
  against the same sshd. It covers the JavaScript bridge, the `net.Conn`
  adapter, the write pump and the host key question.

The sshd listens on `127.0.0.1:2222`. To use another address, set `TEST_HOST`
and `TEST_PORT`.

## GitHub Pages

`.github/workflows/pages.yml` builds and publishes on each push to `main`.

The signing key decides the identity of the application. A new key gives a new
Web Bundle ID, and Chrome then treats the result as a different application. So
the key must stay the same.

1. Run `make key` one time. The file `private.pem` is in `.gitignore`.
2. Give the key to the workflow:
   ```
   gh secret set IWA_SIGNING_KEY < private.pem
   ```
3. Open the repository settings, then Pages, then set the source to "GitHub
   Actions".

If the secret is absent, the workflow builds an unsigned bundle and prints a
warning. Chrome cannot install an unsigned bundle.

## Differences from the specification

Each difference below has a reason. No difference was made for convenience.

| Specification | What was built | Reason |
| --- | --- | --- |
| One self-contained `dist/index.html` with all JavaScript inlined. | `dist/index.html` plus `dist/assets/app.js`. | The policy of Chrome for an Isolated Web App is `script-src 'self' 'wasm-unsafe-eval'`. For an Isolated Web App, `'self'` excludes an inline script. A one-file page is blocked before it can call `TCPSocket`. |
| `vite-plugin-singlefile`. | Not used. | The same reason. |
| The wasm binary inlined as base64. | `dist/ssh.wasm`, a file of its own. | The same reason, and base64 adds a third to a 6.8 MB binary. |
| `direct-sockets` and `direct-sockets-private` in the manifest. | Two more keys: `local-network` and `loopback-network`. | The telnet Isolated Web App of Google carries all four. The last two are the Local Network Access keys. |
| The manifest of the specification. | Two more fields: `version` and `update_manifest_url`. | Chrome refuses an Isolated Web App manifest without a `version` field. |
| `sshConnect(config, onData, onClose)`. | `sshConnect(config)`, and three more functions for the socket. | JavaScript owns the socket, so Go needs a way to get socket bytes and to send socket bytes. |
| `wbn-sign` with `IntegrityBlockSigner`. | `wbn-sign` 0.3.1 with `SignedWebBundle`. | `IntegrityBlockSigner` is deprecated and will be removed. |
| A test sshd on a test IP. | A test sshd on `127.0.0.1:2222`. | A published Docker port needs no change to the network. `TEST_HOST` and `TEST_PORT` give another address. |
| The development server on port 8080. | `0.0.0.0:9432`. | The user asked for this. |
| Nothing about publication. | GitHub Pages holds the bundle and the update manifest. | The user asked for this. |

## What is verified and what is not

These were run on the machine that built the application, and they pass:

| Command | Result |
| --- | --- |
| `make test` | The SSH core opens a shell on a real sshd. `echo ok` returns `ok`. Ctrl-C and resize work. |
| `make test` | The compiled WebAssembly module does the same thing through the JavaScript bridge. |
| `make build` | The module compiles. `dist/index.html` holds no inline script. |
| `make bundle` | `dist/app.swbn` is signed. `npx wbn-sign info` reads the signature back. |
| `make dev` | The server answers on `0.0.0.0:9432` with the correct content types. A request with `..` in the path gets 404. |
| `make pages` | `site/` holds `index.html`, `app.swbn` and `update.json`. |
| `make check` | `gofmt`, `go vet` and `tsc` report nothing. |

These are **not** verified, because no Chrome, Chromium or Edge is installed on
the machine that built the application:

- The install with either method.
- The React user interface in a browser.
- A live shell to a host on the local network.
- The Microsoft Edge result.

## Troubleshooting

**The application says "TCPSocket is not available".**
The page is not running as an installed Isolated Web App. Install it with one of
the three methods.

**A connection fails with `NotAllowedError`.**
The manifest lost its `permissions_policy` keys. Make sure that
`dist/.well-known/manifest.webmanifest` holds `direct-sockets`,
`direct-sockets-private`, `local-network`, `loopback-network` and
`cross-origin-isolated`.

**The flags have no effect.**
Chrome reads the flags only at start. Close every Chrome window. Then start
Chrome again with the flags.

**The application says "The private key is encrypted".**
Type the passphrase in the passphrase field, then connect again.

**The connection waits and then fails.**
The host is off, or a firewall blocks port 22. Test the path from another
machine with `ssh -v`.

**`make bundle` prints "private.pem is absent".**
Run `make key` one time, then run `make bundle` again.

## Sources

- [Direct Sockets in an Isolated Web App](https://developer.chrome.com/docs/iwa/direct-sockets)
- [Isolated Web Apps](https://developer.chrome.com/docs/iwa/introduction)
- [Developer policy and security guidelines](https://developer.chrome.com/docs/iwa/developer-policy)
- [The telnet Isolated Web App of Google](https://github.com/GoogleChromeLabs/telnet-client)
- [wbn-sign](https://github.com/WICG/webpackage/tree/main/js/sign)
- [Deploy an Isolated Web App](https://chromeos.dev/en/tutorials/getting-started-with-isolated-web-apps/3)
