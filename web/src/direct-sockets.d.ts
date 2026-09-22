// Types for the Direct Sockets API of Chrome.
//
// The API is only present inside an Isolated Web App whose manifest holds the
// direct-sockets permissions policy. Outside that, TCPSocket is undefined.
// See https://developer.chrome.com/docs/iwa/direct-sockets

interface TCPSocketOpenInfo {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
}

interface TCPSocketOptions {
  sendBufferSize?: number;
  receiveBufferSize?: number;
  noDelay?: boolean;
  keepAliveDelay?: number;
  dnsQueryType?: 'ipv4' | 'ipv6';
}

declare class TCPSocket {
  constructor(remoteAddress: string, remotePort: number, options?: TCPSocketOptions);
  readonly opened: Promise<TCPSocketOpenInfo>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

// The Go runtime glue installs this class on the global object.
declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

// The seven functions that the Go module installs. See go/wasm/main.go.
interface SSHCore {
  sshConnect(config: unknown): void;
  sshWrite(bytes: Uint8Array): void;
  sshResize(cols: number, rows: number): void;
  sshClose(): void;
  sshSocketData(bytes: Uint8Array): void;
  sshSocketClosed(reason: string): void;
  sshHostKeyResponse(accept: boolean): void;
  __sshCoreReady?: () => void;
}
