import { useCallback, useRef, useState } from 'react';
import { TerminalView, type TerminalHandle } from './Terminal';
import {
  acceptHostKey,
  connect,
  hasDirectSockets,
  type Connection,
} from './ssh';

type Status = 'idle' | 'connecting' | 'connected';

interface HostKeyQuestion {
  fingerprint: string;
  keyType: string;
}

export function App() {
  const [host, setHost] = useState('192.168.122.254');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Paste a private key, then click Connect.');
  const [failed, setFailed] = useState(false);
  const [question, setQuestion] = useState<HostKeyQuestion | null>(null);

  const term = useRef<TerminalHandle | null>(null);
  const connection = useRef<Connection | null>(null);
  // Accepted fingerprints live in memory only. A restart asks again.
  const accepted = useRef(new Set<string>());

  const socketsAvailable = hasDirectSockets();

  const report = (text: string, isError = false) => {
    setMessage(text);
    setFailed(isError);
  };

  const onTerminalReady = useCallback((handle: TerminalHandle) => {
    term.current = handle;
  }, []);

  const onInput = useCallback((data: string) => {
    connection.current?.write(data);
  }, []);

  const onResize = useCallback((cols: number, rows: number) => {
    connection.current?.resize(cols, rows);
  }, []);

  const finish = (text: string, isError: boolean) => {
    connection.current = null;
    setStatus('idle');
    report(text, isError);
  };

  const onConnect = async () => {
    if (privateKey.trim() === '') {
      report('A private key is necessary.', true);
      return;
    }
    const size = term.current?.size() ?? { cols: 80, rows: 24 };
    setStatus('connecting');
    report(`Connecting to ${host}:${port} ...`);

    try {
      connection.current = await connect({
        host: host.trim(),
        port: Number(port),
        user: user.trim(),
        privateKey,
        passphrase,
        cols: size.cols,
        rows: size.rows,
        onData: (bytes) => term.current?.write(bytes),
        onHostKey: (fingerprint, keyType) => {
          // A fingerprint that the user already accepted needs no question.
          if (accepted.current.has(fingerprint)) {
            acceptHostKey(true);
            return;
          }
          setQuestion({ fingerprint, keyType });
        },
        onReady: () => {
          setStatus('connected');
          report(`Connected to ${user}@${host}:${port}`);
          term.current?.focus();
        },
        onError: (text, code) => {
          if (code === 'passphrase-required') {
            finish('The private key is encrypted. Type the passphrase, then connect again.', true);
            return;
          }
          if (code === 'passphrase-wrong') {
            finish('The passphrase is not correct.', true);
            return;
          }
          finish(text, true);
        },
        onClose: (text) => {
          term.current?.writeLine('\r\n\x1b[33m<disconnected>\x1b[0m');
          finish(text === '' ? 'The session ended.' : text, text !== '');
        },
      });
    } catch (error: unknown) {
      finish(error instanceof Error ? error.message : String(error), true);
    }
  };

  const onDisconnect = () => {
    connection.current?.close();
  };

  const answerHostKey = (accept: boolean) => {
    if (question && accept) {
      accepted.current.add(question.fingerprint);
    }
    setQuestion(null);
    acceptHostKey(accept);
  };

  const busy = status !== 'idle';

  return (
    <div className="app">
      <div>
        {!socketsAvailable && (
          <div className="warning">
            TCPSocket is not available on this page. Install the application as an
            Isolated Web App. See README.md.
          </div>
        )}
        <div className="bar">
          <div className="field">
            <label htmlFor="host">Host</label>
            <input
              id="host"
              name="host"
              value={host}
              disabled={busy}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="port">Port</label>
            <input
              id="port"
              name="port"
              value={port}
              disabled={busy}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="user">User</label>
            <input
              id="user"
              name="user"
              value={user}
              disabled={busy}
              onChange={(e) => setUser(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="passphrase">Passphrase</label>
            <input
              id="passphrase"
              name="passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              disabled={busy}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          {status === 'connected' ? (
            <button type="button" className="ghost" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : (
            <button type="button" onClick={onConnect} disabled={status === 'connecting'}>
              {status === 'connecting' ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        {status === 'idle' && (
          <div className="keyrow">
            <div className="field">
              <label htmlFor="key">
                OpenSSH or PEM private key (memory only, never stored)
              </label>
              <textarea
                id="key"
                name="key"
                spellCheck={false}
                autoComplete="off"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <TerminalView onInput={onInput} onResize={onResize} onReady={onTerminalReady} />

      <div className={`status${failed ? ' error' : status === 'connected' ? ' ok' : ''}`}>
        {message}
      </div>

      {question && (
        <div className="dialog">
          <div className="card">
            <h2>Accept the host key?</h2>
            <p>
              {host} sent a {question.keyType} key. Compare this fingerprint with the
              one on the host.
            </p>
            <code>{question.fingerprint}</code>
            <p>
              The answer is kept in memory only. The next start asks again.
            </p>
            <div className="buttons">
              <button type="button" className="ghost" onClick={() => answerHostKey(false)}>
                Refuse
              </button>
              <button type="button" onClick={() => answerHostKey(true)}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
