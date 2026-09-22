//go:build js && wasm

// Command wasm is the browser side of the SSH core.
//
// It installs seven functions on the JavaScript global object and then waits.
// JavaScript owns the TCPSocket and gives this program a byte stream. This
// program owns the SSH protocol and gives JavaScript terminal bytes.
package main

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"syscall/js"

	"github.com/o16s/browser-ssh/go/sshcore"
)

// state holds the one session that the application can have at a time.
type state struct {
	mu      sync.Mutex
	conn    *jsConn
	session *sshcore.Session
	input   *writePump
	hostKey chan bool
}

var st state

func main() {
	global := js.Global()
	global.Set("sshConnect", js.FuncOf(sshConnect))
	global.Set("sshWrite", js.FuncOf(sshWrite))
	global.Set("sshResize", js.FuncOf(sshResize))
	global.Set("sshClose", js.FuncOf(sshClose))
	global.Set("sshSocketData", js.FuncOf(sshSocketData))
	global.Set("sshSocketClosed", js.FuncOf(sshSocketClosed))
	global.Set("sshHostKeyResponse", js.FuncOf(sshHostKeyResponse))

	// Tell the page that the functions are ready. The page sets this function
	// before it starts the module.
	if ready := global.Get("__sshCoreReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}

	// Keep the Go runtime alive. Without this the program exits and every
	// function above stops working.
	select {}
}

// toJSBytes copies Go bytes into a new Uint8Array.
func toJSBytes(b []byte) js.Value {
	out := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(out, b)
	return out
}

// fromJSBytes copies a Uint8Array into a new Go slice.
func fromJSBytes(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// call runs a JavaScript callback if the caller supplied one.
func call(fn js.Value, args ...any) {
	if fn.Type() == js.TypeFunction {
		fn.Invoke(args...)
	}
}

// errorCode turns a known error into a short word that the user interface can
// act on. An unknown error gives an empty string.
func errorCode(err error) string {
	switch {
	case errors.Is(err, sshcore.ErrPassphraseRequired):
		return "passphrase-required"
	case errors.Is(err, sshcore.ErrPassphraseWrong):
		return "passphrase-wrong"
	case errors.Is(err, sshcore.ErrHostKeyRefused):
		return "host-key-refused"
	}
	return ""
}

// writePump keeps keyboard input in order and never blocks the caller.
//
// A write to the SSH channel can wait for the flow control window of the
// remote host. sshWrite runs inside a JavaScript callback, and a JavaScript
// callback must not wait. So sshWrite adds the bytes to a queue and one
// goroutine does the slow part.
type writePump struct {
	mu      sync.Mutex
	queue   []byte
	stopped bool
	signal  chan struct{}
	session *sshcore.Session
}

func newWritePump(session *sshcore.Session) *writePump {
	p := &writePump{signal: make(chan struct{}, 1), session: session}
	go p.run()
	return p
}

func (p *writePump) add(b []byte) {
	p.mu.Lock()
	p.queue = append(p.queue, b...)
	p.mu.Unlock()
	select {
	case p.signal <- struct{}{}:
	default:
	}
}

func (p *writePump) stop() {
	p.mu.Lock()
	p.stopped = true
	p.mu.Unlock()
	select {
	case p.signal <- struct{}{}:
	default:
	}
}

func (p *writePump) run() {
	for {
		p.mu.Lock()
		batch := p.queue
		p.queue = nil
		stopped := p.stopped
		p.mu.Unlock()

		if len(batch) > 0 {
			if _, err := p.session.Write(batch); err != nil {
				return
			}
		}
		if stopped && len(batch) == 0 {
			return
		}
		if len(batch) == 0 {
			<-p.signal
		}
	}
}

// sshConnect starts one SSH session. It returns at once and reports the result
// through the onReady and onError callbacks of the configuration object.
//
// The configuration object holds: host, port, user, privateKey, passphrase,
// cols, rows, and the callbacks onSocketWrite, onSocketClose, onData, onClose,
// onHostKey, onReady and onError.
func sshConnect(this js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeObject {
		return nil
	}
	cfg := args[0]

	onError := cfg.Get("onError")
	onReady := cfg.Get("onReady")
	onData := cfg.Get("onData")
	onClose := cfg.Get("onClose")
	onHostKey := cfg.Get("onHostKey")

	host := cfg.Get("host").String()
	port := cfg.Get("port").Int()
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	conn := newJSConn(cfg.Get("onSocketWrite"), cfg.Get("onSocketClose"))
	hostKey := make(chan bool, 1)

	st.mu.Lock()
	st.conn = conn
	st.hostKey = hostKey
	st.session = nil
	st.input = nil
	st.mu.Unlock()

	core := sshcore.Config{
		User:       cfg.Get("user").String(),
		PrivateKey: []byte(cfg.Get("privateKey").String()),
		Passphrase: cfg.Get("passphrase").String(),
		Cols:       cfg.Get("cols").Int(),
		Rows:       cfg.Get("rows").Int(),
		HostKeyCheck: func(fingerprint, keyType string) bool {
			if onHostKey.Type() != js.TypeFunction {
				return false
			}
			// Ask the page, then wait. The JavaScript event loop stays free,
			// so the answer can arrive.
			onHostKey.Invoke(fingerprint, keyType)
			return <-hostKey
		},
		OnData: func(b []byte) {
			call(onData, toJSBytes(b))
		},
		OnClose: func(err error) {
			message := ""
			if err != nil {
				message = err.Error()
			}
			st.mu.Lock()
			if st.input != nil {
				st.input.stop()
			}
			st.session = nil
			st.input = nil
			st.mu.Unlock()
			call(onClose, message)
		},
	}

	// The handshake blocks, so it cannot run in the JavaScript callback.
	go func() {
		session, err := sshcore.Dial(conn, addr, core)
		if err != nil {
			conn.Close()
			call(onError, err.Error(), errorCode(err))
			return
		}
		st.mu.Lock()
		st.session = session
		st.input = newWritePump(session)
		st.mu.Unlock()
		call(onReady)
	}()

	return nil
}

// sshWrite sends keyboard input to the remote shell.
func sshWrite(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	st.mu.Lock()
	input := st.input
	st.mu.Unlock()
	if input == nil {
		return nil
	}
	input.add(fromJSBytes(args[0]))
	return nil
}

// sshResize tells the remote host the new size of the terminal window.
func sshResize(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return nil
	}
	st.mu.Lock()
	session := st.session
	st.mu.Unlock()
	if session == nil {
		return nil
	}
	// A window change needs no answer, so this call does not block.
	session.Resize(args[0].Int(), args[1].Int())
	return nil
}

// sshClose ends the session.
func sshClose(this js.Value, args []js.Value) any {
	st.mu.Lock()
	session, conn, hostKey := st.session, st.conn, st.hostKey
	st.mu.Unlock()

	// Release a handshake that waits for a host key answer.
	if hostKey != nil {
		select {
		case hostKey <- false:
		default:
		}
	}
	if session != nil {
		session.Close()
	} else if conn != nil {
		conn.Close()
	}
	return nil
}

// sshSocketData gives the SSH core the bytes that arrived on the TCP socket.
func sshSocketData(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	st.mu.Lock()
	conn := st.conn
	st.mu.Unlock()
	if conn == nil {
		return nil
	}
	conn.feed(fromJSBytes(args[0]))
	return nil
}

// sshSocketClosed tells the SSH core that the TCP socket ended.
func sshSocketClosed(this js.Value, args []js.Value) any {
	st.mu.Lock()
	conn := st.conn
	st.mu.Unlock()
	if conn == nil {
		return nil
	}
	reason := "the connection closed"
	if len(args) > 0 && args[0].Type() == js.TypeString {
		if text := args[0].String(); text != "" {
			reason = text
		}
	}
	conn.socketEnded(errors.New(reason))
	return nil
}

// sshHostKeyResponse gives the answer of the user to the fingerprint question.
func sshHostKeyResponse(this js.Value, args []js.Value) any {
	st.mu.Lock()
	hostKey := st.hostKey
	st.mu.Unlock()
	if hostKey == nil || len(args) < 1 {
		return nil
	}
	select {
	case hostKey <- args[0].Bool():
	default:
	}
	return nil
}
