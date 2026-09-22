// The bridge between the page and the Go SSH core.
//
// The split of work is fixed: JavaScript owns the transport, Go owns the SSH
// protocol. Go never opens a network connection, and JavaScript never looks at
// SSH bytes.
//
// There are two transports, because a web page cannot open a TCP socket:
//
//  1. TCPSocket, the Direct Sockets API. It exists only in an installed
//     Isolated Web App. It reaches port 22 with nothing in between.
//  2. A WebSocket to the relay that served this page. The relay is a byte
//     pipe. It carries encrypted SSH bytes, so it never sees the private key
//     or any plaintext.
//
// The page and the relay share one origin, so Chrome finds no mixed content
// and asks for no Local Network Access permission.

const core = globalThis as unknown as SSHCore;

export type TransportKind = 'direct-sockets' | 'relay';

/** The transport that this page will use. */
export function transportKind(): TransportKind {
  return typeof TCPSocket === 'function' ? 'direct-sockets' : 'relay';
}

/** A byte stream to the remote host, in one direction each way. */
interface Transport {
  send(bytes: Uint8Array): void;
  close(): void;
}

let corePromise: Promise<void> | null = null;

/**
 * Loads the WebAssembly module one time.
 *
 * The Go program never returns, so the promise of go.run() is not awaited. The
 * module reports that its functions are ready through __sshCoreReady.
 */
export function loadCore(): Promise<void> {
  if (corePromise) {
    return corePromise;
  }
  corePromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the SSH core did not start in 30 seconds')),
      30_000,
    );
    core.__sshCoreReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const go = new Go();
    WebAssembly.instantiateStreaming(fetch('ssh.wasm'), go.importObject)
      .then((result) => {
        // This promise settles only when the Go program exits, and it never
        // exits. An await here would wait for ever.
        void go.run(result.instance);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
  return corePromise;
}

/** Opens a TCP socket with the Direct Sockets API of Chrome. */
async function openDirectSocket(
  host: string,
  port: number,
  onData: (bytes: Uint8Array) => void,
  onClose: (reason: string) => void,
): Promise<Transport> {
  const socket = new TCPSocket(host, port);
  const { readable, writable } = await socket.opened;
  const writer = writable.getWriter();

  // Every write returns a promise. The writes are chained so that the bytes
  // reach the remote host in the order that Go produced them.
  let chain: Promise<void> = Promise.resolve();
  let open = true;

  void (async () => {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) {
          onData(value);
        }
        if (done) {
          break;
        }
      }
      onClose('');
    } catch (error: unknown) {
      onClose(String(error));
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    send: (bytes) => {
      if (!open) {
        return;
      }
      chain = chain.then(
        () => writer.write(bytes),
        () => undefined,
      );
    },
    close: () => {
      if (!open) {
        return;
      }
      open = false;
      chain = chain.then(
        () => {
          writer.releaseLock();
          return socket.close().catch(() => undefined);
        },
        () => undefined,
      );
    },
  };
}

/** Opens a WebSocket to the relay that served this page. */
function openRelaySocket(
  host: string,
  port: number,
  onData: (bytes: Uint8Array) => void,
  onClose: (reason: string) => void,
): Promise<Transport> {
  const base = new URL('tcp', window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.searchParams.set('host', host);
  base.searchParams.set('port', String(port));

  const socket = new WebSocket(base);
  socket.binaryType = 'arraybuffer';

  return new Promise<Transport>((resolve, reject) => {
    let open = false;

    socket.onopen = () => {
      open = true;
      resolve({
        // A WebSocket keeps the order of the messages, so no queue is needed.
        send: (bytes) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(bytes);
          }
        },
        close: () => socket.close(),
      });
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onData(new Uint8Array(event.data));
    };
    socket.onclose = (event: CloseEvent) => {
      if (!open) {
        // The relay refuses a target that is not on a local network, and it
        // refuses a page that it did not serve. Both end here.
        reject(
          new Error(
            event.reason === ''
              ? `the relay did not accept the connection to ${host}:${port}`
              : event.reason,
          ),
        );
        return;
      }
      onClose(event.wasClean ? '' : event.reason);
    };
    socket.onerror = () => {
      if (!open) {
        reject(
          new Error(
            'the relay did not answer. Start it with "make serve", then open the page that it serves.',
          ),
        );
      }
    };
  });
}

export interface ConnectParams {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  passphrase: string;
  cols: number;
  rows: number;
  /** Output of the remote shell. */
  onData(bytes: Uint8Array): void;
  /** The fingerprint of the host. Answer it with acceptHostKey. */
  onHostKey(fingerprint: string, keyType: string): void;
  /** The shell is ready. */
  onReady(): void;
  /** The connection failed. code is a short word, or an empty string. */
  onError(message: string, code: string): void;
  /** The session ended. message is empty after a clean end. */
  onClose(message: string): void;
}

export interface Connection {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

const encoder = new TextEncoder();

/**
 * Opens a transport to the host, then starts an SSH session on it.
 *
 * The returned promise settles when the transport is open. The shell is ready
 * later, through the onReady callback.
 */
export async function connect(params: ConnectParams): Promise<Connection> {
  await loadCore();

  const toGo = (bytes: Uint8Array) => core.sshSocketData(bytes);
  const endedInGo = (reason: string) => core.sshSocketClosed(reason);

  const transport =
    transportKind() === 'direct-sockets'
      ? await openDirectSocket(params.host, params.port, toGo, endedInGo)
      : await openRelaySocket(params.host, params.port, toGo, endedInGo);

  core.sshConnect({
    host: params.host,
    port: params.port,
    user: params.user,
    privateKey: params.privateKey,
    passphrase: params.passphrase,
    cols: params.cols,
    rows: params.rows,
    onSocketWrite: (bytes: Uint8Array) => transport.send(bytes),
    onSocketClose: () => transport.close(),
    onData: params.onData,
    onHostKey: params.onHostKey,
    onReady: params.onReady,
    onError: (message: string, code: string) => {
      transport.close();
      params.onError(message, code);
    },
    onClose: (message: string) => {
      transport.close();
      params.onClose(message);
    },
  });

  return {
    write: (data: string) => core.sshWrite(encoder.encode(data)),
    resize: (cols: number, rows: number) => core.sshResize(cols, rows),
    close: () => core.sshClose(),
  };
}

/** Answers the host key question of the SSH core. */
export function acceptHostKey(accept: boolean): void {
  core.sshHostKeyResponse(accept);
}
