#!/usr/bin/env python3
"""Inspect compact Firefox Trace VM-window artifacts without expanding JSONL."""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
from typing import Any, Iterable

from trace_finalize import (
    VM_WINDOW_HEADER,
    VM_WINDOW_RECORD_V1,
    VM_WINDOW_RECORD_V2,
    inspect_vm_window_artifact,
)


VALUE_TYPES = {
    0: "unknown",
    1: "undefined",
    2: "null",
    3: "boolean",
    4: "int32",
    5: "double",
    6: "string",
    7: "object",
    8: "bigint",
    9: "symbol",
    10: "magic",
}


def metadata_rows(trace_dir: pathlib.Path) -> Iterable[dict[str, Any]]:
    for path in sorted(trace_dir.glob("firefox-js-*.jsonl")):
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict) and row.get("type") == "js.vm_window":
                    yield row


def records(path: pathlib.Path):
    with path.open("rb") as stream:
        raw_header = stream.read(VM_WINDOW_HEADER.size)
        header = VM_WINDOW_HEADER.unpack(raw_header)
        record_struct = VM_WINDOW_RECORD_V2 if header[1] == 2 else VM_WINDOW_RECORD_V1
        count = header[8]
        for _ in range(count):
            yield header[1], record_struct.unpack(stream.read(record_struct.size))


def analyze_artifact(trace_dir: pathlib.Path, row: dict[str, Any]) -> dict[str, Any]:
    validation = inspect_vm_window_artifact(trace_dir, row)
    result: dict[str, Any] = {
        "metadata": row,
        "artifact_validation": validation,
    }
    if not validation.get("valid"):
        return result

    path = trace_dir / str(row["artifact_path"])
    pc_counts: collections.Counter[int] = collections.Counter()
    transitions: collections.Counter[tuple[int, int]] = collections.Counter()
    op_counts: collections.Counter[int] = collections.Counter()
    stack_types: collections.Counter[str] = collections.Counter()
    origin_calls: collections.Counter[int] = collections.Counter()
    operand_samples: dict[int, str] = {}
    previous_pc: int | None = None
    primitive_slots = 0
    total_slots = 0
    script_ids: collections.Counter[int] = collections.Counter()
    for version, record in records(path):
        if version == 2:
            (
                _seq, _ts_us, origin_call_id, pc, script_identity,
                _stack_value0, _stack_value1,
                op, _bytecode_length, stack_depth, _script_line,
                _script_column, _script_bytecode_length, operand_length,
                operand_bytes, stack_type0, stack_type1, stack_flags,
            ) = record
            stack_value_types = (stack_type0, stack_type1)
            script_ids[script_identity] += 1
        else:
            (
                _seq, _ts_us, origin_call_id, pc, _stack_value0,
                _stack_value1, op, _bytecode_length, stack_depth,
                operand_length, operand_bytes, stack_type0, stack_type1,
                stack_flags,
            ) = record
            stack_value_types = (stack_type0, stack_type1)
        pc_counts[pc] += 1
        op_counts[op] += 1
        if previous_pc is not None:
            transitions[(previous_pc, pc)] += 1
        previous_pc = pc
        if origin_call_id:
            origin_calls[origin_call_id] += 1
        if operand_length and pc not in operand_samples:
            operand_samples[pc] = operand_bytes[:operand_length].hex()
        for index, value_type in enumerate(stack_value_types):
            if index >= min(stack_depth, len(stack_value_types)):
                continue
            total_slots += 1
            stack_types[VALUE_TYPES.get(value_type, f"type_{value_type}")] += 1
            if stack_flags & (1 << index):
                primitive_slots += 1

    result["summary"] = {
        "record_count": validation["record_count"],
        "unique_pcs": len(pc_counts),
        "unique_transitions": len(transitions),
        "primitive_stack_slots": primitive_slots,
        "observed_stack_slots": total_slots,
        "primitive_stack_coverage": round(primitive_slots / max(total_slots, 1), 6),
        "pretrigger_overwritten": validation["pretrigger_overwritten"],
        "top_pcs": [
            {"pc": pc, "hits": hits, "operand_bytes_hex": operand_samples.get(pc, "")}
            for pc, hits in pc_counts.most_common(24)
        ],
        "top_transitions": [
            {"from_pc": edge[0], "to_pc": edge[1], "hits": hits}
            for edge, hits in transitions.most_common(24)
        ],
        "op_counts": [
            {"op": op, "hits": hits} for op, hits in op_counts.most_common()
        ],
        "stack_type_counts": dict(stack_types.most_common()),
        "origin_call_ids": [
            {"origin_call_id": f"call_{call_id}", "records": hits}
            for call_id, hits in origin_calls.most_common(16)
        ],
        "script_identities": [
            {"identity": f"0x{identity:x}", "records": hits}
            for identity, hits in script_ids.most_common()
        ],
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace_dir", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    trace_dir = args.trace_dir.resolve()
    report = {
        "schema": "firefox_trace.vm_window_analysis.v1",
        "trace_dir": str(trace_dir),
        "windows": [analyze_artifact(trace_dir, row) for row in metadata_rows(trace_dir)],
    }
    output = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0 if report["windows"] and all(
        item["artifact_validation"].get("valid") for item in report["windows"]
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
