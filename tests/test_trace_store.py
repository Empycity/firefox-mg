import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("trace_store", ROOT / "tools" / "trace_store.py")
trace_store = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trace_store)


def write_run(root, label, event, created):
    run = root / label
    run.mkdir()
    (run / "manifest.json").write_text(json.dumps({"campaign_id": "fixture", "run_label": label, "created_at_unix": created}))
    (run / "firefox-fetch-1.jsonl").write_text(json.dumps(event) + "\n")
    return run


class TraceStoreTests(unittest.TestCase):
    def test_campaign_import_preserves_runs_and_relation_queries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db = root / "campaign.sqlite"
            first = write_run(root, "discover", {"type": "fetch.response", "request_id": "req_1", "query_fields": {"sign": "left;right"}, "origin_call_id": "call_1"}, 1)
            second = write_run(root, "target", {"type": "js.call.enter", "call_id": "call_1", "script_sha256": "a" * 64}, 2)
            trace_store.import_run(first, db); trace_store.import_run(second, db)
            store = trace_store.connect(db)
            self.assertEqual(store.execute("SELECT count(*) FROM runs").fetchone()[0], 2)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                trace_store.query(db, "chain", "call_1")
            chain = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual({item["type"] for item in chain}, {"fetch.response", "js.call.enter"})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                trace_store.query(db, "split-field", "req_1:sign")
            self.assertEqual([json.loads(line)["part"] for line in output.getvalue().splitlines()], ["left", "right"])


if __name__ == "__main__":
    unittest.main()
