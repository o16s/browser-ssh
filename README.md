# LAN SSH

An SSH terminal in a browser tab. It connects to a host on the local network on
port 22 and logs in with a private key.

The SSH protocol runs in WebAssembly, from the Go package
`golang.org/x/crypto/ssh`. The terminal is xterm.js. The private key stays in
the browser tab.

## Quick start

```
make serve
```

Then open <http://localhost:9432>. Type the host, the port, the user name and
the private key, then click **Connect**.

That is everything. No Chrome flag, no install, no signed bundle.

## Why a relay is necessary

A web page cannot open a TCP socket. No browser gives one to an ordinary page.
Two ways reach port 22, and this repository builds both.

**Method 1, the relay.** `make serve` builds one binary. That binary serves the
web page and carries the bytes of the page to port 22 over a WebSocket. The
binary runs on your machine, and never in the browser.

The relay is a byte pipe. The SSH encryption happens in the WebAssembly module
in the tab, so the relay carries encrypted bytes only. It never reads the
private key and it never sees plaintext.

The page and the relay share one origin. Chrome thus finds no mixed content,
and it asks for no Local Network Access permission. Chrome 147 and later ask
for that permission when a public page opens a WebSocket to a private address.

**Method 2, the Isolated Web App.** Chrome gives raw TCP to an installed
Isolated Web App through the Direct Sockets API. This method needs no relay. It
needs a Chrome that supports Isolated Web Apps, and two flags. Read "Method 2"
below.

The web application finds out which transport it can use, and the status line
at the bottom of the window names it.

## What you need

| Tool | Version used here | Necessary for |
| --- | --- | --- |
| Go | 1.26.1 | The build |
| Node | 23.6.0 (wbn-sign needs 22.13 or later) | The build |
| Docker | 29.4.1 | `make test` only |
| Chromium from Playwright | 153 | The browser test only |
| OpenSSL | any version | The signing key only |

## Make targets

| Target | Result |
| --- | --- |
| `make serve` | Builds the relay and runs it. This is the usual way to use it. |
| `make relay` | Builds `bin/browser-ssh`, one file that holds the web application. |
| `make build` | Builds `dist/`, the web application on its own. |
| `make test` | Runs every test against a local sshd in Docker. |
| `make bundle` | Signs `dist/` into `dist/app.swbn` for the Isolated Web App. |
| `make pages` | Builds `site/` for GitHub Pages. |
| `make key` | Generates `private.pem` with an Ed25519 key. |
| `make check` | Checks the format of the Go code and the types of the TypeScript code. |
| `make clean` | Removes the build products. |

## Method 1: the relay

### Run it

```
make serve
```

The relay listens on `0.0.0.0:9432`. Another machine on the network can thus
open `http://<your-ip>:9432` and use the terminal.

To listen on the loopback address only, run this command:

```
./bin/browser-ssh -addr 127.0.0.1:9432
```

### Options

| Option | Result |
| --- | --- |
| `-addr` | The address to listen on. The default is `0.0.0.0:9432`. |
| `-dir` | Serve a directory instead of the built-in files. |
| `-allow-any-host` | Permit a public address as the target. |
| `-timeout` | The time limit for one connection attempt. The default is 15s. |

### What the relay refuses

- A target that is not a loopback address, a private address or a link-local
  address. `-allow-any-host` removes this rule.
- A WebSocket from a page that the relay did not serve. Without this rule, any
  web page that you open can reach every host on your network.

## Method 2: the Isolated Web App

Chrome reads the two flags only at start. Close every Chrome window before you
start Chrome again with a flag.

1. Open `chrome://flags/#enable-isolated-web-apps` and turn it on.
2. Open `chrome://flags/#enable-isolated-web-app-dev-mode` and turn it on.
3. Restart Chrome.
4. Run `make bundle`.
5. Open `chrome://web-app-internals`.
6. Find "Install IWA from Signed Web Bundle".
7. Choose the file `dist/app.swbn`.

The command line does the same thing:

```
google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
    --install-isolated-web-app-from-file=$PWD/dist/app.swbn
```

If the flags are absent from your Chrome, use Method 1.

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
HTML file. Read "Differences from the specification".

## Use the terminal

1. Open the page.
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

- The private key stays in memory in the browser tab. The application never
  writes it to storage, and it never sends it to the relay.
- The relay carries encrypted SSH bytes only. It reads no plaintext.
- Accepted fingerprints stay in memory. The next start asks again.
- RSA, Ed25519 and ECDSA keys are supported, in OpenSSH format and in PEM
  format.
- The application does no cryptography of its own. The Go package
  `golang.org/x/crypto/ssh` does all of it.

## How it works

JavaScript owns the transport. Go owns the SSH protocol. The Go code in the tab
never opens a network connection.

```
  browser tab                                 your machine        network
  ---------------------------------------     --------------      -------
  xterm.js -> React -> ssh.ts -> WebSocket ->  relay binary  -> TCP :22
                          |                    (byte pipe)
                          +-> TCPSocket ------------------------> TCP :22
                     (Isolated Web App only)
       |
  seven globals
       |
  jsConn (net.Conn) -> golang.org/x/crypto/ssh     (Go, WebAssembly)
```

The Go module in the tab installs seven functions on the JavaScript global
object:

| Function | Direction | Purpose |
| --- | --- | --- |
| `sshConnect(config)` | JS to Go | Starts the session. Returns at once. |
| `sshWrite(bytes)` | JS to Go | Keyboard input for the remote shell. |
| `sshResize(cols, rows)` | JS to Go | The terminal window changed size. |
| `sshClose()` | JS to Go | Ends the session. |
| `sshSocketData(bytes)` | JS to Go | Bytes that arrived on the transport. |
| `sshSocketClosed(reason)` | JS to Go | The transport ended. |
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

### Two Go builds

The repository builds Go twice, from one module:

| Build | Target | Where it runs | Job |
| --- | --- | --- | --- |
| `ssh.wasm` | `GOOS=js GOARCH=wasm` | In the browser tab | The SSH client |
| `bin/browser-ssh` | native | On your machine | The relay |

`go/sshcore` holds the SSH client and imports no browser package. Both builds
use it, and so does the test. That is what makes the test possible: the same
code runs in the tab, in the relay test and on Linux.

### Repository layout

```
go/sshcore/     The SSH client. Pure Go, no syscall/js. Takes a net.Conn.
go/wasm/        The syscall/js bridge and the net.Conn over JavaScript.
go/relay/       The relay: a file server and a WebSocket to TCP pipe.
web/            React, Vite and xterm.js.
web/manifest/   The Isolated Web App manifest.
scripts/        Bundle signing, the icon, the Pages site, the tests.
```

## Tests

```
make relay && make test
```

The command starts an Alpine sshd in Docker with a throwaway key pair, then runs
three test programs against it:

- `go/sshcore/client_test.go` runs the SSH core on Linux. It covers `echo ok`, a
  window resize that the remote `stty` reports, Ctrl-C, and key parsing for RSA,
  Ed25519 and ECDSA.
- `scripts/test/wasm-bridge.cjs` runs the compiled WebAssembly module in Node.
  It covers the JavaScript bridge, the `net.Conn` adapter, the write pump and
  the host key question.
- `scripts/test/browser.mjs` drives the real web application in a real browser,
  through the relay. It fills the form, accepts the fingerprint, gets a shell,
  runs commands, resizes the window and sends Ctrl-C. It also fails on any
  console error, which catches a policy or a Trusted Types fault.

The sshd listens on `127.0.0.1:2222`. To use another address, set `TEST_HOST`
and `TEST_PORT`. To leave out the browser test, set `SKIP_BROWSER=1`.

The browser test needs a Chromium from Playwright:

```
npx playwright install chromium
```

## GitHub Pages

<https://o16s.github.io/browser-ssh/> offers the relay binary for four systems
and the signed bundle. `.github/workflows/pages.yml` builds, tests and publishes
on each push to `main`.

GitHub Pages cannot run the application. A page there cannot open a TCP socket,
and it is not the relay.

The signing key decides the identity of the Isolated Web App. A new key gives a
new Web Bundle ID, and Chrome then treats the result as a different application.
So the key must stay the same.

1. Run `make key` one time. The file `private.pem` is in `.gitignore`.
2. Give the key to the workflow:
   ```
   gh secret set IWA_SIGNING_KEY < private.pem
   ```
3. Open the repository settings, then Pages, then set the source to "GitHub
   Actions".

## Differences from the specification

Each difference below has a reason. No difference was made for convenience.

| Specification | What was built | Reason |
| --- | --- | --- |
| Only the Isolated Web App. | The relay as well, and it is the default. | The Isolated Web App did not work on the machine of the user. A relay needs no flag and no install. |
| One self-contained `dist/index.html` with all JavaScript inlined. | `dist/index.html` plus `dist/assets/app.js`. | The policy of Chrome for an Isolated Web App is `script-src 'self' 'wasm-unsafe-eval'`. For an Isolated Web App, `'self'` excludes an inline script. A one-file page is blocked before it can call `TCPSocket`. |
| `vite-plugin-singlefile`. | Not used. | The same reason. |
| The wasm binary inlined as base64. | `dist/ssh.wasm`, a file of its own. | The same reason, and base64 adds a third to a 6.8 MB binary. |
| `direct-sockets` and `direct-sockets-private` in the manifest. | Two more keys: `local-network` and `loopback-network`. | The telnet Isolated Web App of Google carries all four. The last two are the Local Network Access keys. |
| The manifest of the specification. | Two more fields: `version` and `update_manifest_url`. | Chrome refuses an Isolated Web App manifest without a `version` field. |
| `sshConnect(config, onData, onClose)`. | `sshConnect(config)`, and three more functions for the transport. | JavaScript owns the transport, so Go needs a way to get bytes and to send bytes. |
| `wbn-sign` with `IntegrityBlockSigner`. | `wbn-sign` 0.3.1 with `SignedWebBundle`. | `IntegrityBlockSigner` is deprecated and will be removed. |
| A test sshd on a test IP. | A test sshd on `127.0.0.1:2222`. | A published Docker port needs no change to the network. `TEST_HOST` and `TEST_PORT` give another address. |
| The development server on port 8080. | `0.0.0.0:9432`. | The user asked for this. |
| Nothing about publication. | GitHub Pages holds the relay binaries and the bundle. | The user asked for this. |

## What is verified and what is not

These run on the machine that built the application, and they pass:

| Test | Result |
| --- | --- |
| Go core on Linux | A shell opens on a real sshd. `echo ok` returns `ok`. Ctrl-C and resize work. |
| WebAssembly module in Node | The same result through the JavaScript bridge. |
| **The web application in a browser, through the relay** | The page loads, xterm draws, the fingerprint dialog appears, the shell opens, `echo ok` returns `ok`, Ctrl-C works. No console error. |
| `make relay` | One 13 MB binary holds the web application. |
| `make bundle` | `dist/app.swbn` is signed. `npx wbn-sign info` reads the signature back. |
| `make pages` | `site/` holds four relay binaries, the bundle and the update manifest. |
| `make check` | `gofmt`, `go vet` and `tsc` report nothing. |

These are **not** verified:

- The Isolated Web App install. No Chrome, Chromium or Edge is installed on the
  machine that built the application. The browser test uses a Chromium from
  Playwright, which cannot install an Isolated Web App.
- A live shell to a host on the local network. The tests use a container.
- Microsoft Edge. Microsoft publishes no statement about support for Isolated
  Web Apps. The relay needs no such support, so Method 1 is expected to work in
  Edge and in Firefox.

## Troubleshooting

**The page says "the relay did not answer".**
The page is open, but no relay serves it. Run `make serve`, then open the
address that it prints.

**The relay answers 403 for the host.**
The target is not on a local network. Add `-allow-any-host`, or use a private
address.

**The status line says "Transport: relay" and you wanted the direct socket.**
The page is not running as an installed Isolated Web App. That is normal for
Method 1, and the terminal works the same way.

**A connection fails with `NotAllowedError`.**
This is Method 2 only. The manifest lost its `permissions_policy` keys. Make
sure that `dist/.well-known/manifest.webmanifest` holds `direct-sockets`,
`direct-sockets-private`, `local-network`, `loopback-network` and
`cross-origin-isolated`.

**The Chrome flags have no effect.**
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
- [Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [The telnet Isolated Web App of Google](https://github.com/GoogleChromeLabs/telnet-client)
- [wbn-sign](https://github.com/WICG/webpackage/tree/main/js/sign)
