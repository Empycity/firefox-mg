#!/usr/bin/env python3
import base64
import json
import sys

from requests_go import Session
from requests_go.tls_config import config as tls_presets


def perform(session, request, tls_config):
    response = session.request(
        request["method"],
        request["url"],
        headers=request.get("headers") or {},
        data=base64.b64decode(request.get("body_base64") or ""),
        allow_redirects=False,
        tls_config=tls_config,
        timeout=request.get("timeout") or 30,
    )
    raw_headers = getattr(response.raw, "headers", None)
    getlist = getattr(raw_headers, "getlist", None)
    set_cookie = getlist("set-cookie") if callable(getlist) else []
    return {
        "id": request.get("id"),
        "status": response.status_code,
        "status_text": response.reason or "",
        "url": response.url,
        "headers": {str(name).lower(): value for name, value in response.headers.items()},
        "set_cookie": set_cookie,
        "body_base64": base64.b64encode(response.content).decode("ascii"),
    }


def main():
    preset_name = "TLS_FIREFOX_145"
    session = Session()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            try:
                selected = request.get("preset") or preset_name
                tls_config = getattr(tls_presets, selected)
                result = perform(session, request, tls_config)
            except Exception as error:
                result = {"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}
            sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    finally:
        session.close()


if __name__ == "__main__":
    main()
