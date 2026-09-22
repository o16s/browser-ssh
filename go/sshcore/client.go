package sshcore

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Config holds everything that one SSH session needs.
type Config struct {
	// User is the remote account name.
	User string
	// PrivateKey is an OpenSSH or PEM private key.
	PrivateKey []byte
	// Passphrase decrypts PrivateKey. It can be empty.
	Passphrase string
	// Cols and Rows give the first size of the terminal window.
	Cols, Rows int

	// HostKeyCheck gets the SHA256 fingerprint and the key type of the remote
	// host. It returns true to accept the host. It blocks the goroutine that
	// does the handshake, so the caller can ask the user. A nil value refuses
	// every host.
	HostKeyCheck func(fingerprint, keyType string) bool

	// OnData gets each block of output from the remote shell.
	OnData func([]byte)

	// OnClose runs one time when the session ends. The error is nil after a
	// clean exit.
	OnClose func(error)
}

// ErrHostKeyRefused says that HostKeyCheck did not accept the remote host key.
var ErrHostKeyRefused = errors.New("the user did not accept the host key")

// Session is one interactive shell on one remote host.
type Session struct {
	conn    net.Conn
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser

	closeOnce sync.Once
	onClose   func(error)
}

// callbackWriter sends everything that is written to it to a function.
type callbackWriter struct {
	fn func([]byte)
}

func (w callbackWriter) Write(p []byte) (int, error) {
	if w.fn != nil {
		// The SSH package uses p again after this call, so copy the bytes.
		b := make([]byte, len(p))
		copy(b, p)
		w.fn(b)
	}
	return len(p), nil
}

// Dial does the SSH handshake on an open connection and starts a shell.
//
// conn must already be connected to the remote host. addr is the "host:port"
// text of that host, and the SSH package uses it only for messages and for the
// host key callback. Dial blocks until the shell is ready, so the caller must
// run it in a goroutine when the caller is an event loop.
func Dial(conn net.Conn, addr string, cfg Config) (*Session, error) {
	signer, err := ParseKey(cfg.PrivateKey, cfg.Passphrase)
	if err != nil {
		return nil, err
	}

	hostKeyCallback := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if cfg.HostKeyCheck == nil {
			return ErrHostKeyRefused
		}
		if cfg.HostKeyCheck(ssh.FingerprintSHA256(key), key.Type()) {
			return nil
		}
		return ErrHostKeyRefused
	}

	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: hostKeyCallback,
	})
	if err != nil {
		return nil, fmt.Errorf("the SSH handshake failed: %w", err)
	}
	client := ssh.NewClient(clientConn, chans, reqs)

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("the SSH session did not start: %w", err)
	}

	cols, rows := cfg.Cols, cfg.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 38400,
		ssh.TTY_OP_OSPEED: 38400,
	}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("the remote host refused a terminal: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("the input pipe did not open: %w", err)
	}

	out := callbackWriter{fn: cfg.OnData}
	session.Stdout = out
	session.Stderr = out

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("the remote shell did not start: %w", err)
	}

	s := &Session{
		conn:    conn,
		client:  client,
		session: session,
		stdin:   stdin,
		onClose: cfg.OnClose,
	}

	// Wait for the shell to end in the background, then report the result one
	// time. An exit through a signal or a non-zero status is a normal end of
	// an interactive shell, so it is not an error here.
	go func() {
		err := session.Wait()
		var exitErr *ssh.ExitError
		var missingErr *ssh.ExitMissingError
		if errors.As(err, &exitErr) || errors.As(err, &missingErr) {
			err = nil
		}
		s.finish(err)
	}()

	return s, nil
}

// Write sends keyboard input to the remote shell.
func (s *Session) Write(p []byte) (int, error) {
	return s.stdin.Write(p)
}

// Resize tells the remote host the new size of the terminal window.
func (s *Session) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return fmt.Errorf("the window size %dx%d is not valid", cols, rows)
	}
	return s.session.WindowChange(rows, cols)
}

// Close ends the session. A second call does nothing.
func (s *Session) Close() error {
	s.finish(nil)
	return nil
}

// finish closes everything one time and reports the result.
func (s *Session) finish(err error) {
	s.closeOnce.Do(func() {
		s.stdin.Close()
		s.session.Close()
		s.client.Close()
		s.conn.Close()
		if s.onClose != nil {
			s.onClose(err)
		}
	})
}
