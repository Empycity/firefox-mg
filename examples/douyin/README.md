# Douyin Creator Publish

Generate the creator-page BDMS contract from a finalized trace:

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
