#!/usr/bin/env python3
"""Generate a fresh request for one page and print the HTTP response.

This is the single command-line entry point for jd_h5st_dynamic.  The caller
only supplies page; Node generates the dynamic request first, then curl_cffi
sends it with the generated headers and browser impersonation profile.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent
GENERATOR = ROOT / "generate_h5st.js"


def parse_page(argv: list[str]) -> str:
    parser = argparse.ArgumentParser(description="生成 page 对应请求并打印响应")
    parser.add_argument("page_pos", nargs="?", help="page，例如 3")
    parser.add_argument("--page", dest="page_opt", help="page，例如 --page=3")
    args = parser.parse_args(argv)
    if args.page_pos and args.page_opt and str(args.page_pos) != str(args.page_opt):
        parser.error("page 只传一个值")
    return str(args.page_opt or args.page_pos or "3")


def generate_request(page: str) -> dict[str, Any]:
    # generate_h5st.js 默认 force=true；这里显式设置，避免外部 shell 中残留
    # JD_FORCE_H5ST_INIT=0 导致普通命令意外复用旧 token。
    env = os.environ.copy()
    env["JD_FORCE_H5ST_INIT"] = "1"
    command = [
        "node",
        str(GENERATOR),
        f"--page={page}",
        "--browser=firefox",
    ]
    completed = subprocess.run(
        command,
        cwd=str(ROOT.parent),
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"动态请求生成失败：{detail}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"动态生成器输出不是 JSON：{completed.stdout[:500]}"
        ) from error
    if not isinstance(result, dict) or not result.get("url"):
        raise RuntimeError("动态生成器没有返回 url")
    return result


def request_generated(result: dict[str, Any]) -> dict[str, Any]:
    try:
        from curl_cffi import requests
    except ModuleNotFoundError as error:
        raise RuntimeError("当前 Python 环境缺少 curl_cffi，请使用 conda 环境 pythonProject") from error
    diagnostics = result.get("diagnostics") or {}
    impersonate = diagnostics.get("transportImpersonate") or "firefox135"
    response = requests.get(
        str(result["url"]),
        headers=result.get("headers") or {},
        impersonate=impersonate,
        timeout=20,
        allow_redirects=True,
    )
    return {
        "status": response.status_code,
        "headers": dict(response.headers),
        "text": response.text,
    }


def main(argv: list[str] | None = None) -> int:
    page = parse_page(argv if argv is not None else sys.argv[1:])
    generated = generate_request(page)
    response = request_generated(generated)
    output = {
        "page": int(page) if page.isdigit() else page,
        "request_url": generated["url"],
        "status": response["status"],
        "headers": response["headers"],
        "text": response["text"],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
