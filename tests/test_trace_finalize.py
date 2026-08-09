import importlib.util
import pathlib
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


if __name__ == "__main__":
    unittest.main()
