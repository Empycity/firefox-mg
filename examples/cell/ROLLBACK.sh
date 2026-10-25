#!/usr/bin/env bash
set -euo pipefail
CASE="$(cd "$(dirname "$0")" && pwd)"
exec python3 - "$CASE" "$@" <<'PY'
import hashlib
import json
import shutil
import sys
from pathlib import Path

case = Path(sys.argv[1])
root = case.parents[1]
changes = json.loads((case / "verification/change-manifest.json").read_text())
args = sys.argv[2:]
mode = args[0] if args else "--check"
if mode == "--copy-dir" and len(args) == 2:
    destination = Path(args[1]).resolve()
    if not destination.is_relative_to(case / "verification") or destination.exists():
        raise SystemExit("Choose a new directory inside cell/verification")
    destination.mkdir(parents=True)
    for item in changes:
        source = root / item["path"]
        target = destination / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
elif mode in {"--apply", "--check"} and len(args) <= 1:
    destination = root
else:
    raise SystemExit("Usage: ROLLBACK.sh [--check|--apply|--copy-dir NEW_DIRECTORY]")

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

# Verify all preconditions before restoring any file, including the backup
# hashes. This preserves later user edits instead of overwriting them.
for item in changes:
    target = destination / item["path"]
    if not target.is_file() or digest(target) != item["after_sha256"]:
        raise SystemExit(f"Modified bytes changed; review first: {target}")
    if item["baseline"]:
        baseline = case / item["baseline"]
        if digest(baseline) != item["before_sha256"]:
            raise SystemExit(f"Baseline hash mismatch: {baseline}")

if mode == "--check":
    print(json.dumps({"verified_files": len(changes), "modified": False}))
    raise SystemExit(0)

for item in changes:
    target = destination / item["path"]
    if item["baseline"]:
        shutil.copy2(case / item["baseline"], target)
        assert digest(target) == item["before_sha256"]
    else:
        target.unlink()
print(json.dumps({"restored_files": len(changes), "destination": str(destination)}))
PY
