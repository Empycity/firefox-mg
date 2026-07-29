#!/usr/bin/env python3
"""SQLite campaign store and relation query CLI for Firefox Trace JSONL runs."""

import argparse
import hashlib
import json
import re
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, campaign_id TEXT, run_label TEXT, trace_dir TEXT NOT NULL,
  target_url TEXT, created_at INTEGER, manifest_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_campaign ON runs(campaign_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL, event_type TEXT, module TEXT, ts_us INTEGER, segment_id TEXT,
  request_id TEXT, call_id TEXT, parent_call_id TEXT, origin_call_id TEXT, script_url TEXT,
  script_sha256 TEXT, value_id TEXT, raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, ts_us);
CREATE INDEX IF NOT EXISTS events_request ON events(run_id, request_id);
CREATE INDEX IF NOT EXISTS events_call ON events(run_id, call_id);
CREATE INDEX IF NOT EXISTS events_origin ON events(run_id, origin_call_id);
CREATE INDEX IF NOT EXISTS events_script ON events(run_id, script_sha256);
CREATE TABLE IF NOT EXISTS field_values (
  event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL, value TEXT, sha256 TEXT
);
CREATE INDEX IF NOT EXISTS field_values_name ON field_values(name);
CREATE INDEX IF NOT EXISTS field_values_sha ON field_values(sha256);
CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL REFERENCES runs(run_id), path TEXT NOT NULL, kind TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(run_id, path)
);
"""

SPLIT = re.compile(r"[;,&|.]|(?<=\})(?=\{)")

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def scalars(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from scalars(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from scalars(child, f"{path}[{index}]")
    elif isinstance(value, (str, int, float, bool)) and path:
        yield path.rsplit(".", 1)[-1], str(value)

def manifest_for(trace_dir):
    path = trace_dir / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

def run_identity(trace_dir, manifest):
    stable = manifest.get("run_id") or trace_dir.name
    campaign = manifest.get("campaign_id") or "uncategorized"
    return f"{campaign}:{stable}", campaign

def connect(path):
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    return db

def import_run(trace_dir, db_path):
    trace_dir = trace_dir.resolve(); manifest = manifest_for(trace_dir)
    run_id, campaign = run_identity(trace_dir, manifest); db = connect(db_path)
    db.execute("DELETE FROM field_values WHERE event_id IN (SELECT id FROM events WHERE run_id=?)", (run_id,))
    db.execute("DELETE FROM events WHERE run_id=?", (run_id,)); db.execute("DELETE FROM artifacts WHERE run_id=?", (run_id,))
    db.execute("INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?,?)", (run_id, campaign, manifest.get("run_label", ""), str(trace_dir), manifest.get("target_url", ""), manifest.get("created_at_unix"), json.dumps(manifest, ensure_ascii=False, sort_keys=True)))
    count = 0
    for source in sorted(trace_dir.glob("firefox-*.jsonl")):
        for line_no, line in enumerate(source.read_text(errors="replace").splitlines(), 1):
            try: event = json.loads(line)
            except json.JSONDecodeError: continue
            c = db.execute("INSERT INTO events(run_id,source_file,source_line,event_type,module,ts_us,segment_id,request_id,call_id,parent_call_id,origin_call_id,script_url,script_sha256,value_id,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (run_id,source.name,line_no,event.get("type"),event.get("module"),event.get("ts_us"),event.get("segment_id"),event.get("request_id"),event.get("call_id"),event.get("parent_call_id"),event.get("origin_call_id"),event.get("script_url"),event.get("script_sha256"),event.get("value_id"),json.dumps(event,ensure_ascii=False,sort_keys=True)))
            db.executemany("INSERT INTO field_values VALUES(?,?,?,?)", [(c.lastrowid,n,v,hashlib.sha256(v.encode()).hexdigest()) for n,v in scalars(event)]); count += 1
    for kind in ("values","scripts","source_maps"):
        root=trace_dir/kind
        if root.is_dir():
            for path in root.rglob("*"):
                if path.is_file(): db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?)", (run_id,str(path.relative_to(trace_dir)),kind,path.stat().st_size,digest(path)))
    db.commit(); print(json.dumps({"run_id":run_id,"events":count,"db":str(db_path)},ensure_ascii=False))

def emit(rows):
    for row in rows: print(json.dumps(json.loads(row["raw_json"]), ensure_ascii=False, sort_keys=True))

def split_value(value):
    """Split common transport encodings without a site-specific grammar."""
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        decoded = None
    if isinstance(decoded, (dict, list)):
        return [part for _, part in scalars(decoded)]
    return [part for part in SPLIT.split(value) if part]

def evidence_rows(db, campaign_id, part):
    """Return indexed candidate sources ordered by evidence strength and time."""
    part_sha = hashlib.sha256(part.encode()).hexdigest()
    rows = []
    # Exact text and digest are intentionally separate: callers can retain a
    # hash-only relation when a source value is redacted from its event.
    for evidence, sql, args in (
        ("exact", "SELECT e.*, f.name AS field_name FROM field_values f JOIN events e ON e.id=f.event_id WHERE e.run_id IN (SELECT run_id FROM runs WHERE campaign_id=?) AND f.value=?", (campaign_id, part)),
        ("digest(source-string)", "SELECT e.*, f.name AS field_name FROM field_values f JOIN events e ON e.id=f.event_id WHERE e.run_id IN (SELECT run_id FROM runs WHERE campaign_id=?) AND f.sha256=?", (campaign_id, part_sha)),
        ("contains", "SELECT e.*, f.name AS field_name FROM field_values f JOIN events e ON e.id=f.event_id WHERE e.run_id IN (SELECT run_id FROM runs WHERE campaign_id=?) AND instr(f.value, ?) > 0 AND f.value<>?", (campaign_id, part, part)),
    ):
        for row in db.execute(sql + " ORDER BY e.ts_us", args):
            rows.append({
                "evidence": evidence,
                "event_type": row["event_type"],
                "request_id": row["request_id"],
                "call_id": row["call_id"],
                "origin_call_id": row["origin_call_id"],
                "script_url": row["script_url"],
                "field": row["field_name"],
                "ts_us": row["ts_us"],
            })
    return rows

def query(db_path, command, value, run_id=None):
    db=connect(db_path); db.row_factory=sqlite3.Row; where=""; args=[]
    if run_id: where=" AND e.run_id=?"; args.append(run_id)
    if command == "field": sql="SELECT e.* FROM field_values f JOIN events e ON e.id=f.event_id WHERE lower(f.name)=lower(?)"+where; args.insert(0,value)
    elif command == "value-sha": sql="SELECT e.* FROM field_values f JOIN events e ON e.id=f.event_id WHERE f.sha256=?"+where; args.insert(0,value)
    elif command == "chain": sql="SELECT * FROM events e WHERE (e.call_id=? OR e.parent_call_id=? OR e.origin_call_id=?)"+where; args[0:0]=[value,value,value]
    elif command == "split-field":
        request_id, field=value.split(":",1); row=db.execute("SELECT value FROM field_values f JOIN events e ON e.id=f.event_id WHERE e.request_id=? AND lower(f.name)=lower(?) ORDER BY e.ts_us DESC LIMIT 1",(request_id,field)).fetchone()
        if not row: return
        source_campaign = None
        if run_id:
            source = db.execute("SELECT campaign_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
        else:
            source = db.execute("SELECT r.campaign_id FROM events e JOIN runs r ON r.run_id=e.run_id WHERE e.request_id=? ORDER BY e.ts_us DESC LIMIT 1", (request_id,)).fetchone()
        source_campaign = source[0] if source else None
        for part in split_value(row[0]):
            candidates = evidence_rows(db, source_campaign, part) if source_campaign else []
            strengths = {candidate["evidence"] for candidate in candidates}
            strength = "exact" if "exact" in strengths else "digest(source-string)" if "digest(source-string)" in strengths else "contains" if "contains" in strengths else "none"
            print(json.dumps({"part": part, "sha256": hashlib.sha256(part.encode()).hexdigest(), "strength": strength, "candidates": candidates}, ensure_ascii=False))
        return
    else: sql="SELECT * FROM events e WHERE e.%s=?" % {"call":"call_id","request":"request_id"}[command]; args=[value]
    emit(db.execute(sql+" ORDER BY e.ts_us",args))

def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest="command",required=True)
    x=sub.add_parser("import"); x.add_argument("trace_dir",type=Path); x.add_argument("--db",type=Path)
    x=sub.add_parser("runs"); x.add_argument("db",type=Path); x.add_argument("--campaign")
    for name in ("field","value-sha","call","request","chain","split-field"):
        x=sub.add_parser(name); x.add_argument("db",type=Path); x.add_argument("value"); x.add_argument("--run-id")
    a=p.parse_args()
    if a.command=="import": import_run(a.trace_dir,a.db or a.trace_dir/"trace-store.sqlite")
    elif a.command=="runs":
        db=connect(a.db); rows=db.execute("SELECT run_id,campaign_id,run_label,target_url,created_at FROM runs WHERE campaign_id=COALESCE(?,campaign_id) ORDER BY created_at",(a.campaign,)); [print(json.dumps(dict(zip(("run_id","campaign_id","run_label","target_url","created_at"),r)),ensure_ascii=False)) for r in rows]
    else: query(a.db,a.command,a.value,a.run_id)
if __name__=="__main__": main()
