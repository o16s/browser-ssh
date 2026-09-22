package sshcore

import (
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// output collects everything that the remote shell sends.
type output struct {
	mu   sync.Mutex
	text strings.Builder
}

func (o *output) add(b []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.text.Write(b)
}

func (o *output) get() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.text.String()
}

// waitFor reads the output until it holds want at least count times.
func waitFor(t *testing.T, o *output, want string, count int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Count(o.get(), want) >= count {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%q did not appear %d times in %s. The output was:\n%s",
		want, count, timeout, o.get())
}

// TestInteractiveShell runs the full path against a real sshd.
//
// The test needs SSH_TEST_ADDR, SSH_TEST_USER and SSH_TEST_KEY. The script
// scripts/test/run.sh starts a container and sets them. Without them the test
// is skipped, so "go test ./..." works on a machine that has no Docker.
func TestInteractiveShell(t *testing.T) {
	addr := os.Getenv("SSH_TEST_ADDR")
	user := os.Getenv("SSH_TEST_USER")
	keyPath := os.Getenv("SSH_TEST_KEY")
	if addr == "" || user == "" || keyPath == "" {
		t.Skip("SSH_TEST_ADDR, SSH_TEST_USER or SSH_TEST_KEY is not set. Run make test.")
	}

	key, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("the test key was not read: %v", err)
	}

	// The browser gives the connection to this package. The test does the same
	// thing with net.Dial, so both paths use one code path after this line.
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		t.Fatalf("the connection to %s failed: %v", addr, err)
	}

	var out output
	var fingerprint, keyType string
	closed := make(chan error, 1)

	session, err := Dial(conn, addr, Config{
		User:       user,
		PrivateKey: key,
		Cols:       80,
		Rows:       24,
		HostKeyCheck: func(fp, kt string) bool {
			fingerprint, keyType = fp, kt
			return true
		},
		OnData:  out.add,
		OnClose: func(err error) { closed <- err },
	})
	if err != nil {
		t.Fatalf("Dial failed: %v", err)
	}

	if !strings.HasPrefix(fingerprint, "SHA256:") {
		t.Errorf("the fingerprint %q does not start with SHA256:", fingerprint)
	}
	if keyType == "" {
		t.Error("the host key type is empty")
	}

	// The acceptance test: "echo ok" must return "ok". The terminal echoes the
	// command as well, so "ok" must appear two times.
	if _, err := session.Write([]byte("echo ok\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	waitFor(t, &out, "ok", 2, 15*time.Second)

	// A second check that the echo of the command cannot pass by accident:
	// the text "42" is only in the answer, never in the command.
	if _, err := session.Write([]byte("echo $((6*7))\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	waitFor(t, &out, "42", 1, 15*time.Second)

	if err := session.Resize(120, 40); err != nil {
		t.Fatalf("Resize failed: %v", err)
	}
	// The remote shell must report the new size.
	if _, err := session.Write([]byte("stty size\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	waitFor(t, &out, "40 120", 1, 15*time.Second)

	if _, err := session.Write([]byte("exit\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("the session ended with an error: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the session did not end after exit")
	}

	// A second Close must be safe.
	if err := session.Close(); err != nil {
		t.Fatalf("the second Close failed: %v", err)
	}
}

// TestInterruptReachesRemoteShell makes sure that Ctrl-C stops a running
// command, which is acceptance test item 4.
func TestInterruptReachesRemoteShell(t *testing.T) {
	addr := os.Getenv("SSH_TEST_ADDR")
	user := os.Getenv("SSH_TEST_USER")
	keyPath := os.Getenv("SSH_TEST_KEY")
	if addr == "" || user == "" || keyPath == "" {
		t.Skip("SSH_TEST_ADDR, SSH_TEST_USER or SSH_TEST_KEY is not set. Run make test.")
	}

	key, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("the test key was not read: %v", err)
	}
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		t.Fatalf("the connection to %s failed: %v", addr, err)
	}

	var out output
	session, err := Dial(conn, addr, Config{
		User:         user,
		PrivateKey:   key,
		Cols:         80,
		Rows:         24,
		HostKeyCheck: func(string, string) bool { return true },
		OnData:       out.add,
		OnClose:      func(error) {},
	})
	if err != nil {
		t.Fatalf("Dial failed: %v", err)
	}
	defer session.Close()

	// Start a command that never ends by itself.
	if _, err := session.Write([]byte("sleep 300\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	time.Sleep(2 * time.Second)

	// Ctrl-C is the byte 0x03. The remote terminal must stop the sleep.
	if _, err := session.Write([]byte{0x03}); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := session.Write([]byte("echo BACK_AT_PROMPT\n")); err != nil {
		t.Fatalf("the write failed: %v", err)
	}
	// The word appears two times: the echo of the command and the answer.
	waitFor(t, &out, "BACK_AT_PROMPT", 2, 15*time.Second)
}
