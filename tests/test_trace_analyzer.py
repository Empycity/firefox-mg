import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "trace_analyzer", ROOT / "tools" / "trace_analyzer.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TraceAnalyzerTests(unittest.TestCase):
    def test_request_value_sha_resolves_deepest_return_chain(self):
        value = "dynamic-query-value-abcdefghijklmnopqrstuvwxyz"
        digest = MODULE.hashlib.sha256(value.encode()).hexdigest()
        base = {
            "pid": 7,
            "segment_id": "seg_001",
            "script_url": "https://fixture.test/sdk.js",
            "script_sha256": "a" * 64,
            "function_name": "v",
        }
        rows = [
            dict(base, type="js.call.enter", ts_us=100, call_id="outer", parent_call_id=None, column=80),
            dict(base, type="js.call.enter", ts_us=110, call_id="inner", parent_call_id="outer", column=20),
            dict(
                base,
                type="js.call.return",
                ts_us=120,
                call_id="inner",
                parent_call_id="outer",
                column=20,
                data={"return": {"type": "string", "preview": value, "sha256": digest}},
            ),
            dict(
                base,
                type="js.call.return",
                ts_us=130,
                call_id="outer",
                parent_call_id=None,
                column=80,
                data={"return": {"type": "string", "preview": value, "sha256": digest}},
            ),
        ]
        request = {
            "type": "fetch.call",
            "ts_us": 200,
            "pid": 7,
            "segment_id": "seg_001",
            "request_id": "fetch_1",
        }
        finding = MODULE.Finding("high_entropy", "X-Field", value, request)

        match, chain = MODULE.value_producer_chain(MODULE.build_index(rows), finding)

        self.assertEqual(match["call_id"], "inner")
        self.assertEqual(match["value_role"], "return")
        self.assertEqual([row["call_id"] for row in chain], ["inner", "outer"])

    def test_value_producer_rejects_future_and_other_process_events(self):
        value = "dynamic-query-value-abcdefghijklmnopqrstuvwxyz"
        digest = MODULE.hashlib.sha256(value.encode()).hexdigest()
        rows = [
            {
                "type": "js.call.enter",
                "ts_us": 90,
                "pid": 8,
                "segment_id": "seg_001",
                "call_id": "other",
            },
            {
                "type": "js.call.return",
                "ts_us": 110,
                "pid": 8,
                "segment_id": "seg_001",
                "call_id": "other",
                "data": {"return": {"sha256": digest}},
            },
        ]
        finding = MODULE.Finding(
            "high_entropy",
            "X-Field",
            value,
            {"type": "fetch.call", "ts_us": 100, "pid": 7, "segment_id": "seg_001"},
        )

        match, chain = MODULE.value_producer_chain(MODULE.build_index(rows), finding)

        self.assertIsNone(match)
        self.assertEqual(chain, [])


if __name__ == "__main__":
    unittest.main()
