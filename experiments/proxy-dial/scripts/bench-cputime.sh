#!/usr/bin/env bash
# Run /bench/{runner}/{target} 10x for each combination, parse the JSON
# timings, and report median + p90 for each metric.
set -u
WK=${WK:-https://proxy-dial-test.menci.workers.dev}
ITERS=${ITERS:-10}

declare -a RUNNERS=(native-direct userspace-direct)
declare -a TARGETS=(large-500k large-5mb upload-500k upload-5mb)

# WARMUP — TLS keys + module bundle hot
for r in "${RUNNERS[@]}"; do
  for t in "${TARGETS[@]}"; do
    curl -sS -o /dev/null -m 30 "$WK/bench/$r/$t" >/dev/null 2>&1 || true
  done
done

echo "ITERS=$ITERS, target server: $WK"
echo
printf "%-20s %-12s | %-30s | %-30s | %-30s\n" runner target "handshake_ms (med/p90/max)" "ttfb_ms (med/p90/max)" "total_ms (med/p90/max)"

stats() {
  python3 - "$@" <<'PY'
import sys, statistics
xs=sorted(float(x) for x in sys.argv[1:])
if not xs: print("-"); sys.exit(0)
mid = statistics.median(xs)
p90 = xs[int(len(xs)*0.9) if len(xs)>1 else 0]
print(f"{mid:.0f} / {p90:.0f} / {xs[-1]:.0f}")
PY
}

for r in "${RUNNERS[@]}"; do
  for t in "${TARGETS[@]}"; do
    handshake=()
    ttfb=()
    total=()
    drain=()
    for i in $(seq 1 $ITERS); do
      out=$(curl -sS -m 30 "$WK/bench/$r/$t" 2>&1)
      hs=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin)['handshake_and_headers_ms'])" 2>/dev/null) || hs=0
      tf=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin)['ttfb_ms'])" 2>/dev/null) || tf=0
      tt=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin)['total_ms'])" 2>/dev/null) || tt=0
      dr=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin)['body_drain_ms'])" 2>/dev/null) || dr=0
      handshake+=("$hs"); ttfb+=("$tf"); total+=("$tt"); drain+=("$dr")
    done
    printf "%-20s %-12s | %-30s | %-30s | %-30s\n" "$r" "$t" "$(stats "${handshake[@]}")" "$(stats "${ttfb[@]}")" "$(stats "${total[@]}")"
    echo "    body_drain: $(stats "${drain[@]}")"
    echo "    raw handshake: ${handshake[*]}"
    echo "    raw total:     ${total[*]}"
  done
done
