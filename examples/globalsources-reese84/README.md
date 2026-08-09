# Global Sources Reese84 Runner

The runtime is self-contained in this directory. Browser environment evidence,
the challenge script, call sequences and request template are compiled into
`reese84-runtime-data.js`; runtime execution does not read Trace JSONL, value
artifacts, `/private/tmp`, or `firefox-trace-outputs`.

## Run

Use the fixed conda environment:

```sh
/opt/miniconda3/envs/pythonProject/bin/python \
  examples/globalsources-reese84/globalsources_reese84.py --page 8 --workers 4
```

`page=N` means run pages `1..N`. Every page independently generates a fresh
`p`, exchanges it for a fresh token, creates a new token-only HTTP session, and
requests that page. Page tasks run concurrently; `--workers` defaults to 4 and
the actual thread count is `min(page, workers)`. Each network phase uses a new
Session and up to three jittered retries by default; set `--retries N` to tune
it. Network exceptions, HTTP 429/5xx, invalid JSON and missing rly tokens are
retried independently for each page. Statistics use a process lock, so concurrent CLI processes do not overwrite
each other. These page forms are equivalent:

```sh
python globalsources_reese84.py --page 3
python globalsources_reese84.py -p 3
python globalsources_reese84.py 3
python globalsources_reese84.py page=3
```

The Feapder-style log prints each page's token, application `code`, and
`list_len`. `.run-stats.json` persists whole-run data plus final task outcomes
after all retries. Each page contributes exactly one task attempt; internal
network retries never increase the denominator. A task succeeds only when the
HTTP status is 200, JSON `code` is `200`, `msg` is `success`, the result list is
non-empty, and the actual Cookie header contains exactly the fresh token.

## Files

- `globalsources_reese84.py`: CLI, requests, logging and statistics.
- `reese84-runtime.js`: browser-like host and dynamic generator.
- `reese84-runtime-data.js`: compiled environment/challenge data, not logs.
- `.run-stats.json`: generated persistent stability statistics.
