#!/usr/bin/env bash
#
# Starts a local sshd in Docker, runs the Go SSH core against it, then removes
# the container. The container listens on 127.0.0.1:2222 by default.
#
# Set TEST_HOST and TEST_PORT to use another address.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"

TEST_HOST="${TEST_HOST:-127.0.0.1}"
TEST_PORT="${TEST_PORT:-2222}"
IMAGE="browser-ssh-test-sshd"
CONTAINER="browser-ssh-test-sshd"

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORK}" "${HERE}/authorized_keys"
}
trap cleanup EXIT

echo "==> Generate a throwaway key pair"
ssh-keygen -t ed25519 -N "" -C "browser-ssh-test" -f "${WORK}/id_ed25519" >/dev/null
cp "${WORK}/id_ed25519.pub" "${HERE}/authorized_keys"

echo "==> Build the sshd image"
docker build --quiet -t "${IMAGE}" "${HERE}" >/dev/null

echo "==> Start sshd on ${TEST_HOST}:${TEST_PORT}"
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER}" -p "${TEST_HOST}:${TEST_PORT}:22" "${IMAGE}" >/dev/null

echo "==> Wait for the port to answer"
for i in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/${TEST_HOST}/${TEST_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  if [ "${i}" = "60" ]; then
    echo "sshd did not start. The container log follows:" >&2
    docker logs "${CONTAINER}" >&2 || true
    exit 1
  fi
  sleep 0.5
done

echo "==> Run the Go test"
cd "${ROOT}/go"
SSH_TEST_ADDR="${TEST_HOST}:${TEST_PORT}" \
SSH_TEST_USER="root" \
SSH_TEST_KEY="${WORK}/id_ed25519" \
  go test ./... -count=1 -v -timeout 180s

echo ""
echo "==> Run the WebAssembly bridge against the same sshd"
WASM="${ROOT}/web/public/ssh.wasm"
if [ ! -f "${WASM}" ]; then
  echo "  Build the module first."
  (cd "${ROOT}/go" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "${WASM}" ./wasm)
fi
node "${HERE}/wasm-bridge.cjs" "${WASM}" "${TEST_HOST}" "${TEST_PORT}" root "${WORK}/id_ed25519"
