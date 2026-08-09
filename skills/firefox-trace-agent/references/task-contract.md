# Lightweight Task Contract

Use this optional JSON receipt when a long multi-turn analysis needs state.

```json
{
  "schema_version": 2,
  "task_id": "TASK_ID",
  "trace_dir": "TRACE_DIR",
  "target": {
    "url": "TARGET_URL_OR_UNKNOWN",
    "field_names": [],
    "request_locations": [],
    "action": "USER_ACTION_OR_UNKNOWN"
  },
  "health": {
    "summary_path": "index/summary.json",
    "degraded_count": 0,
    "ack_checked": false,
    "status": "candidate|complete"
  },
  "evidence": {
    "request_sinks": [],
    "producer_candidates": [],
    "dependencies": [],
    "reproduction_vectors": []
  },
  "decision": {
    "route": "standard-js|jsvmp|wasm|mixed|unknown",
    "mode": "supplemented-runtime|pure-calculation|mixed|next-trace",
    "next_action": "READ_LOGS"
  },
  "cleanup": {
    "agent_created_paths": [],
    "removed_paths": [],
    "retained_deliverables": [],
    "running_agent_processes": [],
    "verified": false
  }
}
```

Keep exact file paths, line numbers, request IDs, call IDs, SHA-256 values, and artifact paths inside the arrays.
Set `cleanup.verified=true` only after all disposable Agent-owned paths are gone
and `running_agent_processes` is empty. User-provided inputs never belong in
`removed_paths` unless the user explicitly requested their deletion.
