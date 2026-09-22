//go:build js && wasm

package main

import (
	"net"
	"sync"
	"syscall/js"
	"time"
)

// jsConn is a net.Conn whose transport lives in JavaScript.
//
// Go never opens a socket. JavaScript owns the TCPSocket. It pushes every byte
// that arrives into feed, and it sends every byte that Go writes to the
// onWrite function. The SSH package sees an ordinary net.Conn.
type jsConn struct {
	mu     sync.Mutex
	queue  []byte
	err    error // not nil after the socket ended
	closed bool

	// signal wakes a blocked Read. It has capacity 1, so a send never blocks.
	// This matters: feed runs inside a JavaScript callback, and a JavaScript
	// callback must never block the event loop.
	signal chan struct{}

	onWrite js.Value // function(Uint8Array)
	onClose js.Value // function()
}

func newJSConn(onWrite, onClose js.Value) *jsConn {
	return &jsConn{
		signal:  make(chan struct{}, 1),
		onWrite: onWrite,
		onClose: onClose,
	}
}

// wake releases one blocked Read. It never blocks.
func (c *jsConn) wake() {
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

// feed adds bytes that arrived on the socket. JavaScript calls it.
func (c *jsConn) feed(b []byte) {
	c.mu.Lock()
	c.queue = append(c.queue, b...)
	c.mu.Unlock()
	c.wake()
}

// socketEnded records that the socket closed, with an optional reason.
func (c *jsConn) socketEnded(err error) {
	c.mu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
	c.wake()
}

func (c *jsConn) Read(p []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.queue) > 0 {
			n := copy(p, c.queue)
			if n == len(c.queue) {
				c.queue = nil
			} else {
				// Copy the remainder into a new slice. A re-slice keeps the
				// bytes that were read alive for as long as the session runs.
				rest := make([]byte, len(c.queue)-n)
				copy(rest, c.queue[n:])
				c.queue = rest
			}
			c.mu.Unlock()
			return n, nil
		}
		err := c.err
		c.mu.Unlock()
		if err != nil {
			return 0, err
		}
		<-c.signal
	}
}

func (c *jsConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return 0, net.ErrClosed
	}
	buf := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(buf, p)
	c.onWrite.Invoke(buf)
	return len(p), nil
}

func (c *jsConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	if c.err == nil {
		c.err = net.ErrClosed
	}
	c.mu.Unlock()
	c.wake()
	if c.onClose.Type() == js.TypeFunction {
		c.onClose.Invoke()
	}
	return nil
}

// jsAddr is a name for one end of the connection. The SSH package only prints
// it, so the text is enough.
type jsAddr string

func (a jsAddr) Network() string { return "tcp" }
func (a jsAddr) String() string  { return string(a) }

func (c *jsConn) LocalAddr() net.Addr  { return jsAddr("direct-sockets") }
func (c *jsConn) RemoteAddr() net.Addr { return jsAddr("direct-sockets") }

// The SSH package does not set deadlines with the options that this
// application uses, so these three do nothing.
func (c *jsConn) SetDeadline(t time.Time) error      { return nil }
func (c *jsConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *jsConn) SetWriteDeadline(t time.Time) error { return nil }
