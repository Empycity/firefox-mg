# Firefox Trace Analysis Report Template

## 1. Trace health

```text
TRACE_DIR:
manifest:
plan/preset:
startup mode:
summary:
degraded:
ACK status:
```

## 2. Target request field

| Request | Location | Field | Raw SHA-256 | Decoded SHA-256 | Artifact | Origin |
|---|---|---|---|---|---|---|

## 3. Producer candidates

```text
producer_match: deepest exact return in same process/segment before request
producer_chain: producer call -> parent calls
chain_source: origin_call_id | value_sha256
```

| Evidence | Function | Script | Call ID | Parent | Origin | Value role/path | Match |
|---|---|---|---|---|---|---|---|

State which candidates are `candidate`, `correlated`, or `matched`.

## 4. Script artifacts

```text
script_url:
script_sha256:
artifact_path:
source_map:
important offsets/functions:
```

## 5. Dependency ledger

| ID | Input | Class | Source event | Propagation | Field relation | Evidence | Status |
|---|---|---|---|---|---|---|---|

## 6. Reproduction plan

Choose one:

```text
supplemented runtime:
  fixed environment:
  fixed state:
  dynamic values delegated to original SDK:
  validation request/vector:

pure calculation:
  explicit inputs:
  serialization:
  transforms:
  output:
  browser vectors:

mixed:
  components:
  per-component evidence:
  assembly:
```

## 7. Gaps and next trace plan

```text
missing link:
narrowest next segment:
UI settings:
fields:
script/function filters:
VM/WASM settings if any:
success condition:
```
