#!/usr/bin/env python3
import argparse
import json
import os
import secrets
import shutil
import string
import subprocess
import sys
import time
from pathlib import Path

from curl_cffi import requests


BASE_DIR = Path(__file__).resolve().parent
CONFIG_URL = (
    "https://app-api.shop.ele.me/xtop/"
    "xtop.napos.keeper.melody.login.getLoginConfig/1.0"
)
LOGIN_URL = (
    "https://app-api.shop.ele.me/xtop/"
    "xtop.napos.keeper.login.loginByUsername/2.0"
)
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) "
    "Gecko/20100101 Firefox/142.0"
)
IMPERSONATE = os.environ.get("SHANGOU_IMPERSONATE", "firefox133")


def find_node():
    candidates = [
        os.environ.get("NODE_BINARY"),
        shutil.which("node"),
        str(Path.home() / ".nvm/versions/node/v22.14.0/bin/node"),
    ]
    errors = []
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            version = subprocess.check_output(
                [candidate, "--version"], text=True, timeout=10
            ).strip()
        except (OSError, subprocess.SubprocessError) as exc:
            errors.append("{}: {}".format(candidate, exc))
            continue
        if version == "v22.14.0":
            return candidate, version
        errors.append("{}: expected v22.14.0, got {}".format(candidate, version))
    raise RuntimeError("Node 22.14.0 was not found ({})".format("; ".join(errors)))


def run_node_json(node, script, payload=None, timeout=90):
    command = [node, str(BASE_DIR / script)]
    if payload is not None:
        command.append(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    completed = subprocess.run(
        command,
        cwd=str(BASE_DIR),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return json.loads(completed.stdout)


def request_id():
    return "{}|{}".format(secrets.token_hex(16).upper(), int(time.time() * 1000))


def make_headers(security_fields, config_phase=False):
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.5",
        "content-type": "application/json;charset=utf-8",
        "origin": "https://melody.shop.ele.me",
        "referer": "https://melody.shop.ele.me/login",
        "user-agent": USER_AGENT,
        "x-eleme-requestid": request_id(),
        "x-shard": "shopid=",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "bx-umidtoken": (
            "no-load bx-umidtoken"
            if config_phase
            else security_fields["bxUmidToken"]
        ),
        "bx-ua": (
            security_fields["configBxUa"]
            if config_phase
            else security_fields["bxUa"]
        ),
    }


HTTP_SESSION = requests.Session(impersonate=IMPERSONATE)


def post_json(url, headers, payload=None):
    response = HTTP_SESSION.post(
        url,
        headers=headers,
        data=None if payload is None else json.dumps(payload, separators=(",", ":")),
        timeout=30,
    )
    try:
        body = response.json()
    except ValueError:
        body = {"raw": response.text}
    return response, body


def random_credentials():
    username = "199" + "".join(secrets.choice(string.digits) for _ in range(8))
    alphabet = string.ascii_letters + string.digits
    password = "T_" + "".join(secrets.choice(alphabet) for _ in range(10))
    return username, password


def parse_args():
    argv = []
    for value in sys.argv[1:]:
        if value.startswith("user="):
            value = "-user=" + value[5:]
        elif value.startswith("pwd="):
            value = "-pwd=" + value[4:]
        argv.append(value)
    parser = argparse.ArgumentParser(description="Run the Shangou login replay")
    parser.add_argument("-user", "--user", dest="username", help="login username")
    parser.add_argument("-pwd", "--pwd", dest="password", help="login password")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    node, node_version = find_node()
    username = args.username or os.environ.get("SHANGOU_USERNAME")
    password = args.password or os.environ.get("SHANGOU_PASSWORD")
    if not username or not password:
        username, password = random_credentials()

    print(
        "[1/4] Node: {} ({}) transport=curl_cffi/{}".format(
            node, node_version, IMPERSONATE
        )
    )
    fields = run_node_json(node, "login_security_fields_cli.js")
    print(
        "[2/4] security lengths: AsuraId={} fire_ua={} fire_umid={} "
        "bx-umidtoken={} config-bx-ua={} bx-ua={}".format(
            len(fields["asuraId"]),
            len(fields["fireUa"]),
            len(fields["fireUmid"]),
            len(fields["bxUmidToken"]),
            len(fields["configBxUa"]),
            len(fields["bxUa"]),
        )
    )

    config_headers = make_headers(fields, config_phase=True)
    config_response, config_body = post_json(CONFIG_URL, config_headers)
    public_key = (config_body.get("result") or {}).get("publicKey")
    if config_response.status_code != 200 or not public_key:
        raise RuntimeError(
            "getLoginConfig failed: HTTP {} {}".format(
                config_response.status_code,
                json.dumps(config_body, ensure_ascii=False),
            )
        )
    print("[3/4] login public key: {} bytes".format(len(public_key)))

    encrypted = run_node_json(
        node,
        "login_crypto_cli.js",
        {"publicKey": public_key, "username": username, "password": password},
    )
    payload = {
        "metas": {
            "shopId": None,
            "ksid": None,
            "AsuraId": fields["asuraId"],
            "fire_ua": fields["fireUa"],
            "fire_umid": fields["fireUmid"],
            "appName": "melody",
        },
        "params": {
            "username": encrypted["username"],
            "password": encrypted["password"],
            "loginedSessionIds": [],
            "extraInfo": encrypted["extraInfo"],
        },
    }
    login_headers = make_headers(fields)
    login_response, login_body = post_json(LOGIN_URL, login_headers, payload)
    print("[4/4] test username={} password={}".format(username, password))
    print("HTTP {}".format(login_response.status_code))
    print(json.dumps(login_body, ensure_ascii=False, indent=2))

    if login_response.status_code != 200 or login_body.get("code") != 200:
        return 1
    if not isinstance(login_body.get("result"), dict):
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        sys.exit(1)
