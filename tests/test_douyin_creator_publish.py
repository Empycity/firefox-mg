import datetime as dt
import base64
import importlib.util
import json
import re
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "examples/douyin/creator_publish.py"
SPEC = importlib.util.spec_from_file_location("creator_publish", MODULE_PATH)
creator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = creator
SPEC.loader.exec_module(creator)


def test_creation_id_contract():
    value = creator.generate_creation_id(1786363049333)
    assert re.fullmatch(r"[a-z0-9]{8}1786363049333", value)


def test_crc32_is_fixed_width_lowercase():
    assert creator.crc32_hex(b"123456789") == "cbf43926"


def test_canonical_query_sorts_and_preserves_empty_values():
    url = "https://example.test/?z=two words&a=&a=~"
    assert creator.canonical_query(url) == "a=&a=~&z=two%20words"


def test_remove_query_parameter_removes_all_duplicate_values():
    url = "https://example.test/path?x=1&a_bogus=one&a_bogus=two&y=2"
    assert creator.remove_query_parameter(url, "a_bogus") == "https://example.test/path?x=1&y=2"


def test_imagex_signature_matches_fixed_vector():
    credential = creator.UploadCredential("AKID", "SECRET", "SESSION")
    now = dt.datetime(2026, 8, 10, 13, 13, 36, tzinfo=dt.timezone.utc)
    url = "https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&user_id="
    headers = creator.sign_imagex_request("GET", url, credential, now=now)
    assert headers["X-Amz-Date"] == "20260810T131336Z"
    assert "SignedHeaders=x-amz-date;x-amz-security-token" in headers["Authorization"]
    assert headers["Authorization"].endswith(
        "Signature=a161563b65754d28532816894d824981f82ff5a7998fabcdad57a896f5f3f1e4"
    )


def test_vod_signature_uses_vod_scope_and_payload_hash():
    credential = creator.UploadCredential("AKID", "SECRET", "SESSION", "USER")
    now = dt.datetime(2026, 8, 10, 15, 14, 58, tzinfo=dt.timezone.utc)
    url = "https://vod.bytedanceapi.com/?Action=CommitUploadInner&Version=2020-11-19"
    payload = b'{"SessionKey":"VALUE","Functions":[]}'
    headers = creator.sign_aws_v4_request("POST", url, credential, payload, now, service="vod")
    assert "/20260810/cn-north-1/vod/aws4_request" in headers["Authorization"]
    assert headers["X-Amz-Content-Sha256"] == creator.hashlib.sha256(payload).hexdigest()
    assert headers["Authorization"].endswith(
        "Signature=10e641a9bedb3a13336ed0a6f4a88501beb7b93462b63d880e9615d829c3a950"
    )


def test_extract_user_id_from_sts_policy():
    condition = json.dumps({"AppId": "1128", "SessionCheck": "Uid", "UserId": "354491242659447"})
    policy = {"Statement": [{"Condition": condition}]}
    outer = {"PolicyString": json.dumps(policy)}
    token = "STS2" + base64.b64encode(json.dumps(outer).encode()).decode()
    assert creator.extract_user_id(token) == "354491242659447"


def test_create_body_updates_only_dynamic_material_fields():
    contract = {
        "request": {
            "unsigned_url": "https://creator.douyin.com/web/api/media/aweme/create_v2/?aid=1128",
            "headers": {},
            "body": {
                "item": {
                    "common": {"text": "old", "images": [], "creation_id": "old"},
                    "cover": {"poster": "old"},
                }
            },
        }
    }
    instance = object.__new__(creator.CreatorPublisher)
    instance.contract = contract
    image = creator.UploadedImage("STORE", "UPLOAD", 1920, 1080, 3, "md5", "crc")
    options = creator.PublishOptions("caption", visibility_type=1, download=0, timing=-1)
    body = instance.build_create_body([image], "CREATE", options)
    assert body["item"]["common"]["images"] == [{"uri": "STORE", "width": 1920, "height": 1080}]
    assert body["item"]["common"]["creation_id"] == "CREATE"
    assert body["item"]["cover"]["poster"] == "STORE"
    assert body["item"]["common"]["download"] == 0
    assert contract["request"]["body"]["item"]["common"]["text"] == "old"


def test_create_body_supports_multiple_images_and_first_cover():
    contract = {
        "request": {
            "body": {
                "item": {
                    "common": {"images": []},
                    "cover": {},
                }
            }
        }
    }
    instance = object.__new__(creator.CreatorPublisher)
    instance.contract = contract
    first = creator.UploadedImage("FIRST", "1", 100, 200, 1, "m", "c")
    second = creator.UploadedImage("SECOND", "2", 300, 400, 1, "m", "c")
    body = instance.build_create_body([first, second], "CREATE", creator.PublishOptions())
    assert [item["uri"] for item in body["item"]["common"]["images"]] == ["FIRST", "SECOND"]
    assert body["item"]["cover"]["poster"] == "FIRST"


def test_video_create_body_replaces_image_material_fields():
    contract = {
        "request": {
            "body": {
                "item": {
                    "common": {"media_type": 2, "images": [{"uri": "OLD"}], "text": "old"},
                    "cover": {"poster": "OLD"},
                }
            }
        }
    }
    instance = object.__new__(creator.CreatorPublisher)
    instance.contract = contract
    video = creator.UploadedVideo("VID", "STORE", "UPLOAD", 1080, 1920, 5.2, 10, "mp4", "h264", "crc")
    body = instance.build_video_create_body(video, "POSTER", "CREATE", creator.PublishOptions("caption"))
    common = body["item"]["common"]
    assert common["video_id"] == "VID"
    assert common["media_type"] == 4
    assert common["creation_id"] == "CREATE"
    assert "images" not in common
    assert body["item"]["cover"] == {"poster": "POSTER", "poster_delay": 0}
    assert contract["request"]["body"]["item"]["common"]["media_type"] == 2


def test_parser_accepts_existing_video_id():
    args = creator.build_parser().parse_args(["--video-id", "VID", "--poster-uri", "POSTER"])
    assert args.video_id == "VID"
    assert not args.images


def test_parse_cookie_header_preserves_equals_in_values():
    cookies = creator.parse_cookie_header("first=one; signed=abc==; empty=; msToken=TOKEN==")
    assert [(item.name, item.value) for item in cookies] == [
        ("first", "one"), ("signed", "abc=="), ("empty", ""), ("msToken", "TOKEN=="),
    ]
    assert cookies[-1].host == ".bytedance.com"


def test_persist_cookie_file_keeps_latest_value(tmp_path):
    client = creator.HttpClient([], 0, creator.Log(False))
    client.session.cookies.set("sid", "OLD", domain=".douyin.com", path="/")
    client.session.cookies.set("sid", "NEW", domain="creator.douyin.com", path="/")
    client.session.cookies.set("msToken", "TOKEN", domain=".bytedance.com", path="/")
    path = tmp_path / "cookie.txt"
    creator.persist_cookie_file(path, client)
    text = path.read_text()
    assert "sid=NEW" in text
    assert "msToken=TOKEN" in text


def test_http_client_exports_session_cookies_with_domain_and_path():
    client = creator.HttpClient(
        [creator.BrowserCookie(".douyin.com", "sessionid", "OLD")], 0, creator.Log(False),
    )
    client.session.cookies.set("msToken", "CURRENT", domain=".bytedance.com", path="/", secure=True)
    exported = {(item.host, item.name, item.value) for item in client.browser_cookies()}
    assert (".douyin.com", "sessionid", "OLD") in exported
    assert (".bytedance.com", "msToken", "CURRENT") in exported


def test_rotated_ms_token_updates_shared_session():
    client = creator.HttpClient(
        [creator.BrowserCookie(".bytedance.com", "msToken", "OLD")], 0, creator.Log(False),
    )
    client.update_ms_token("ROTATED")
    exported = {(item.host, item.name, item.value) for item in client.browser_cookies()}
    assert (".bytedance.com", "msToken", "ROTATED") in exported
    assert (".bytedance.com", "msToken", "OLD") not in exported


def test_signed_url_reads_rotated_ms_token():
    class RecordingSigner:
        def __init__(self):
            self.cookies = []
            self.seen_url = ""

        def sign(self, unsigned_url, method="GET", body=None):
            self.seen_url = unsigned_url
            return "SIGNATURE"

    client = creator.HttpClient(
        [creator.BrowserCookie(".bytedance.com", "msToken", "OLD")], 0, creator.Log(False),
    )
    signer = RecordingSigner()
    publisher = object.__new__(creator.CreatorPublisher)
    publisher.client = client
    publisher.signer = signer
    publisher.browser_params = {"aid": "1128"}
    client.update_ms_token("ROTATED")
    signed = publisher.signed_creator_url("/web/api/media/aweme/create_v2/")
    assert "msToken=ROTATED" in signed
    assert "msToken=ROTATED" in signer.seen_url


def test_http_client_accepts_explicit_transport_profile():
    client = creator.HttpClient([], 0, creator.Log(False), "chrome136")
    assert client.impersonate == "chrome136"


def test_cookie_fingerprints_detect_value_change_without_exposing_value():
    before = creator.HttpClient.cookie_fingerprints([creator.BrowserCookie(".douyin.com", "sid", "ONE")])
    after = creator.HttpClient.cookie_fingerprints([creator.BrowserCookie(".douyin.com", "sid", "TWO")])
    assert before.keys() == after.keys()
    assert before != after


def test_parser_accepts_shared_session_video_batch():
    args = creator.build_parser().parse_args(["--video-batch", "one.mp4", "two.mp4"])
    assert [item.name for item in args.video_batch] == ["one.mp4", "two.mp4"]


def test_local_security_runtime_hmac_header(tmp_path):
    seed = {
        "schema": "douyin.local_security_runtime.v1", "ecdh_key": list(range(32)),
        "ticket": "TICKET", "ts_sign": "ts.2.TEST", "ree_public_key": "PUB", "csrf": "CSRF",
    }
    path = tmp_path / "runtime.json"; path.write_text(json.dumps(seed))
    runtime = creator.LocalSecurityRuntime(path)
    headers = runtime.headers()
    decoded = json.loads(base64.b64decode(headers["bd-ticket-guard-client-data"]))
    assert decoded["req_content"] == "ticket,path,timestamp"
    assert len(base64.b64decode(decoded["req_sign"])) == 32
    assert headers["x-secsdk-csrf-token"] == "CSRF"
