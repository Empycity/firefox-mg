#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 - "$HERE" "${1:-}" <<'PY'
from pathlib import Path
import hashlib
import json
import os
import sys
import tempfile

here = Path(sys.argv[1])
root = Path(sys.argv[2]).resolve() if sys.argv[2] else here.parents[2]
manifest = json.loads((here / "source-manifest.json").read_text())
def sha(data):
    return hashlib.sha256(data).hexdigest()

# Preflight every file first. Never overwrite work made after this snapshot.
for item in manifest:
    target = root / item["path"]
    if not target.resolve().is_relative_to(root):
        raise SystemExit(f"Path outside selected root: {target}")
    if not target.is_file() or sha(target.read_bytes()) != item["after_sha256"]:
        raise SystemExit(f"Changed since snapshot; left untouched: {target}")
    if item["before_sha256"] is not None:
        backup = here / "baseline" / item["path"]
        if sha(backup.read_bytes()) != item["before_sha256"]:
            raise SystemExit(f"Backup hash mismatch: {backup}")

for item in manifest:
    target = root / item["path"]
    if item["before_sha256"] is None:
        target.unlink()
    else:
        backup = here / "baseline" / item["path"]
        fd, temporary = tempfile.mkstemp(prefix=".trace-restore-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(backup.read_bytes())
            os.chmod(temporary, item["mode"])
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        assert sha(target.read_bytes()) == item["before_sha256"]
    print("restored", target)
print("Source rollback complete. Built runtimes and user traces were not modified.")
PY
