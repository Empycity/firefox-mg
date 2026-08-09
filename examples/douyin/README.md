# Douyin Runtime

Generate the local `runtime-contract.json` from a finalized trace before the
first run:

```sh
node examples/douyin/export-runtime-contract.js TRACE_DIR examples/douyin
```

The generated file contains the fixed request template, explicit headers,
static DOM/BOM values, and a storage snapshot, so it is intentionally ignored
by Git. The live runner does not read trace logs for its runtime inputs.

Run the complete request and print the JSON response:

```sh
/opt/miniconda3/envs/pythonProject/bin/python \
  examples/douyin/python-page-state-request.py
```

The script internally invokes `bdms-runner.js` to generate a fresh
`a_bogus`, reads only `ttwid` from the configured active Firefox profile, and
prints the summary plus the complete `response` field. Set
`DOUYIN_FIREFOX_PROFILE=/path/to/profile` only when the active profile changes.

The default dynamic mode is `live`:

- `Date.now()` and no-argument `Date` are current values;
- `Math.random()` is a new runtime sequence;
- no `js.time` or `js.random` value is imported from a trace.

Fixed for one request template: method, path, the 39 non-target query fields,
the explicit XHR headers, and body shape. The captured request is `GET` with a
null body; `a_bogus` is a query field.

Session state is not permanently fixed: profile Cookies, `msToken`, `uifid`,
`verifyFp`, `fp`, ticket headers, and page-provided state must come from the
active browser session when making a fresh request. The `restore_seed` in the
contract is an offline diagnostic snapshot, not a replacement for an active
Firefox profile.

For a transport experiment with the active profile cookie database:

```sh
node examples/douyin/request-comment-list.js examples/douyin/runtime-contract.json /tmp/douyin-run.json \
  --cookie-db PROFILE/cookies.sqlite
```

Acceptance is `HTTP 200`, JSON `status_code=0`, and a non-empty `comments`
array. The final acceptance run belongs in Firefox's native page/network
context because a Node HTTP client does not reproduce Firefox transport state.
