#!/usr/bin/env python3
"""Generate one fresh Reese84 token per requested search page."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import random
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from curl_cffi import requests
from curl_cffi.requests.exceptions import RequestException
from loguru import logger


ROOT = Path(__file__).resolve().parent
NODE_RUNNER = ROOT / "reese84-runtime.js"
STATS_PATH = ROOT / ".run-stats.json"
ORIGIN = "https://www.globalsources.com"
SEARCH_URL = f"{ORIGIN}/api/agg-search/DESKTOP/v3/product/search"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0"


def configure_logging() -> None:
    logger.remove()
    logger.add(
        sys.stderr,
        colorize=True,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
            "<level>{level: <8}</level> | <cyan>globalsources</cyan> | "
            "<magenta>{thread.name}</magenta> | <level>{message}</level>"
        ),
    )


def positive_value(value: str) -> int:
    raw = value.partition("=")[2] if "=" in value else value
    number = int(raw)
    if number < 1:
        raise argparse.ArgumentTypeError("value must be >= 1")
    return number


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("page_arg", nargs="?", type=positive_value)
    parser.add_argument("-p", "--page", type=positive_value)
    parser.add_argument("-w", "--workers", type=positive_value, default=4)
    parser.add_argument("--retries", type=positive_value, default=3)
    args = parser.parse_args()
    args.page = args.page if args.page is not None else (args.page_arg or 1)
    return args


def last_json_object(text: str) -> dict:
    start = text.rfind("\n{")
    return json.loads(text[start + 1 :] if start >= 0 else text)


def generate_request() -> dict:
    env = os.environ.copy()
    env.update(
        REPLAY_TEXT_ENCODER_SHAPE="1",
        REPLAY_FIREFOX_BASE64="1",
        REPLAY_NAVIGATOR_SHAPE="1",
        REPLAY_FRESH_RANDOM="1",
    )
    completed = subprocess.run(
        ["node", str(NODE_RUNNER)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=35,
        check=False,
    )
    if completed.returncode:
        detail = completed.stderr.strip() or completed.stdout[-1000:]
        raise RuntimeError(f"local generator exited {completed.returncode}: {detail}")
    generated = last_json_object(completed.stdout)
    if generated.get("status") != "generated" or not generated.get("request_body"):
        raise RuntimeError(f"local generator status={generated.get('status')!r}")
    return generated


def update_stats(success: bool, pages_requested: int, pages_succeeded: int) -> dict:
    with STATS_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0)
        try:
            stats = json.load(handle)
        except (OSError, json.JSONDecodeError):
            stats = {}
        attempts = int(stats.get("run_attempts", 0)) + 1
        successes = int(stats.get("run_successes", 0)) + int(success)
        task_attempts = int(
            stats.get("task_attempts", stats.get("page_attempts", 0))
        ) + pages_requested
        task_successes = int(
            stats.get("task_successes", stats.get("page_successes", 0))
        ) + pages_succeeded
        result = {
            "run_attempts": attempts,
            "run_successes": successes,
            "run_failures": attempts - successes,
            "run_success_rate": successes / attempts,
            "task_attempts": task_attempts,
            "task_successes": task_successes,
            "task_failures": task_attempts - task_successes,
            "task_success_rate_after_retries": task_successes / task_attempts,
            "last_batch_tasks": pages_requested,
            "last_batch_successes": pages_succeeded,
            "last_batch_success_rate_after_retries": pages_succeeded / pages_requested,
            "last_success": success,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        handle.seek(0)
        handle.truncate()
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return result


class RetryableResponseError(RuntimeError):
    pass


def post_json_with_retry(
    url: str,
    *,
    headers: dict,
    body: dict,
    page_number: int,
    phase: str,
    retries: int,
):
    for attempt in range(1, retries + 1):
        try:
            session = requests.Session(impersonate="firefox135")
            response = session.post(url, headers=headers, json=body, timeout=30)
            if response.status_code == 429 or response.status_code >= 500:
                raise RetryableResponseError(f"HTTP {response.status_code}")
            try:
                payload = response.json()
            except ValueError as error:
                raise RetryableResponseError("invalid JSON response") from error
            if phase == "rly" and not payload.get("token"):
                raise RetryableResponseError("rly response has no token")
            return response, payload
        except (RequestException, RetryableResponseError) as error:
            if attempt >= retries:
                raise
            delay = 0.4 * (2 ** (attempt - 1)) + random.uniform(0.1, 0.7)
            logger.warning(
                "page={} | {} retry={}/{} | delay={:.2f}s | {}",
                page_number,
                phase,
                attempt,
                retries,
                delay,
                error,
            )
            time.sleep(delay)
    raise RuntimeError(f"{phase} retry loop exhausted")


def run_page(page_number: int, retries: int) -> bool:
    logger.info("page={} | generating fresh browser interrogation", page_number)
    generated = generate_request()
    body = generated["request_body"]
    p_length = len(body["solution"]["interrogation"]["p"])
    logger.info("page={} | local p length={}", page_number, p_length)

    referer = f"{ORIGIN}/searchList/products?keyWord=shoe&pageNum={page_number}&tsCode=HK"
    headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "origin": ORIGIN,
        "referer": referer,
        "user-agent": UA,
    }
    rly, rly_payload = post_json_with_retry(
        urljoin(ORIGIN, generated["url"]),
        headers=headers,
        body=body,
        page_number=page_number,
        phase="rly",
        retries=retries,
    )
    rly.raise_for_status()
    token = rly_payload["token"]
    logger.success("page={} | token={}", page_number, token)

    # A new session proves no cookies leak from token issuance or a previous
    # page. The explicit Cookie header contains only this page's fresh token.
    expected_cookie = f"reese84={token}"
    search, payload = post_json_with_retry(
        SEARCH_URL,
        headers={**headers, "cookie": expected_cookie},
        body={
            "pageNum": page_number,
            "pageSize": 80,
            "query": "shoe",
            "popupFlag": False,
        },
        page_number=page_number,
        phase="search",
        retries=retries,
    )
    products = payload.get("data", {}).get("list", [])
    sent_headers = getattr(getattr(search, "request", None), "headers", {})
    sent_cookie = sent_headers.get("cookie") or sent_headers.get("Cookie") or ""
    code = str(payload.get("code"))
    page_ok = (
        search.status_code == 200
        and code == "200"
        and payload.get("msg") == "success"
        and isinstance(products, list)
        and bool(products)
        and sent_cookie == expected_cookie
    )
    log = logger.success if page_ok else logger.error
    log("page={} | code={} | list_len={}", page_number, code, len(products))
    return page_ok


def main() -> int:
    configure_logging()
    args = arguments()
    pages_succeeded = 0
    workers = min(args.page, args.workers)
    logger.info(
        "stability run | pages=1..{} | workers={} | fresh token per page",
        args.page,
        workers,
    )
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="reese84") as pool:
        futures = {
            pool.submit(run_page, page_number, args.retries): page_number
            for page_number in range(1, args.page + 1)
        }
        for future in as_completed(futures):
            page_number = futures[future]
            try:
                pages_succeeded += int(future.result())
            except Exception as error:
                logger.error("page={} | run failed | {}", page_number, error)
    accepted = pages_succeeded == args.page
    stats = update_stats(accepted, args.page, pages_succeeded)
    logger.info(
        "run stats attempts={} | successes={} | success_rate={:.2%}",
        stats["run_attempts"],
        stats["run_successes"],
        stats["run_success_rate"],
    )
    logger.info(
        "final task stats after retries | attempts={} | successes={} | failures={} | success_rate={:.2%}",
        stats["task_attempts"],
        stats["task_successes"],
        stats["task_failures"],
        stats["task_success_rate_after_retries"],
    )
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
