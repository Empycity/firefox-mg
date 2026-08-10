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

## Creator create_v2

The creator-page BDMS build uses a different initialization contract:

```sh
node examples/douyin/export-creator-create-v2-contract.js \
  TARGET_TRACE_DIR examples/douyin/creator-runtime-contract.json ENVIRONMENT_TRACE_DIR

node examples/douyin/bdms-runner.js \
  --config examples/douyin/creator-runtime-contract.json
```

The exported contract embeds the minimal observed Firefox environment and the
session snapshot used by the local VM. The runner does not read the source
trace after export. Refresh the contract when the Firefox environment or
session changes. Local `a_bogus` generation uses:

- BDMS `aid=2906`, `pageId=33638`, and the configured `paths.include` list;
- the complete unsigned URL, including dynamic `msToken` and common query
  fields;
- the current browser environment, time, and random sequence.

The POST body is replayed by the runner but is not a direct BDMS signing input:
the browser trace shows `a_bogus` already present at `XMLHttpRequest.open`,
before the body reaches `XMLHttpRequest.send`.

For a live upload experiment, open the creator image-post page in Firefox with
BiDi enabled, then install the bounded request recorder before uploading:

```sh
FIREFOX_PAGE_PREFIX=https://creator.douyin.com/ node \
  examples/douyin/firefox-bidi-eval.mjs examples/douyin/creator-capture-install.js
```

After the upload and pre-publish checks finish, do not click Publish. Export the
page snapshot, build a fresh contract, and submit once with a locally generated
signature:

```sh
FIREFOX_PAGE_PREFIX=https://creator.douyin.com/ node \
  examples/douyin/firefox-bidi-eval.mjs examples/douyin/creator-capture-read.js \
  > /private/tmp/douyin-creator-snapshot.json
node examples/douyin/build-creator-live-contract.js \
  /private/tmp/douyin-creator-snapshot.json \
  examples/douyin/creator-runtime-contract.json \
  examples/douyin/creator-live-contract.json
node examples/douyin/creator-submit.mjs examples/douyin/creator-live-contract.json
```

The recorder stores only selected request metadata and bounded text responses;
it skips upload file bodies. Keep the generated live contract in this directory
so its relative `assets/bdms_1.0.1.16.js` reference remains portable. The live
contract is disposable session data.

The observed creator flow is a two-stage submit:

1. The first `create_v2` can return HTTP 200 with an empty XHR body while the
   page security SDK opens secondary verification.
2. `query_decision`, `send_code`, and `validate_code` update server-side/session
   verification state.
3. The page retries `create_v2` with the same POST body and common query fields,
   but a freshly generated `a_bogus`.
4. Publication is accepted only when the JSON response contains
   `status_code: 0`; HTTP 200 alone is not acceptance.

The replay command reports the first case as
`response_kind: "verification_intercepted"`. Complete verification in the same
Firefox profile before a retry. Do not copy the verification ticket into the
contract: the explicit XHR headers were unchanged across the observed retry,
so the transition belongs to active session/security-SDK state.
