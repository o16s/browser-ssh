# Build targets for the LAN SSH Isolated Web App.
#
#   make build    Build dist/ (the installable application)
#   make bundle   Sign dist/ into dist/app.swbn
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

.PHONY: help all build bundle dev test key icon clean pages check

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

# --- signing and packaging -------------------------------------------------

# The signing key gives the application its identity. A new key gives a new
# Web Bundle ID, so keep this file.
private.pem:
	openssl genpkey -algorithm ed25519 -out private.pem
	chmod 600 private.pem
	@echo "Generated private.pem. It is in .gitignore. Keep a copy."

key: private.pem

bundle: build node_modules private.pem
	node scripts/bundle.mjs

pages: bundle
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
	rm -rf dist site
	rm -f web/public/ssh.wasm web/public/wasm_exec.js web/public/icon.png
