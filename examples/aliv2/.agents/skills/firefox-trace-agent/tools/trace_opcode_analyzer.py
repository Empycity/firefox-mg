#!/usr/bin/env python3
"""Select bounded PC windows from Firefox Trace js.opcode JSONL events."""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
from dataclasses import dataclass
from typing import Any, Iterable


BRANCH_OPS = {
    "And",
    "Case",
    "Coalesce",
    "Default",
    "Goto",
    "JumpIfFalse",
    "JumpIfTrue",
    "LoopHead",
    "Or",
    "TableSwitch",
}
DATA_ACCESS_OPS = {
    "GetElem",
    "GetElemSuper",
    "GetProp",
    "SetElem",
    "SetProp",
    "StrictSetElem",
    "StrictSetProp",
}
CALL_OPS = {
    "Call",
    "CallContent",
    "CallIgnoresRv",
    "CallIter",
    "New",
}


@dataclass(frozen=True)
class ScriptKey:
    url: str
    line: int
    column: int
    bytecode_length: int


def load_opcode_events(root: pathlib.Path) -> tuple[list[dict[str, Any]], int]:
    files = [root] if root.is_file() else sorted(root.glob("firefox-js-*.jsonl"))
    events: list[dict[str, Any]] = []
    degraded = 0
    for path in files:
        with path.open("r", errors="replace") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if row.get("type") == "js.opcode":
                    events.append(row)
                elif row.get("type") == "trace.degraded" and row.get("module") == "opcode":
                    degraded += 1
    return events, degraded


def script_key(row: dict[str, Any]) -> ScriptKey:
    return ScriptKey(
        url=str(row.get("script_url") or ""),
        line=int(row.get("script_line") or 0),
        column=int(row.get("script_column") or 0),
        bytecode_length=int(row.get("script_bytecode_length") or 0),
    )


def sliding_windows(
    rows: Iterable[dict[str, Any]], width: int, top: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pc_counts: collections.Counter[int] = collections.Counter()
    branch_counts: collections.Counter[int] = collections.Counter()
    op_counts: dict[int, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for row in rows:
        pc = int(row.get("pc") or 0)
        op = str(row.get("op_name") or "")
        pc_counts[pc] += 1
        op_counts[pc][op] += 1
        if op in BRANCH_OPS:
            branch_counts[pc] += 1

    pcs = sorted(pc_counts)
    candidates: list[dict[str, Any]] = []
    right = 0
    hits = 0
    branch_hits = 0
    for left, start in enumerate(pcs):
        while right < len(pcs) and pcs[right] <= start + width - 1:
            hits += pc_counts[pcs[right]]
            branch_hits += branch_counts[pcs[right]]
            right += 1
        end = start + width - 1
        distinct = right - left
        candidates.append(
            {
                "start": start,
                "end": end,
                "hits": hits,
                "branch_hits": branch_hits,
                "distinct_pcs": distinct,
                "score": hits + branch_hits * 2,
            }
        )
        hits -= pc_counts[start]
        branch_hits -= branch_counts[start]

    selected: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: (-item["score"], item["start"])):
        if any(
            not (candidate["end"] < existing["start"] or candidate["start"] > existing["end"])
            for existing in selected
        ):
            continue
        selected.append(candidate)
        if len(selected) >= top:
            break

    hot_pcs = []
    for pc, count in pc_counts.most_common(min(12, len(pc_counts))):
        hot_pcs.append(
            {
                "pc": pc,
                "hits": count,
                "branch_hits": branch_counts[pc],
                "ops": [name for name, _ in op_counts[pc].most_common(4)],
            }
        )
    for item in selected:
        item["env"] = f"TRACE_OPCODE_PC_RANGE={item['start']}:{item['end']}"
    return selected, hot_pcs


def dispatcher_signals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    op_counts = collections.Counter(str(row.get("op_name") or "") for row in rows)
    pc_counts = collections.Counter(int(row.get("pc") or 0) for row in rows)
    branch_by_pc: collections.Counter[int] = collections.Counter()
    data_by_pc: collections.Counter[int] = collections.Counter()
    call_by_pc: collections.Counter[int] = collections.Counter()
    for row in rows:
        pc = int(row.get("pc") or 0)
        op = str(row.get("op_name") or "")
        if op in BRANCH_OPS:
            branch_by_pc[pc] += 1
        if op in DATA_ACCESS_OPS:
            data_by_pc[pc] += 1
        if op in CALL_OPS:
            call_by_pc[pc] += 1
    unique_pcs = len(pc_counts)
    repetition = len(rows) / max(unique_pcs, 1)
    loop_hits = op_counts["LoopHead"]
    branch_hits = sum(op_counts[name] for name in BRANCH_OPS)
    data_access_hits = sum(op_counts[name] for name in DATA_ACCESS_OPS)
    call_hits = sum(op_counts[name] for name in CALL_OPS)
    hottest_pc_hits = max(pc_counts.values(), default=0)

    score = min(
        100.0,
        repetition * 12.0
        + min(loop_hits, 20) * 1.5
        + min(branch_hits, 40) * 0.8
        + min(data_access_hits, 60) * 0.5
        + min(call_hits, 30) * 0.5,
    )
    if repetition >= 4 and loop_hits and data_access_hits:
        confidence = "high"
    elif (
        (repetition >= 2 and (loop_hits or branch_hits) and data_access_hits)
        or (loop_hits >= 3 and branch_hits >= 3 and data_access_hits >= 3)
    ):
        confidence = "medium"
    else:
        confidence = "low"
    dispatcher_pcs = sorted(
        pc_counts,
        key=lambda pc: (
            -(
                pc_counts[pc]
                + branch_by_pc[pc] * 2
                + data_by_pc[pc] * 1.5
                + call_by_pc[pc]
            ),
            pc,
        ),
    )
    candidate_pc = dispatcher_pcs[0] if dispatcher_pcs else None
    return {
        "confidence": confidence,
        "score": round(score, 2),
        "event_to_pc_ratio": round(repetition, 3),
        "hottest_pc_hits": hottest_pc_hits,
        "loop_hits": loop_hits,
        "branch_hits": branch_hits,
        "data_access_hits": data_access_hits,
        "call_hits": call_hits,
        "candidate_pc": candidate_pc,
        "signals_are_heuristic": True,
    }


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    events, degraded = load_opcode_events(args.trace_path)
    if args.script_contains:
        events = [row for row in events if args.script_contains in str(row.get("script_url") or "")]

    grouped: dict[ScriptKey, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in events:
        grouped[script_key(row)].append(row)

    scripts = []
    for key, rows in grouped.items():
        windows, hot_pcs = sliding_windows(rows, args.width, args.top_windows)
        dispatcher = dispatcher_signals(rows)
        scripts.append(
            {
                "script_url": key.url,
                "script_line": key.line,
                "script_column": key.column,
                "script_bytecode_length": key.bytecode_length,
                "event_count": len(rows),
                "unique_pcs": len({int(row.get("pc") or 0) for row in rows}),
                "tier_pin_env": {
                    "TRACE_OPCODE_SCRIPT_LINE": str(key.line),
                    "TRACE_OPCODE_SCRIPT_COLUMN": str(key.column),
                    "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH": str(key.bytecode_length),
                },
                "dispatcher_candidate": dispatcher,
                "windows": windows,
                "hot_pcs": hot_pcs,
            }
        )
    scripts.sort(
        key=lambda item: (
            -item["dispatcher_candidate"]["score"],
            -item["event_count"],
            item["script_url"],
            item["script_line"],
        )
    )
    return {
        "schema": "firefox_trace.opcode_analysis.v1",
        "trace_path": str(args.trace_path),
        "window_width": args.width,
        "opcode_events": len(events),
        "opcode_degraded_events": degraded,
        "script_groups": len(scripts),
        "scripts": scripts[: args.top_scripts],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace_path", type=pathlib.Path)
    parser.add_argument("--script-contains", default="")
    parser.add_argument("--width", type=int, default=64)
    parser.add_argument("--top-windows", type=int, default=4)
    parser.add_argument("--top-scripts", type=int, default=12)
    args = parser.parse_args()
    args.width = min(max(args.width, 1), 1_000_000)
    args.top_windows = min(max(args.top_windows, 1), 32)
    args.top_scripts = min(max(args.top_scripts, 1), 128)
    return args


def main() -> int:
    args = parse_args()
    print(json.dumps(analyze(args), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
