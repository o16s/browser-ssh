// Command relay serves the web application and connects it to TCP port 22.
//
// A web page cannot open a TCP socket. Only an Isolated Web App can, through
// the Direct Sockets API. This program is the other way to reach port 22: it
// serves the page, and it gives the page a WebSocket that carries raw TCP.
//
// The relay is a byte pipe. It never reads the private key and it never sees
// plaintext, because the SSH encryption happens in the WebAssembly module in
// the browser tab.
//
// The page and the WebSocket come from one origin, so Chrome asks for no Local
// Network Access permission and finds no mixed content.
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// The built web application. The Makefile copies dist/ into assets/ before it
// builds this program, so one file is the whole application.
//
//go:embed all:assets
var assets embed.FS

func main() {
	addr := flag.String("addr", "0.0.0.0:9432", "the address to listen on")
	dir := flag.String("dir", "", "serve this directory instead of the built-in files")
	allowAny := flag.Bool("allow-any-host", false,
		"allow connections to public addresses as well as private ones")
	timeout := flag.Duration("timeout", 15*time.Second, "the time limit for one connection attempt")
	flag.Parse()

	files, err := webFiles(*dir)
	if err != nil {
		log.Fatalf("The web files are missing: %v\nRun make build first.", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", noStore(http.FileServer(http.FS(files))))
	mux.HandleFunc("/tcp", func(w http.ResponseWriter, r *http.Request) {
		serveTCP(w, r, *allowAny, *timeout)
	})

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("The address %s is not free: %v", *addr, err)
	}
	printBanner(listener.Addr().String(), *allowAny)
	log.Fatal(http.Serve(listener, mux))
}

// webFiles returns the built application, from disk or from the program.
func webFiles(dir string) (fs.FS, error) {
	if dir != "" {
		if _, err := os.Stat(dir + "/index.html"); err != nil {
			return nil, err
		}
		return os.DirFS(dir), nil
	}
	sub, err := fs.Sub(assets, "assets")
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, err
	}
	return sub, nil
}

// noStore stops the browser from keeping an old build.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// serveTCP turns one WebSocket into one TCP connection.
func serveTCP(w http.ResponseWriter, r *http.Request, allowAny bool, timeout time.Duration) {
	host := r.URL.Query().Get("host")
	port, err := strconv.Atoi(r.URL.Query().Get("port"))
	if host == "" || err != nil || port < 1 || port > 65535 {
		http.Error(w, "give a host and a port", http.StatusBadRequest)
		return
	}
	if !allowAny {
		if err := checkPrivate(host); err != nil {
			log.Printf("refused %s:%d: %v", host, port, err)
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
	}

	// A page from another site must not use this relay. Without this check any
	// web page that you open can reach every host on your network.
	if err := checkOrigin(r); err != nil {
		log.Printf("refused an origin: %v", err)
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // checkOrigin above does this work
	})
	if err != nil {
		log.Printf("the WebSocket did not open: %v", err)
		return
	}
	defer conn.CloseNow()
	// An SSH session has no size limit, so the frame limit is off.
	conn.SetReadLimit(-1)

	target := net.JoinHostPort(host, strconv.Itoa(port))
	tcp, err := net.DialTimeout("tcp", target, timeout)
	if err != nil {
		log.Printf("the connection to %s failed: %v", target, err)
		conn.Close(websocket.StatusInternalError, err.Error())
		return
	}
	defer tcp.Close()
	log.Printf("open  %s", target)
	defer log.Printf("close %s", target)

	pipe(r.Context(), conn, tcp)
}

// pipe copies bytes in both directions until one side ends.
func pipe(ctx context.Context, ws *websocket.Conn, tcp net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{}, 2)

	// From the browser to the remote host.
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			kind, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageBinary {
				continue
			}
			if _, err := tcp.Write(data); err != nil {
				return
			}
		}
	}()

	// From the remote host to the browser.
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := tcp.Read(buf)
			if n > 0 {
				if err := ws.Write(ctx, websocket.MessageBinary, buf[:n]); err != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	<-done
	cancel()
	tcp.Close()
	ws.Close(websocket.StatusNormalClosure, "")
	<-done
}

// checkPrivate refuses a target that is not on a local network.
//
// Without this rule the relay is an open proxy: anything that reaches its port
// can connect to any host on the internet through it.
func checkPrivate(host string) error {
	addresses, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("the name %q has no address", host)
	}
	for _, ip := range addresses {
		if !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
			return fmt.Errorf(
				"%s is not on a local network. Use -allow-any-host to permit it", ip)
		}
	}
	return nil
}

// checkOrigin permits only a page that the relay itself served.
func checkOrigin(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// A tool such as curl sends no Origin. A browser always sends one.
		return nil
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return errors.New("the Origin header is not a URL")
	}
	if strings.EqualFold(parsed.Host, r.Host) {
		return nil
	}
	return fmt.Errorf("the origin %q is not this relay", origin)
}

func printBanner(addr string, allowAny bool) {
	_, port, _ := net.SplitHostPort(addr)
	fmt.Println("LAN SSH relay")
	fmt.Println("")
	fmt.Printf("  Open http://localhost:%s in Chrome, Edge or Firefox.\n", port)
	if addresses, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addresses {
			if ipNet, ok := a.(*net.IPNet); ok && ipNet.IP.To4() != nil && !ipNet.IP.IsLoopback() {
				fmt.Printf("  Or     http://%s:%s from another machine.\n", ipNet.IP, port)
			}
		}
	}
	fmt.Println("")
	if allowAny {
		fmt.Println("  ! -allow-any-host is on. The relay will connect to any address.")
	} else {
		fmt.Println("  The relay connects only to loopback and private addresses.")
	}
	fmt.Println("  The private key stays in the browser. The relay carries encrypted bytes only.")
	fmt.Println("")
	io.Discard.Write(nil)
}
