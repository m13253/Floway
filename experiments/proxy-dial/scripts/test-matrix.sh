#!/usr/bin/env bash
# Full-matrix test for the proxy-dial test worker. Stamps a row per (runner, target).
set -u
WK=${WK:-https://proxy-dial-test.menci.workers.dev}
RUNNERS=(
  direct
  native-direct
  native-starttls
  userspace-direct
  http-connect
  http-connect-tls
  socks5
  trojan
  vless-tcp-tls
  vless-ws-tls
  ss-aead-chacha
  ss-aead-aes
  ss-2022
  reality
)
TARGETS=(echo httpbin large sse chunked abort sleep-then-200)
TMOUT=20

printf "%-22s" "runner\target"
for t in "${TARGETS[@]}"; do printf " %-12s" "$t"; done
printf "\n"

for r in "${RUNNERS[@]}"; do
  printf "%-22s" "$r"
  for t in "${TARGETS[@]}"; do
    case "$t" in
      sse)
        bytes=$(timeout 4 curl -sN -m 4 "$WK/$r/$t" 2>/dev/null | wc -c | tr -d ' ')
        if [ "${bytes:-0}" -gt 30 ]; then printf " %-12s" "ok($bytes)"; else printf " %-12s" "FAIL($bytes)"; fi
        ;;
      chunked)
        bytes=$(timeout 5 curl -sN -m 5 "$WK/$r/$t" 2>/dev/null | wc -c | tr -d ' ')
        if [ "${bytes:-0}" -gt 8 ]; then printf " %-12s" "ok($bytes)"; else printf " %-12s" "FAIL($bytes)"; fi
        ;;
      abort)
        out=$(curl -sS -m $TMOUT -o /dev/null -w "%{http_code}/%{size_download}" "$WK/$r/$t" 2>&1)
        printf " %-12s" "$out"
        ;;
      *)
        out=$(curl -sS -m $TMOUT -o /dev/null -w "%{http_code}/%{size_download}" "$WK/$r/$t" 2>&1)
        printf " %-12s" "$out"
        ;;
    esac
  done
  printf "\n"
done
