from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true,"received":')
        self.wfile.write(str(len(body)).encode("ascii"))
        self.wfile.write(b"}")

    def end_headers(self):
        if self.path.startswith("/script-resource.js"):
            self.send_header("SourceMap", "/script-resource.header.js.map")
            self.send_header("X-Trace-Smoke", "script-resource")
        super().end_headers()


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    server = ThreadingHTTPServer(
        ("127.0.0.1", 8767), partial(Handler, directory=str(root))
    )
    server.serve_forever()
