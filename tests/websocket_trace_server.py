#!/usr/bin/env python3
"""Minimal local WebSocket echo server for the Firefox Trace fixture."""

import argparse
import base64
import hashlib
import socketserver


class EchoHandler(socketserver.StreamRequestHandler):
    def handle(self):
        request = self.rfile.readline().decode("ascii", "replace")
        if not request.startswith("GET "):
            return
        headers = {}
        while True:
            line = self.rfile.readline().decode("ascii", "replace").strip()
            if not line:
                break
            name, value = line.split(":", 1)
            headers[name.lower()] = value.strip()
        key = headers.get("sec-websocket-key")
        if not key:
            return
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
        ).digest()).decode("ascii")
        self.wfile.write(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode("ascii")
        )
        self.wfile.flush()
        while True:
            first = self.rfile.read(2)
            if len(first) != 2:
                return
            opcode = first[0] & 0x0F
            length = first[1] & 0x7F
            masked = bool(first[1] & 0x80)
            if length == 126:
                length = int.from_bytes(self.rfile.read(2), "big")
            elif length == 127:
                length = int.from_bytes(self.rfile.read(8), "big")
            mask = self.rfile.read(4) if masked else b""
            payload = self.rfile.read(length)
            if masked:
                payload = bytes(value ^ mask[index % 4]
                                for index, value in enumerate(payload))
            if opcode == 0x8:
                self.wfile.write(b"\x88\x00")
                self.wfile.flush()
                return
            if opcode in (0x1, 0x2):
                header = bytes([0x80 | opcode])
                if length < 126:
                    header += bytes([length])
                elif length < 65536:
                    header += b"\x7e" + length.to_bytes(2, "big")
                else:
                    header += b"\x7f" + length.to_bytes(8, "big")
                self.wfile.write(header + payload)
                self.wfile.flush()


class EchoServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with EchoServer(("127.0.0.1", args.port), EchoHandler) as server:
        print(f"WebSocket echo fixture listening on ws://127.0.0.1:{args.port}/echo")
        server.serve_forever()


if __name__ == "__main__":
    main()
