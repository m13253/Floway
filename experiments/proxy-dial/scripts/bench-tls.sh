#!/usr/bin/env bash
# Compare wall-clock latency across TLS-handling strategies:
#   userspace-direct: connect plain + reclaim-tls userspace TLS
#   native-direct:    connect with secureTransport='on' (workerd's native TLS)
#
# Both go to the same upstream over HTTPS so the only variable is which TLS
# stack does the inner handshake. We measure cold (first-request) and warm
# (re-use cached subrequest path?) timings for echo (small) and large (5 MB).

set -u
WK=${WK:-https://proxy-dial-test.menci.workers.dev}
ITERS=${ITERS:-10}

bench() {
  local runner="$1"
  local target="$2"
  local total=0
  local samples=()
  for i in $(seq 1 $ITERS); do
    local t=$(curl -sS -o /dev/null -m 30 -w "%{time_total}" "$WK/$runner/$target")
    samples+=("$t")
  done
  echo "  $runner / $target: ${samples[*]}"
}

echo "ITERS=$ITERS"
echo
echo "=== echo (small body) ==="
bench native-direct echo
bench userspace-direct echo
echo
echo "=== large (5 MB body) ==="
bench native-direct large
bench userspace-direct large
