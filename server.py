#!/usr/bin/env python3
import json
import os
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_URL = os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope-intl.aliyuncs.com/api/v1").rstrip("/")
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "").strip()
REGION = os.environ.get("DASHSCOPE_REGION", "ap-southeast-1").strip()

class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self):
        if not API_KEY:
            self._send_json({"error": "Missing DASHSCOPE_API_KEY"}, status=500)
            return

        upstream = f"{BASE_URL}{self.path.replace('/api', '')}"
        method = self.command
        body = None
        if method in {"POST", "PUT", "PATCH"}:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else None

        req = urllib.request.Request(upstream, data=body, method=method)
        req.add_header("Authorization", f"Bearer {API_KEY}")
        req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        req.add_header("X-DashScope-Async", "enable")
        if REGION:
            req.add_header("X-DashScope-Region", REGION)

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                content = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() in {"content-length", "content-type"}:
                        self.send_header(key, value)
                self.end_headers()
                self.wfile.write(content)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            self._send_json({"error": str(e)}, status=502)

    def do_GET(self):
        if self.path == "/api/health":
            ok = bool(API_KEY)
            self._send_json({
                "ok": ok,
                "region": REGION,
                "base_url": BASE_URL,
                "message": "DashScope proxy ready" if ok else "Missing DASHSCOPE_API_KEY"
            })
            return

        if self.path.startswith("/api/"):
            self._proxy()
            return

        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(405)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "3000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Short Drama Studio running on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
