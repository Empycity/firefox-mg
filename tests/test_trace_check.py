import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "trace_check", ROOT / "tools" / "trace_check.py"
)
trace_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trace_check)


def write_jsonl(path, events):
    path.write_text(
        "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
        encoding="utf-8",
    )


class TraceCheckTests(unittest.TestCase):
    def test_runtime_matches_current_control_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            control = {"version": 3, "config_hash": "control-hash"}
            (trace_dir / "trace-control.json").write_text(json.dumps(control))
            write_jsonl(
                trace_dir / "firefox-control-acks-123.jsonl",
                [
                    {"type": "trace.config.applied", "control_version": 2},
                    {
                        "type": "trace.config.applied",
                        "control_version": 3,
                        "config_hash": "control-hash",
                    },
                ],
            )
            trace_check.check_runtime(trace_dir)

    def test_boundary_requires_window_summary_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            write_jsonl(
                trace_dir / "firefox-js-123.jsonl",
                [
                    {
                        "type": "js.boundary.flush_summary",
                        "complete_window": False,
                        "skipped_by_window": 4,
                        "dropped_before_flush": 2,
                        "window_capacity": 8,
                        "window_capacity_source": "TRACE_JS_BOUNDARY_BUFFER_EVENTS",
                    }
                ],
            )
            trace_check.check_boundary(trace_dir)

    def test_source_map_artifact_matches_event_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            payload = b"window.sourceMapFixture = true;\n"
            artifact = trace_dir / "scripts" / "fixture.js"
            artifact.parent.mkdir()
            artifact.write_bytes(payload)
            write_jsonl(
                trace_dir / "firefox-script-123.jsonl",
                [
                    {
                        "type": "script.resource",
                        "source_map_resolved_url": "http://fixture/source.js.map",
                        "artifact_path": "scripts/fixture.js",
                        "raw_size": len(payload),
                        "raw_sha256": hashlib.sha256(payload).hexdigest(),
                    }
                ],
            )
            trace_check.check_source_map(trace_dir)

    def test_worker_requires_explicit_suppression_notice(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            write_jsonl(
                trace_dir / "firefox-js-123.jsonl",
                [
                    {
                        "type": "trace.suppressed",
                        "reason": "worker_thread_ipc_unsupported",
                        "scope": "worker",
                    }
                ],
            )
            trace_check.check_worker(trace_dir)

    def test_websocket_requires_send_recv_and_frame_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            base = {
                "schema": "firefox_trace.websocket.v1",
                "type": "websocket.frame",
                "socket_id": 7,
                "url": "ws://fixture.invalid/echo",
                "binary": False,
                "size": 5,
                "preview_available": True,
                "preview_truncated": False,
            }
            write_jsonl(
                trace_dir / "firefox-websocket-123.jsonl",
                [dict(base, direction="send", preview="hello"),
                 dict(base, direction="recv", preview="hello")],
            )
            trace_check.check_websocket(trace_dir)

    def test_fetch_body_artifact_matches_response_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            payload = b'{"token":"traceFetchBodyToken"}\n'
            artifact = trace_dir / "values" / "fetch_body_fixture.txt"
            artifact.parent.mkdir()
            artifact.write_bytes(payload)
            write_jsonl(
                trace_dir / "firefox-fetch-123.jsonl",
                [{
                    "type": "fetch.response",
                    "body_value_stored": True,
                    "body_value_truncated": False,
                    "body_value_store_path": "values/fetch_body_fixture.txt",
                    "body_sha256": hashlib.sha256(payload).hexdigest(),
                }],
            )
            trace_check.check_fetch_body(trace_dir)

    def test_http_raw_chunk_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_dir = Path(directory)
            write_jsonl(trace_dir / "firefox-http-raw-123.jsonl", [{
                "schema": "firefox_trace.http.v1", "type": "http.raw_chunk",
                "channel_id": 17, "offset": 0, "source_count": 4,
                "captured_size": 4, "url": "http://fixture/raw",
                "payload_hex": "74657374", "payload_hex_truncated": False,
                "capture_truncated": False,
            }])
            trace_check.check_http_raw(trace_dir)


if __name__ == "__main__":
    unittest.main()
