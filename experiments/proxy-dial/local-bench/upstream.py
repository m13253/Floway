#!/usr/bin/env python3
"""Local HTTPS upstream for proxy-dial benchmarks.

Listens on 127.0.0.1:8443 with the same LE cert we use in production tests
(SAN = 23.145.36.136.sslip.io), so rustls/reclaim cert validation succeeds
when the worker connects with SNI=23.145.36.136.sslip.io.

Endpoints mirror the JP nginx + upstream-test setup:
  GET  /echo                   small JSON echo of headers
  GET  /large-500k.bin         500 KiB random body
  GET  /large-5mb.bin          5 MiB random body
  GET  /sse                    5 SSE events 200 ms apart
  POST /echo                   echoes body length, mirrors headers (used for upload tests)
"""
import http.server, ssl, json, os, time, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CERT_DIR = Path(__file__).parent / 'certs'
RAND_500K = os.urandom(500 * 1024)
RAND_5MB = os.urandom(5 * 1024 * 1024)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body, ct='application/octet-stream', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path
        if p == '/echo':
            return self._echo(b'')
        if p == '/large-500k.bin':
            return self._send(200, RAND_500K)
        if p == '/large-5mb.bin':
            return self._send(200, RAND_5MB)
        if p == '/sse':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            for i in range(1, 6):
                self.wfile.write(f"event: tick\nid: {i}\ndata: hello-{i}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.05)
            return
        self.send_response(404); self.end_headers()

    def do_POST(self):
        ln = int(self.headers.get('Content-Length', '0') or 0)
        body = self.rfile.read(ln) if ln else b''
        self._echo(body)

    def _echo(self, body):
        out = json.dumps({
            'method': self.command,
            'path': self.path,
            'body_len': len(body),
            'headers': dict(self.headers.items()),
        }, indent=2).encode()
        self._send(200, out, 'application/json')


def main():
    port = int(os.environ.get('PORT', '8443'))
    httpd = ThreadingHTTPServer(('127.0.0.1', port), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(CERT_DIR / 'fullchain.pem'),
                        keyfile=str(CERT_DIR / 'privkey.pem'))
    ctx.set_ciphers('TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:'
                    'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:'
                    'ECDHE-RSA-CHACHA20-POLY1305')
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f'local upstream listening on https://127.0.0.1:{port} (SNI: 23.145.36.136.sslip.io)', file=sys.stderr)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
