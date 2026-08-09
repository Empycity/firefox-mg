import importlib.util
import pathlib
import subprocess
import struct
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("trace_finalize", ROOT / "tools/trace_finalize.py")
trace_finalize = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(trace_finalize)

SERVER_SPEC = importlib.util.spec_from_file_location(
    "trace_console_server", ROOT / "tools/trace-console-server.py"
)
trace_console_server = importlib.util.module_from_spec(SERVER_SPEC)
assert SERVER_SPEC.loader is not None
SERVER_SPEC.loader.exec_module(trace_console_server)


class TraceFinalizeTest(unittest.TestCase):
    def test_jsonl_reader_preserves_unicode_line_separator_in_string(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            path = trace_dir / "firefox-js-1.jsonl"
            rows = [
                {"type": "js.call.enter", "call_id": "call_1", "preview": "a\u0085b"},
                {"type": "js.call.return", "call_id": "call_1"},
            ]
            path.write_text(
                "\n".join(trace_finalize.json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
                encoding="utf-8",
            )

            parsed = list(trace_finalize.jsonl_rows(trace_dir))

            self.assertEqual([item[2]["type"] for item in parsed], ["js.call.enter", "js.call.return"])
            self.assertEqual(parsed[0][2]["preview"], "a\u0085b")

    def test_select_producer_chain_prefers_deepest_exact_return(self):
        shared = {
            "pid": 7,
            "segment_id": "seg_001",
            "function_name": "v",
            "script_url": "https://fixture.test/sdk.js",
            "script_sha256": "a" * 64,
            "line": 1,
        }
        outer = dict(shared, type="js.call.enter", call_id="outer", parent_call_id=None, column=80)
        inner = dict(shared, type="js.call.enter", call_id="inner", parent_call_id="outer", column=20)
        enters = {
            ("7", "seg_001", "outer"): outer,
            ("7", "seg_001", "inner"): inner,
        }
        candidates = [
            dict(
                shared,
                event_type="js.call.return",
                call_id="outer",
                parent_call_id=None,
                column=80,
                ts_us=130,
                value_path="data.return",
                match_type="exact_raw",
                target_sha256="b" * 64,
            ),
            dict(
                shared,
                event_type="js.call.return",
                call_id="inner",
                parent_call_id="outer",
                column=20,
                ts_us=120,
                value_path="data.return",
                match_type="exact_raw",
                target_sha256="b" * 64,
            ),
        ]

        match, chain = trace_finalize.select_producer_chain(
            {"pid": 7, "segment_id": "seg_001", "ts_us": 200},
            candidates,
            enters,
        )

        self.assertEqual(match["call_id"], "inner")
        self.assertEqual([row["call_id"] for row in chain], ["inner", "outer"])

    def test_vm_window_analyzer_rejects_missing_artifact(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/trace_vm_window.py"),
                    raw_dir,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn('"windows": []', result.stdout)

    def test_vm_window_artifact_validation(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            trace_dir = pathlib.Path(raw_dir)
            record = trace_finalize.VM_WINDOW_RECORD.pack(
                7, 100, 3, 12, 0, 0, 5, 2, 1, 1, b"x" + b"\0" * 15, 0, 0, 0
            )
            header = trace_finalize.VM_WINDOW_HEADER.pack(
                b"FTVMW1\0\0", 1, len(record), 7, 7, 7, 0, 16, 1, 101
            )
            (trace_dir / "window.bin").write_bytes(header + record)
            result = trace_finalize.inspect_vm_window_artifact(
                trace_dir, {"artifact_path": "window.bin"}
            )
            self.assertTrue(result["valid"])
            self.assertEqual(result["first_seq"], 7)
            self.assertEqual(result["record_count"], 1)

    def test_promise_ledger_pairs_settlement(self):
        rows = [
            {
                "_category": "bom",
                "type": "dom.call",
                "interface": "Permissions",
                "member": "query",
                "value_kind": "object",
                "value_preview": "Promise",
                "promise_id": "promise_1",
                "origin_call_id": "call_1",
                "ts_us": 1,
            },
            {
                "_category": "bom",
                "type": "dom.promise.observe",
                "interface": "Permissions",
                "member": "query",
                "state": "pending",
                "promise_id": "promise_1",
                "origin_call_id": "call_1",
                "ts_us": 2,
            },
            {
                "_category": "bom",
                "type": "dom.promise.settle",
                "interface": "Permissions",
                "member": "query",
                "state": "fulfilled",
                "promise_id": "promise_1",
                "origin_call_id": "call_1",
                "value": {"kind": "object", "preview": "PermissionStatus"},
                "ts_us": 3,
            },
        ]

        contract = trace_finalize.build_environment_contract(rows)
        coverage = contract["coverage"]
        self.assertEqual(coverage["async_result_calls"], 1)
        self.assertEqual(coverage["async_result_observed_pending"], 1)
        self.assertEqual(coverage["async_result_pending"], 0)
        self.assertEqual(coverage["async_result_fulfilled"], 1)
        self.assertTrue(coverage["async_result_values_captured"])
        self.assertEqual(contract["promise_ledger"]["promise_1"]["settlement_count"], 1)

    def test_script_resource_hash_is_joined_to_js_url(self):
        rows = [
            {
                "type": "script.resource",
                "url": "https://fixture.test/app.js",
                "final_url": "https://fixture.test/app.js",
                "raw_sha256": "a" * 64,
                "artifact_path": "scripts/" + "a" * 64 + ".js",
            },
            {
                "type": "js.call.enter",
                "script_url": "https://fixture.test/app.js",
            },
        ]

        stats = trace_finalize.enrich_script_resource_identity(rows)
        self.assertEqual(stats["joined_event_count"], 1)
        self.assertEqual(rows[1]["script_sha256"], "a" * 64)
        self.assertEqual(rows[1]["script_hash_source"], "script.resource.raw_sha256")
        self.assertEqual(rows[1]["script_artifact_path"], "scripts/" + "a" * 64 + ".js")

    def test_trace_health_marks_limits_without_claiming_runtime_change(self):
        health = trace_finalize.build_trace_health(
            {"env": {"TRACE_DOM": "1", "TRACE_DOM_LIMIT_EVENTS": "2"}},
            [
                {
                    "type": "trace.degraded",
                    "module": "dom",
                    "reason": "event_limit",
                    "limit": 2,
                },
                {
                    "type": "js.boundary.flush_summary",
                    "complete_window": False,
                    "skipped_by_window": 4,
                },
            ],
            [],
            {"coverage": {}},
        )
        self.assertFalse(health["evidence_complete"])
        self.assertTrue(health["runtime_behavior_unchanged"])
        self.assertIn("dom:event_limit", health["incomplete_reasons"])
        self.assertIn("js:boundary_window_incomplete", health["incomplete_reasons"])
        self.assertEqual(health["configured_limits"]["TRACE_DOM_LIMIT_EVENTS"], "2")

    def test_trace_health_accepts_stored_values_and_empty_scalars(self):
        health = trace_finalize.build_trace_health(
            {"env": {"TRACE_DOM": "1"}},
            [
                {
                    "type": "dom.call",
                    "value_preview_truncated": True,
                    "value_stored": True,
                    "value_store_path": "values/full-value.txt",
                },
                {
                    "type": "dom.get",
                    "value_preview": "",
                    "value_size": 0,
                    "value_store_skipped": "below_min_bytes",
                },
            ],
            [],
            {"coverage": {}},
        )
        self.assertTrue(health["evidence_complete"])
        self.assertEqual(health["incomplete_reasons"], [])

    def test_trace_health_accepts_complete_transport_and_wasm_artifacts(self):
        health = trace_finalize.build_trace_health(
            {"env": {}},
            [
                {
                    "type": "fetch.request",
                    "body_preview_truncated": True,
                    "body_value_stored": True,
                    "body_value_store_path": "values/request.json",
                    "body_value_truncated": False,
                },
                {
                    "type": "wasm.module",
                    "bytecode_preview_truncated": True,
                    "dump_stored": True,
                    "dump_truncated": False,
                    "artifact_path": "wasm/module.wasm",
                },
            ],
            [],
            {"coverage": {}},
        )
        self.assertTrue(health["evidence_complete"])
        self.assertEqual(health["incomplete_reasons"], [])

    def test_trace_health_marks_nested_js_binary_preview_truncation(self):
        health = trace_finalize.build_trace_health(
            {"env": {}},
            [
                {
                    "type": "js.call.return",
                    "data": {"return": {"bytes_truncated": True}},
                }
            ],
            [],
            {"coverage": {}},
        )
        self.assertFalse(health["evidence_complete"])
        self.assertIn(
            "js.call.return:data.return.bytes_truncated",
            health["incomplete_reasons"],
        )

    def test_trace_health_accepts_observed_pending_promises(self):
        health = trace_finalize.build_trace_health(
            {"env": {"TRACE_DOM": "1"}},
            [],
            [],
            {
                "coverage": {
                    "async_result_calls": 1,
                    "async_result_pending": 1,
                    "async_result_values_captured": False,
                }
            },
        )
        self.assertTrue(health["evidence_complete"])
        self.assertEqual(health["incomplete_reasons"], [])

    def test_trace_health_rejects_unstarted_target_run(self):
        health = trace_finalize.build_trace_health(
            {"env": {"TRACE_QUERY_FIELDS": "trace_token"}},
            [],
            [],
            {"coverage": {}},
        )
        self.assertFalse(health["evidence_complete"])
        self.assertIn(
            "request:configured_target_not_observed",
            health["incomplete_reasons"],
        )
        self.assertIn(
            "control:runtime_config_not_acknowledged",
            health["incomplete_reasons"],
        )
        self.assertEqual(health["counts"]["target_field_matches"], 0)
        self.assertEqual(health["counts"]["runtime_config_acks"], 0)

    def test_trace_health_accepts_acknowledged_target_run(self):
        health = trace_finalize.build_trace_health(
            {"env": {"TRACE_QUERY_FIELDS": "trace_token"}},
            [{"type": "trace.config.applied"}],
            [{"field_name": "trace_token", "target": True, "value": "x"}],
            {"coverage": {}},
        )
        self.assertTrue(health["evidence_complete"])
        self.assertEqual(health["incomplete_reasons"], [])

    def test_trace_health_requires_requested_vm_window_artifact(self):
        health = trace_finalize.build_trace_health(
            {
                "env": {
                    "TRACE_QUERY_FIELDS": "trace_token",
                    "TRACE_VM_WINDOW": "1",
                }
            },
            [{"type": "trace.config.applied"}],
            [{"field_name": "trace_token", "target": True, "value": "x"}],
            {"coverage": {}},
        )
        self.assertFalse(health["evidence_complete"])
        self.assertIn(
            "vm_window:artifact_not_emitted",
            health["incomplete_reasons"],
        )
        self.assertEqual(health["counts"]["vm_window_artifacts"], 0)

    def test_full_chain_overrides_inactive_vm_ipc_defaults(self):
        env = trace_console_server.startup_env_from_payload(
            {
                "plan": "full-chain",
                "modules": {"js": True, "wasm": False},
                "options": {},
                # This is the same unselected VM payload emitted by the UI.
                "vm": {
                    "opcode": False,
                    "vm_step": False,
                    "wasm_module": False,
                    "ipc_max_events_per_second": "12000",
                    "ipc_max_bytes_per_second": "8388608",
                },
            }
        )
        self.assertEqual(env["TRACE_IPC_MAX_EVENTS_PER_SECOND"], "0")
        self.assertEqual(env["TRACE_IPC_MAX_BYTES_PER_SECOND"], "0")

    def test_vm_window_uses_compact_mode_without_opcode_json(self):
        env = trace_console_server.vm_env_from_payload(
            {
                "vm_window": True,
                "vm_window_records": 32768,
                "script_contains": "target.js",
            }
        )
        self.assertEqual(env["TRACE_EXECUTION_MODE"], "opcode")
        self.assertEqual(env["TRACE_VM_WINDOW"], "1")
        self.assertEqual(env["TRACE_VM_WINDOW_RECORDS"], "32768")
        self.assertEqual(env["TRACE_OPCODE"], "0")
        self.assertEqual(env["TRACE_VM_STEP"], "0")
        self.assertEqual(env["TRACE_JS_MODE"], "boundary")
        self.assertEqual(env["TRACE_JS_BOUNDARY_BUFFER"], "1")

    def test_vm_window_rejects_verbose_opcode_combination(self):
        with self.assertRaisesRegex(ValueError, "必须分阶段运行"):
            trace_console_server.vm_env_from_payload(
                {"vm_window": True, "opcode": True}
            )


if __name__ == "__main__":
    unittest.main()
