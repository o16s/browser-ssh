# Build targets for the LAN SSH Isolated Web App.
#
#   make build    Build dist/ (the installable application)
#   make bundle   Sign dist/ into dist/app.swbn
#   make serve    Build the relay and run it. This is the usual way to use it.
#   make relay    Build the relay binary into bin/browser-ssh
#   make dev      Serve dist/ on 0.0.0.0:9432 for the proxy-mode install
#   make test     Run the Go SSH core against a local sshd in Docker
#   make pages    Build site/ for GitHub Pages
#
SHELL := /usr/bin/env bash
GOROOT := $(shell go env GOROOT)
GO_SOURCES := $(shell find go -name '*.go' -not -name '*_test.go') go/go.mod
WEB_SOURCES := $(shell find web/src -type f) web/index.html web/vite.config.ts

DEV_HOST ?= 0.0.0.0
DEV_PORT ?= 9432

.PHONY: help all build bundle dev test key icon clean pages check relay serve relay-all

help:
	@sed -n 's/^#   //p' Makefile

all: build

# --- dependencies ----------------------------------------------------------

node_modules: package.json
	npm install
	@touch node_modules

web/node_modules: web/package.json
	cd web && npm install
	@touch web/node_modules

# --- build products --------------------------------------------------------

# The Go SSH core, for the browser. The -s and -w flags drop the symbol table,
# which takes about two megabytes off the binary.
web/public/ssh.wasm: $(GO_SOURCES)
	cd go && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o ../web/public/ssh.wasm ./wasm
	@ls -lh web/public/ssh.wasm

# The Go runtime glue, without edits. Go 1.24 and later keep it in lib/wasm.
web/public/wasm_exec.js: $(GOROOT)/lib/wasm/wasm_exec.js
	cp $< $@

web/public/icon.png: scripts/make-icon.mjs
	node scripts/make-icon.mjs web/public/icon.png

icon: web/public/icon.png

# dist/ is the installable application. It is not one HTML file: Chrome gives
# every Isolated Web App the policy "script-src 'self' 'wasm-unsafe-eval'",
# and for an Isolated Web App 'self' does not include an inline script. So the
# JavaScript must be a file of its own.
build: web/node_modules web/public/ssh.wasm web/public/wasm_exec.js web/public/icon.png $(WEB_SOURCES)
	cd web && npm run build
	mkdir -p dist/.well-known
	cp web/manifest/manifest.webmanifest dist/.well-known/manifest.webmanifest
	@echo ""
	@echo "dist/ is ready:"
	@cd dist && find . -type f | sort | sed 's/^\./  /'

# --- the relay -------------------------------------------------------------

# The relay serves the web application and turns a WebSocket into a TCP
# connection. A web page cannot open a TCP socket, so this program is the way
# to reach port 22 without an Isolated Web App. The built application goes
# inside the binary, so one file is everything.
RELAY_ASSETS := go/relay/assets

relay: bin/browser-ssh

bin/browser-ssh: build $(GO_SOURCES)
	rm -rf $(RELAY_ASSETS)
	mkdir -p $(RELAY_ASSETS) bin
	cp -r dist/. $(RELAY_ASSETS)/
	rm -f $(RELAY_ASSETS)/app.swbn $(RELAY_ASSETS)/update.json
	touch $(RELAY_ASSETS)/.gitkeep
	cd go && go build -trimpath -ldflags="-s -w" -o ../bin/browser-ssh ./relay
	@ls -lh bin/browser-ssh

serve: relay
	./bin/browser-ssh -addr $(DEV_HOST):$(DEV_PORT)

# The binaries that the GitHub Pages site offers.
relay-all: build
	rm -rf $(RELAY_ASSETS)
	mkdir -p $(RELAY_ASSETS) bin
	cp -r dist/. $(RELAY_ASSETS)/
	rm -f $(RELAY_ASSETS)/app.swbn $(RELAY_ASSETS)/update.json
	touch $(RELAY_ASSETS)/.gitkeep
	cd go && GOOS=linux  GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/browser-ssh-linux-amd64   ./relay
	cd go && GOOS=linux  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/browser-ssh-linux-arm64   ./relay
	cd go && GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/browser-ssh-macos-arm64   ./relay
	cd go && GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/browser-ssh-windows-amd64.exe ./relay
	@ls -lh bin/

# --- signing and packaging -------------------------------------------------

# The signing key gives the application its identity. A new key gives a new
# Web Bundle ID, so keep this file.
private.pem:
	openssl genpkey -algorithm ed25519 -out private.pem
	chmod 600 private.pem
	@echo "Generated private.pem. It is in .gitignore. Keep a copy."

key: private.pem

# bundle does not depend on private.pem. A missing key must give a warning and
# an unsigned bundle, never a new key: a new key gives the application a new
# Web Bundle ID, and Chrome then treats it as a different application.
bundle: build node_modules
	node scripts/bundle.mjs

pages: bundle relay-all
	node scripts/pages.mjs

# --- run and test ----------------------------------------------------------

dev: build
	DEV_HOST=$(DEV_HOST) DEV_PORT=$(DEV_PORT) node scripts/dev-server.mjs

test:
	./scripts/test/run.sh

# Everything that a change must not break.
check: web/node_modules
	cd go && gofmt -l . && go vet ./...
	cd go && GOOS=js GOARCH=wasm go vet ./wasm
	cd web && npm run typecheck

clean:
	rm -rf dist site bin
	rm -rf $(RELAY_ASSETS)
	rm -f web/public/ssh.wasm web/public/wasm_exec.js web/public/icon.png
