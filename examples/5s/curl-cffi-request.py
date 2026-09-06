#!/usr/bin/env python3
import base64
import json
import socket
import sys

from curl_cffi import CurlOpt, requests


def perform(session, request):
    response = session.request(
        request["method"],
        request["url"],
        headers=request.get("headers") or {},
        data=base64.b64decode(request.get("body_base64") or ""),
        allow_redirects=False,
        impersonate=request.get("impersonate") or "firefox135",
        timeout=request.get("timeout") or 30,
        discard_cookies=True,
    )
    headers = {}
    set_cookie = []
    for name, value in response.headers.multi_items():
        key = name.lower()
        if key == "set-cookie":
            set_cookie.append(value)
        headers[key] = f"{headers[key]}, {value}" if key in headers else value
    return {
        "id": request.get("id"),
        "status": response.status_code,
        "status_text": response.reason,
        "url": response.url,
        "headers": headers,
        "set_cookie": set_cookie,
        "body_base64": base64.b64encode(response.content).decode("ascii"),
    }


def main():
    resolve = []
    try:
        edge = socket.gethostbyname("challenges.cloudflare.com")
        resolve.append(f"brunhild.challenges.cloudflare.com:443:{edge}")
    except OSError:
        pass
    options = {CurlOpt.IPRESOLVE: 1}
    if resolve:
        options[CurlOpt.RESOLVE] = resolve
    session = requests.Session(curl_options=options)
    try:
        if "--server" not in sys.argv:
            json.dump(perform(session, json.load(sys.stdin)), sys.stdout)
            return
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            try:
                result = perform(session, request)
            except Exception as error:
                result = {"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}
            sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    finally:
        session.close()


if __name__ == "__main__":
    main()
