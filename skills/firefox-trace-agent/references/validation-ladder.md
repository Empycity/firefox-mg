# Validation Ladder

## 0. Environment-first gate

For a new target, start with the browser environment that the supplied Trace
actually observed. Restore confirmed DOM/BOM/state values or run the original
script in the same Firefox page/profile, then test whether the generated
candidate reaches the real request and satisfies the endpoint's application
success condition.

If a built-in object/value is absent from the complete Trace, read it directly
from the open Firefox page through DevTools/RDP/BiDi before asking for another
Trace. Use `environment-repair-playbook.md`; a value-only gap is a browser
console observation, not a reason to repeat page collection.

When the supplemented request fails, freeze one complete browser vector and
move to the fixed-byte diff below. If the fixed diff isolates a deterministic
producer/serialization gap, extract a pure function as a diagnostic or as the
explicit offline deliverable. Keep time, randomness, nonce and session values
live in the final route.

## 1. Fixed-vector diff

Use a retained request vector when URL, method, headers, body, cookies/state and
all producer inputs are available. Compare path, every non-target field, raw and
decoded target field, bytes and first difference. This is the preferred proof of
algorithm equivalence.

The vector is bound to the producer script and endpoint. A replay must load the
original URL, query, method, headers, cookies/state, body and serialization order,
then replace only the named target field. Preserve all non-target parameters,
version markers and other request fields from that same vector. If the
original downstream request was not captured, do not synthesize one and use its
status as evidence; report `request_vector_missing`.

## 2. Dynamic field boundary

Split request inputs into:

| Class | Final behavior |
|---|---|
| fixed | Preserve exact bytes and serialization. |
| session-derived | Acquire from the active browser session at request time. |
| per-request dynamic | Generate live: time, random, nonce, challenge state and final signature. |

Recorded time/random values may freeze an old vector for diagnosis. Never ship a
final generator that reuses them.

## 3. Native-page acceptance

When a historical target field cannot byte-align because it is dynamic or the
host contract is incomplete:

1. Generate a fresh candidate locally.
2. Hash it before transport.
3. Send the fixed request vector from the active Firefox page/profile with only
   the candidate field replaced.
4. Capture the final sent field and verify its hash equals the local candidate.
5. Require HTTP success plus the endpoint's JSON/application success flag and
   expected business payload.

This validates the candidate in the native JS, Cookie and network context. It
does not claim historical diff alignment.

## 4. Standalone-client acceptance

Only after the native-page baseline passes, test a protocol client when that is
part of the deliverable:

1. Snapshot the active browser profile/session state, including HTTP-only
   cookies where the client needs them.
2. Keep URL, method, headers, body and every non-target field fixed.
3. Replace only the locally generated candidate field.
4. Apply the same application-level response acceptance rule.

If the native page passes but the client fails, report a transport/session gap,
not an algorithm failure.

### Transport fingerprint checkpoint

Run this checkpoint before changing a producer or rebuilding Firefox. Keep the
browser's user-agent and language headers, use one session for configuration and
target calls, and make TLS/HTTP2 impersonation, fetch metadata, redirects, and
connection reuse explicit. Compare the native-page baseline and client response
at the application layer: status, JSON shape, business code/result, and redirect
or punishment URL. A `200` response with a validation error is still a failed
checkpoint. Change one transport/session variable per A/B run and retain the
first response that reaches the application handler.

If the native page accepts a fresh candidate while the client does not, label the
gap `transport/session` and keep the producer unchanged. Enter byte-level field
diff only after this checkpoint passes; a different dynamic-field length by
itself is not evidence of an algorithm mismatch.

## 5. Session dependency minimization

Start from a passing full-session client baseline. Test disjoint cookie/state
subsets, retain a passing subset, and repeat until a minimal passing set is
found. Confirm necessity by testing the full baseline with that dependency
removed. Use a newly generated dynamic field for the final confirmation.

For a token-only gate, create a brand-new HTTP session after token issuance,
send an explicit Cookie header containing only the target token, and inspect the
actual sent request to verify the exact cookie names. Do not infer isolation
from the source code or from clearing a reused cookie jar. Require both HTTP
success and the endpoint's application success fields/non-empty payload.

Do not minimize before a full baseline exists, and do not infer a dependency
from HTTP status alone.

## 6. Browser patch gate

Consider a Firefox/runtime patch only after the failure is tied to a named
browser implementation gap: missing WebIDL surface, wrong descriptor/prototype
or brand, wrong native object value, broken async/realm behavior, or a Trace
collection path that drops required evidence. A patch must:

1. Change the smallest identified browser surface.
2. Preserve normal call order, task scheduling, serialization, request routing,
   session state and unrelated WebAPIs.
3. Keep the feature behind the existing trace/runtime gate where appropriate.
4. Add a focused smoke probe and a rollback note.
5. Re-run the same request vector and compare every non-target field before
   claiming the patch reproduced.

Changing a request field, replacing a missing value with a guess, or altering
the page's normal writer path is not a browser repair; it invalidates the
comparison.
