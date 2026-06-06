#!/usr/bin/env python3
"""Minimal upstream test server — runs behind nginx on 127.0.0.1:8090.

Endpoints:
  GET /sse              — SSE, 5 events, 200ms spacing, deterministic body, then closes cleanly
  GET /chunked          — Transfer-Encoding: chunked, 5 chunks at 1s spacing
  GET /slow             — slow 10s body drip
  GET /abort            — sends partial body then closes (broken response)
  GET /sleep-then-200   — sleeps 8s then returns 200 (for connect/read timeout testing)
  GET|POST /echo        — echo request headers + body as JSON
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time, json, os, sys

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def _hdrs(self, ct, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ct)
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        p = self.path
        if p == "/sse":
            self._hdrs("text/event-stream", extra={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
            try:
                for i in range(1, 6):
                    chunk = f"event: tick\nid: {i}\ndata: hello-{i}\n\n".encode()
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(0.2)
                self.wfile.write(b"event: done\ndata: bye\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if p == "/chunked":
            self._hdrs("text/plain", extra={"X-Accel-Buffering": "no"})
            try:
                for i in range(1, 6):
                    self.wfile.write(f"chunk-{i}\n".encode())
                    self.wfile.flush()
                    time.sleep(1.0)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if p == "/slow":
            self._hdrs("text/plain", extra={"X-Accel-Buffering": "no"})
            try:
                for _ in range(10):
                    self.wfile.write(b"drip\n")
                    self.wfile.flush()
                    time.sleep(1.0)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if p == "/abort":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"START-OF-PARTIAL-BODY\n")
            self.wfile.flush()
            self.wfile.close()  # forcefully close before Content-Length is satisfied
            return
        if p == "/sleep-then-200":
            time.sleep(8)
            self._hdrs("text/plain")
            self.wfile.write(b"slept-then-ok\n")
            return
        if p.startswith("/echo"):
            return self._echo(b"")
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(ln) if ln else b""
        self._echo(body)

    def _echo(self, body):
        out = json.dumps({
            "method": self.command,
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "body_len": len(body),
            "body_hex_head": body[:64].hex(),
        }, indent=2).encode()
        self._hdrs("application/json", extra={"Content-Length": str(len(out))})
        self.wfile.write(out)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8090"))
    print(f"upstream test server listening on 127.0.0.1:{port}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
