#!/usr/bin/env python3
import json
import sys

from curl_cffi import requests


def main():
    payload = json.load(sys.stdin)
    response = requests.get(
        payload["url"],
        headers=payload.get("headers") or {},
        impersonate=payload.get("impersonate") or "chrome120",
        timeout=payload.get("timeout") or 20,
    )
    print(
        json.dumps(
            {
                "status": response.status_code,
                "headers": dict(response.headers),
                "text": response.text,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
