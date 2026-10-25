import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "tools" / "trace-stop-on-target.py"
SPEC = importlib.util.spec_from_file_location("trace_stop_on_target", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class TraceStopOnTargetTests(unittest.TestCase):
    def test_document_cookie_target_uses_page_url_without_widening_network_filter(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            targets = {key: set() for key in MODULE.FIELD_KEYS}
            targets["cookie_fields"] = {"trace_done"}
            event = {"type": "cookie.set", "key": "trace_done", "value_preview": "ok",
                     "page_url": "https://fixture.test/target/"}
            match = MODULE.find_target(pathlib.Path(raw_dir), event, targets,
                                       "cookie.jsonl", "/target/")
            self.assertIsNotNone(match)
            self.assertEqual(match["url"], event["page_url"])
            structured = dict(event, cookie_fields={"trace_done": "ok"})
            match = MODULE.find_target(pathlib.Path(raw_dir), structured, targets,
                                       "cookie.jsonl", "/target/")
            self.assertEqual(match["url"], event["page_url"])
            self.assertIsNone(MODULE.find_target(pathlib.Path(raw_dir), event, targets,
                                               "cookie.jsonl", "/other/"))
            explicit = dict(event, host_url="https://fixture.test/other/")
            self.assertFalse(MODULE.url_matches(explicit, "/target/"))
            network = {"type": "fetch.request", "url": "https://fixture.test/other/",
                       "page_url": "https://fixture.test/target/"}
            self.assertFalse(MODULE.url_matches(network, "/target/"))

    def run_watchdog(self, trace_dir, *extra, ack=True):
        control = trace_dir / "fake-control.py"
        finalizer = trace_dir / "fake-finalize.py"
        control.write_text("#!/usr/bin/env python3\nimport pathlib,sys,json\nroot=pathlib.Path(sys.argv[1]);p=root/'calls.log'\np.write_text((p.read_text() if p.exists() else '')+'stop '+sys.argv[3]+'\\n')\ncpath=root/'trace-control.json'\nc=json.loads(cpath.read_text()) if cpath.exists() else {}\nc.update(version=int(c.get('version',0))+1, config_hash='fixture-stop')\ncpath.write_text(json.dumps(c))\n" + ("(root/'firefox-control-acks.jsonl').write_text(json.dumps(dict(type='trace.config.applied',control_version=c['version'],config_hash=c['config_hash'],pid=123,child_id=1))+'\\n')\n" if ack else ""), encoding="utf-8")
        control.chmod(0o755)
        finalizer.write_text(
            "import pathlib,sys\n"
            "p=pathlib.Path(sys.argv[1])/'calls.log'\n"
            "p.write_text((p.read_text() if p.exists() else '')+'finalize\\n')\n",
            encoding="utf-8",
        )
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                str(trace_dir),
                "--control-script",
                str(control),
                "--finalize-script",
                str(finalizer),
                "--python",
                sys.executable,
                "--ack-seconds",
                "0",
                "--poll-ms",
                "10",
                *extra,
            ],
            text=True,
            capture_output=True,
            timeout=5,
        )

    def test_configured_fields_obey_location_and_disabled_values(self):
        fields = MODULE.configured_fields(
            {"env": {"TRACE_QUERY_FIELDS": "Token, nonce", "TRACE_BODY_FIELDS": "__disabled__"}}
        )
        self.assertEqual(fields["query_fields"], {"token", "nonce"})
        self.assertEqual(fields["body_fields"], set())

    def test_ack_from_other_child_does_not_cover_missing_target_process(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            directory = pathlib.Path(raw_dir)
            path = directory / "firefox-control-acks.jsonl"
            def event(kind, child):
                return dict(type=kind, child_id=child, pid=100 + child,
                            control_version=2, config_hash="new", detail="sent")
            rows = [event("trace.config.push", 1), event("trace.config.push", 2),
                    event("trace.config.applied", 1)]
            path.write_text("\n".join(map(json.dumps, rows)) + "\n")
            control = {"version": 2, "config_hash": "new"}
            self.assertFalse(MODULE.wait_for_ack(directory, control, 0))
            with path.open("a") as stream:
                stream.write(json.dumps(event("trace.config.applied", 2)) + "\n")
            self.assertTrue(MODULE.wait_for_ack(directory, control, 0))

    def test_missing_ack_still_finalizes_but_is_not_success(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            directory = pathlib.Path(raw_dir)
            (directory / "manifest.json").write_text(json.dumps({"env": {"TRACE_COOKIE_FIELDS": "done"}}))
            (directory / "firefox-cookie-1.jsonl").write_text(json.dumps({
                "type": "cookie.set", "key": "done", "value_preview": "ok"}) + "\n")
            result = self.run_watchdog(directory, ack=False)
            self.assertEqual(result.returncode, 6, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertFalse(receipt["stop_acknowledged"])
            self.assertTrue(receipt["finalized"])
            self.assertEqual((directory / "calls.log").read_text(), "stop target-found\nfinalize\n")

    def test_tail_preserves_partial_line_and_finds_target(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            path = trace_dir / "firefox-fetch-123.jsonl"
            first = json.dumps({"type": "fetch.request", "query_fields": {"other": "x"}})
            target = json.dumps(
                {
                    "type": "fetch.request",
                    "request_id": "r1",
                    "query_fields": {"Token": "abc"},
                }
            )
            split = len(target) // 2
            path.write_text(first + "\n" + target[:split], encoding="utf-8")
            tail = MODULE.JsonlTail()
            self.assertEqual(len(list(tail.events(trace_dir))), 1)
            with path.open("a", encoding="utf-8") as stream:
                stream.write(target[split:] + "\n")
            events = list(tail.events(trace_dir))
            self.assertEqual(len(events), 1)
            match = MODULE.find_target(
                trace_dir,
                events[0][1],
                {"query_fields": {"token"}, "body_fields": set(), "header_fields": set(), "cookie_fields": set()},
                events[0][0],
            )
            self.assertEqual(match["request_id"], "r1")

    def test_target_waits_for_referenced_artifact(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            event = {
                "query_fields": {"token": "preview"},
                "query_fields_meta": {"token": {"value_store_path": "values/token.txt"}},
            }
            targets = {"query_fields": {"token"}, "body_fields": set(), "header_fields": set(), "cookie_fields": set()}
            self.assertIsNone(MODULE.find_target(trace_dir, event, targets, "fetch.jsonl"))
            (trace_dir / "values").mkdir()
            (trace_dir / "values/token.txt").write_text("complete", encoding="utf-8")
            self.assertIsNotNone(MODULE.find_target(trace_dir, event, targets, "fetch.jsonl"))

    def test_target_url_filter_ignores_other_endpoints(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            targets = {
                "query_fields": {"target_field"},
                "body_fields": set(),
                "header_fields": set(),
                "cookie_fields": set(),
            }
            other = {
                "url": "https://fixture.test/api/other/?TARGET_FIELD=a",
                "query_fields": {"TARGET_FIELD": "a"},
            }
            target = {
                "url": "https://fixture.test/api/target/?TARGET_FIELD=b",
                "request_id": "target-1",
                "query_fields": {"TARGET_FIELD": "b"},
            }
            self.assertIsNone(
                MODULE.find_target(
                    trace_dir,
                    other,
                    targets,
                    "fetch.jsonl",
                    "/api/target/",
                )
            )
            match = MODULE.find_target(
                trace_dir,
                target,
                targets,
                "fetch.jsonl",
                "/api/target/",
            )
            self.assertEqual(match["request_id"], "target-1")

    def test_cookie_http_set_matches_top_level_key_and_host_url(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            targets = {key: set() for key in MODULE.FIELD_KEYS}
            targets["cookie_fields"] = {"cf_clearance"}
            event = {
                "type": "cookie.http_set",
                "channel_id": "channel-1",
                "host_url": "https://fixture.test/challenge/final",
                "channel_url": "https://fixture.test/challenge/start",
                "key": "CF_Clearance",
                "value_preview": "durable-cookie-value",
            }

            match = MODULE.find_target(
                trace_dir,
                event,
                targets,
                "firefox-cookie-1.jsonl",
                "/challenge/final",
            )

            self.assertIsNotNone(match)
            self.assertEqual(match["field"], "CF_Clearance")
            self.assertEqual(match["field_location"], "cookie")
            self.assertEqual(match["request_id"], "channel-1")
            self.assertEqual(match["url"], event["host_url"])
            self.assertTrue(MODULE.may_contain_target(event, targets))

    def test_cookie_http_set_requires_nonempty_durable_value(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            targets = {key: set() for key in MODULE.FIELD_KEYS}
            targets["cookie_fields"] = {"session"}
            event = {
                "type": "cookie.http_set",
                "final_url": "https://fixture.test/final",
                "key": "session",
                "value_preview": "",
            }

            self.assertIsNone(MODULE.find_target(trace_dir, event, targets, "cookie.jsonl"))
            self.assertFalse(MODULE.may_contain_target(event, targets))

    def test_process_cookie_target_hit_stops_then_finalizes(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            (trace_dir / "manifest.json").write_text(
                json.dumps({"env": {"TRACE_COOKIE_FIELDS": "session"}}), encoding="utf-8"
            )
            (trace_dir / "firefox-cookie-1.jsonl").write_text(
                json.dumps(
                    {
                        "type": "cookie.http_set",
                        "host_url": "https://fixture.test/final",
                        "key": "session",
                        "value_preview": "abc",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            result = self.run_watchdog(trace_dir, "--url-contains", "/final")
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["reason"], "target-found")
            self.assertEqual(receipt["field_location"], "cookie")

    def test_initial_segment_accepts_untagged_cookie_event(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            (trace_dir / "trace-control.json").write_text(
                json.dumps({"segment_id": "seg_001", "env": {"TRACE_COOKIE_FIELDS": "cf_clearance"}}),
                encoding="utf-8",
            )
            (trace_dir / "firefox-cookie-1.jsonl").write_text(
                json.dumps(
                    {
                        "type": "cookie.http_set",
                        "segment_id": None,
                        "host_url": "https://fixture.test/final",
                        "key": "cf_clearance",
                        "value_preview": "dynamic-cookie",
                    }
                ) + "\n",
                encoding="utf-8",
            )
            result = self.run_watchdog(trace_dir)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["reason"], "target-found")

    def test_resumed_segment_rejects_untagged_old_event(self):
        self.assertFalse(MODULE.segment_matches({"segment_id": None}, "seg_002"))
        self.assertTrue(MODULE.segment_matches({"segment_id": "seg_002"}, "seg_002"))

    def test_unconfigured_event_is_retained_until_manifest_fields_arrive(self):
        event = {"body_fields": {"p": "value"}}
        empty = {key: set() for key in MODULE.FIELD_KEYS}
        self.assertTrue(MODULE.may_contain_target(event, empty))
        configured = {key: set() for key in MODULE.FIELD_KEYS}
        configured["body_fields"] = {"p"}
        self.assertTrue(MODULE.may_contain_target(event, configured))

    def test_ack_matches_new_control_version_and_hash(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            (trace_dir / "firefox-control-acks.jsonl").write_text(
                json.dumps(
                    {
                        "type": "trace.config.applied",
                        "control_version": 7,
                        "config_hash": "abc",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertTrue(MODULE.wait_for_ack(trace_dir, {"version": 7, "config_hash": "abc"}, 0))
            self.assertFalse(MODULE.wait_for_ack(trace_dir, {"version": 8, "config_hash": "abc"}, 0))

    def test_process_target_hit_stops_then_finalizes(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            (trace_dir / "manifest.json").write_text(
                json.dumps({"env": {"TRACE_QUERY_FIELDS": "token"}}), encoding="utf-8"
            )
            (trace_dir / "firefox-fetch-1.jsonl").write_text(
                json.dumps({"type": "fetch.request", "request_id": "r1", "query_fields": {"token": "abc"}})
                + "\n",
                encoding="utf-8",
            )
            result = self.run_watchdog(trace_dir)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["reason"], "target-found")
            self.assertTrue(receipt["stop_sent"])
            self.assertTrue(receipt["finalized"])
            self.assertEqual((trace_dir / "calls.log").read_text().splitlines(), ["stop target-found", "finalize"])

    def test_runtime_control_fields_and_segment_override_manifest(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            (trace_dir / "manifest.json").write_text(
                json.dumps({"env": {"TRACE_QUERY_FIELDS": "old_token"}}), encoding="utf-8"
            )
            (trace_dir / "trace-control.json").write_text(
                json.dumps({"segment_id": "seg_002", "env": {"TRACE_QUERY_FIELDS": "new_token"}}),
                encoding="utf-8",
            )
            events = [
                {"segment_id": "seg_001", "query_fields": {"old_token": "old"}},
                {"segment_id": "seg_002", "request_id": "r2", "query_fields": {"new_token": "new"}},
            ]
            (trace_dir / "firefox-fetch-1.jsonl").write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )
            result = self.run_watchdog(trace_dir)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["request_id"], "r2")

    def test_process_time_and_size_limits_stop_and_finalize(self):
        for args, expected_code, expected_reason in (
            (("--max-seconds", "0.03", "--max-bytes", "0"), 3, "time-limit"),
            (("--max-seconds", "0", "--max-bytes", "1"), 4, "size-limit"),
        ):
            with self.subTest(reason=expected_reason), tempfile.TemporaryDirectory() as raw_dir:
                trace_dir = pathlib.Path(raw_dir)
                (trace_dir / "manifest.json").write_text(json.dumps({"env": {}}), encoding="utf-8")
                result = self.run_watchdog(trace_dir, *args)
                self.assertEqual(result.returncode, expected_code, result.stderr)
                self.assertEqual(json.loads(result.stdout)["reason"], expected_reason)
                self.assertEqual((trace_dir / "calls.log").read_text().splitlines(), [f"stop {expected_reason}", "finalize"])


if __name__ == "__main__":
    unittest.main()
