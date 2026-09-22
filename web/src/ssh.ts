// The bridge between the page and the Go SSH core.
//
// The split of work is fixed: JavaScript owns the TCPSocket, Go owns the SSH
// protocol. Go never opens a socket, and JavaScript never looks at SSH bytes.

const core = globalThis as unknown as SSHCore;

/** True when the page runs where the Direct Sockets API exists. */
export function hasDirectSockets(): boolean {
  return typeof TCPSocket === 'function';
}

let corePromise: Promise<void> | null = null;

/**
 * Loads the WebAssembly module one time.
 *
 * The Go program never returns, so the promise of go.run() is not awaited.
 * The module reports that its functions are ready through __sshCoreReady.
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
    WebAssembly.instantiateStreaming(fetch('/ssh.wasm'), go.importObject)
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
 * Opens a TCP socket, then starts an SSH session on it.
 *
 * The returned promise settles when the socket is open. The shell is ready
 * later, through the onReady callback.
 */
export async function connect(params: ConnectParams): Promise<Connection> {
  if (!hasDirectSockets()) {
    throw new Error(
      'TCPSocket is not available. The page must run as an installed Isolated Web App.',
    );
  }
  await loadCore();

  const socket = new TCPSocket(params.host, params.port);
  const { readable, writable } = await socket.opened;

  const writer = writable.getWriter();
  // Every write returns a promise. The writes are chained so that the bytes
  // reach the remote host in the order that Go produced them.
  let writeChain: Promise<void> = Promise.resolve();
  let socketOpen = true;

  const closeSocket = () => {
    if (!socketOpen) {
      return;
    }
    socketOpen = false;
    writeChain = writeChain.then(
      () => {
        writer.releaseLock();
        return socket.close().catch(() => undefined);
      },
      () => undefined,
    );
  };

  // Read from the socket and give every block to Go.
  void (async () => {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) {
          core.sshSocketData(value);
        }
        if (done) {
          break;
        }
      }
      core.sshSocketClosed('');
    } catch (error: unknown) {
      core.sshSocketClosed(String(error));
    } finally {
      reader.releaseLock();
    }
  })();

  core.sshConnect({
    host: params.host,
    port: params.port,
    user: params.user,
    privateKey: params.privateKey,
    passphrase: params.passphrase,
    cols: params.cols,
    rows: params.rows,
    onSocketWrite: (bytes: Uint8Array) => {
      if (!socketOpen) {
        return;
      }
      writeChain = writeChain.then(
        () => writer.write(bytes),
        () => undefined,
      );
    },
    onSocketClose: closeSocket,
    onData: params.onData,
    onHostKey: params.onHostKey,
    onReady: params.onReady,
    onError: (message: string, code: string) => {
      closeSocket();
      params.onError(message, code);
    },
    onClose: (message: string) => {
      closeSocket();
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
