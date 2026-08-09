#!/usr/bin/env python3
"""Serve the trace smoke page and deterministic POST responses."""

import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class TraceSmokeHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("content-length", "0"))
        request_body = self.rfile.read(size)
        response_body = json.dumps(
            {
                "ok": True,
                "path": self.path,
                "request_size": len(request_body),
                "payload": "trace-response-artifact-" + "x" * 8192,
            },
            separators=(",", ":"),
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    handler = partial(TraceSmokeHandler, directory=root)
    ThreadingHTTPServer((args.host, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
