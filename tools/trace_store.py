#!/usr/bin/env python3
"""SQLite adapter and query CLI for a Firefox Trace run."""

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, source_file TEXT NOT NULL, source_line INTEGER NOT NULL,
  event_type TEXT, module TEXT, ts_us INTEGER, segment_id TEXT, request_id TEXT,
  call_id TEXT, parent_call_id TEXT, origin_call_id TEXT, script_url TEXT,
  script_sha256 TEXT, value_id TEXT, raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_request ON events(request_id);
CREATE INDEX IF NOT EXISTS events_call ON events(call_id);
CREATE INDEX IF NOT EXISTS events_origin ON events(origin_call_id);
CREATE INDEX IF NOT EXISTS events_value ON events(value_id);
CREATE TABLE IF NOT EXISTS field_values (
  event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  value TEXT, sha256 TEXT
);
CREATE INDEX IF NOT EXISTS field_values_name ON field_values(name);
CREATE INDEX IF NOT EXISTS field_values_sha ON field_values(sha256);
CREATE TABLE IF NOT EXISTS artifacts (
  path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL
);
"""


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def scalars(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from scalars(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from scalars(child, f"{path}[{index}]")
    elif isinstance(value, (str, int, float, bool)) and path:
        yield path.rsplit(".", 1)[-1], str(value)


def import_run(trace_dir, db_path):
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    db.execute("DELETE FROM field_values"); db.execute("DELETE FROM events"); db.execute("DELETE FROM artifacts")
    for source in sorted(trace_dir.glob("firefox-*.jsonl")):
        for line_no, line in enumerate(source.read_text(errors="replace").splitlines(), 1):
            try: event = json.loads(line)
            except json.JSONDecodeError: continue
            cursor = db.execute(
                "INSERT INTO events(source_file,source_line,event_type,module,ts_us,segment_id,request_id,call_id,parent_call_id,origin_call_id,script_url,script_sha256,value_id,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (source.name, line_no, event.get("type"), event.get("module"), event.get("ts_us"), event.get("segment_id"), event.get("request_id"), event.get("call_id"), event.get("parent_call_id"), event.get("origin_call_id"), event.get("script_url"), event.get("script_sha256"), event.get("value_id"), json.dumps(event, ensure_ascii=False, sort_keys=True)),
            )
            rows = [(cursor.lastrowid, name, value, hashlib.sha256(value.encode()).hexdigest()) for name, value in scalars(event)]
            db.executemany("INSERT INTO field_values(event_id,name,value,sha256) VALUES(?,?,?,?)", rows)
    for kind in ("values", "scripts", "source_maps"):
        root = trace_dir / kind
        if root.is_dir():
            for path in root.rglob("*"):
                if path.is_file(): db.execute("INSERT INTO artifacts VALUES(?,?,?,?)", (str(path.relative_to(trace_dir)), kind, path.stat().st_size, digest(path)))
    db.commit(); print(f"imported {db.execute('SELECT count(*) FROM events').fetchone()[0]} events into {db_path}")


def query(db_path, column, value):
    db = sqlite3.connect(db_path); db.row_factory = sqlite3.Row
    if column == "field":
        rows = db.execute("SELECT e.* FROM field_values f JOIN events e ON e.id=f.event_id WHERE lower(f.name)=lower(?) ORDER BY e.ts_us", (value,))
    elif column == "value-sha":
        rows = db.execute("SELECT e.* FROM field_values f JOIN events e ON e.id=f.event_id WHERE f.sha256=? ORDER BY e.ts_us", (value,))
    else:
        rows = db.execute(f"SELECT * FROM events WHERE {column}=? ORDER BY ts_us", (value,))
    for row in rows: print(json.dumps(json.loads(row["raw_json"]), ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("import"); command.add_argument("trace_dir", type=Path); command.add_argument("--db", type=Path)
    for name in ("field", "value-sha", "call", "request"):
        command = sub.add_parser(name); command.add_argument("db", type=Path); command.add_argument("value")
    args = parser.parse_args()
    if args.command == "import": import_run(args.trace_dir, args.db or args.trace_dir / "trace-store.sqlite")
    else: query(args.db, {"call":"call_id", "request":"request_id"}.get(args.command, args.command), args.value)


if __name__ == "__main__": main()
