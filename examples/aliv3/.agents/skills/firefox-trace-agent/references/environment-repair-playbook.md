# Browser Environment Repair Playbook

Use this playbook when the goal is to improve the Firefox runtime or to make
the original page script run in a local supplemented host. The objective is a
browser-faithful contract, not a collection of values that merely avoids a
`ReferenceError`.

## 1. Missing object: use the open Firefox page first

When `full-chain` has the request and producer but an intrinsic DOM/BOM object
or its returned value is absent, use the same Firefox page/profile directly:

1. Keep the current page and profile open.
2. Run a small expression in the Firefox DevTools console, Firefox RDP, or
   Firefox BiDi `script.evaluate` with `awaitPromise=true`.
3. Read only the named object/member and its contract. Do not reload, start a
   new trace or repeat the user action just to obtain a scalar object value.
4. Save the result as `browser-console-observed` with the page URL, profile
   identity, Firefox build, expression hash and capture time.
5. Compare that observation with the local host before changing code.

This is a value/shape probe, not a causal Trace event. It proves what the
Firefox page exposes; it does not by itself prove that the target producer
uses the value. Causality still comes from the existing JS/request records or
a minimal later trace.

### Safe console probe

Replace `TARGET` and `MEMBERS` with the object and the few members named by the
missing-environment report. The probe inspects descriptors and prototypes
without recursively walking or eagerly invoking every getter.

```js
(() => {
  const TARGET = window.navigator;
  const MEMBERS = ["userAgent", "languages", "plugins", "mimeTypes"];
  const safe = (fn) => {
    try { return { ok: true, value: fn() }; }
    catch (error) {
      return { ok: false, error: {
        name: error?.name || "Error",
        message: String(error?.message || error),
        string: String(error),
      } };
    }
  };
  const describe = (value) => safe(() => ({
    type: typeof value,
    tag: Object.prototype.toString.call(value),
    constructor: value?.constructor?.name || null,
    ownNames: value == null ? [] : Object.getOwnPropertyNames(value),
    ownSymbols: value == null ? [] : Object.getOwnPropertySymbols(value).map(String),
    prototypeChain: (() => {
      const chain = [];
      let current = value;
      for (let i = 0; current && i < 8; i += 1, current = Object.getPrototypeOf(current)) {
        chain.push(current?.constructor?.name || Object.prototype.toString.call(current));
      }
      return chain;
    })(),
  }));
  const members = Object.fromEntries(MEMBERS.map((name) => {
    const descriptor = safe(() => {
      let owner = TARGET;
      while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) {
        owner = Object.getPrototypeOf(owner);
      }
      return owner ? Object.getOwnPropertyDescriptor(owner, name) : null;
    });
    const value = safe(() => TARGET[name]);
    return [name, {
      descriptor: descriptor.ok ? descriptor.value : descriptor,
      value: value.ok ? describe(value.value) : value,
      length: value.ok ? safe(() => value.value?.length ?? null) : null,
      byteLength: value.ok ? safe(() => value.value?.byteLength ?? null) : null,
    }];
  }));
  return { object: describe(TARGET), members };
})()
```

For a Promise-returning member, evaluate the fulfillment explicitly:

```js
(async () => {
  const value = await TARGET_MEMBER;
  return { type: typeof value, tag: Object.prototype.toString.call(value), value };
})()
```

Keep the expression narrow. A full `Object.keys(window)` or recursive getter
walk creates noise and can change lazy browser state.

## 2. What to capture for each missing environment item

| Surface | Minimum browser observation |
|---|---|
| Global/Window | `window/self/globalThis/top/parent` relations, descriptor and prototype chain. |
| Navigator/Screen | Exact scalar values, `languages`, `plugins`/`mimeTypes` length and entries, descriptors and `instanceof`. |
| Canvas 2D | `measureText` metrics, `toDataURL` bytes/hash, `getImageData` dimensions and data bytes. |
| WebGL/WebGL2 | Supported extensions, renderer/vendor parameters, typed vectors, precision ranges and errors. |
| Audio/Fonts | Terminal sample/hash, channel length, font availability and measurement values. |
| DOM/CSSOM | `getBoundingClientRect`, computed style, live/static collection behavior, node/prototype relations. |
| Storage/Cookie | Before/after values, ordering, scope, expiration and request-time snapshot. |
| Time/Random | Exact call result and sequence only for diagnosis; final runtime generates fresh values. |
| Promise/Worker/iframe | Fulfillment value, realm constructor identity, task order and lifecycle after close/terminate. |
| XHR/Fetch | Request/response semantics, event order, credentials, body serialization and session binding. |

Never turn a missing collection into `[]`, a missing object into `{}`, or an
unknown numeric/byte value into `0` in the final host. A temporary existence
probe may use a sentinel, but the report must mark it `probe-only` and replace
it before request validation.

## 3. Native-like object construction

Implement only the observed surface, with complete semantics for that surface:

- Build the constructor and full prototype chain before creating instances.
- Match `Object.prototype.toString`, `Symbol.toStringTag`, `constructor.name`,
  `instanceof`, `Function.prototype.toString`, own-key order and descriptors.
- Preserve getter/setter shape, receiver checks, illegal-constructor errors and
  side effects. A data property is not equivalent to a browser accessor.
- Keep internal state in native/private storage or a module `WeakMap`; never
  expose ad-hoc `_`/`__` state on page-visible objects.
- Give iframe and Worker realms separate constructors and wrappers. Sharing an
  underlying state store does not justify sharing `window`, `navigator`,
  `Promise`, `URL`, `Request`, `Response` or `Event` identities.
- For fingerprint values, use the same Firefox profile/build and complete
  bytes. Do not transplant values from Chrome or another profile.

### Firefox replay pitfalls

- API presence is only the first gate. Match value semantics plus descriptor,
  prototype, brand, receiver checks and realm identity. A Node polyfill with the
  right output can still select a different browser branch.
- Construct `TextEncoder`, typed arrays and Firefox-specific methods in the page
  realm. Check typed-array constructor/static shape as well as instances; for
  example, expose `Uint8Array.fromBase64` only when the observed Firefox build
  has it. Feature-detect Firefox-only surfaces instead of applying a global
  cross-browser polyfill.
- Preserve collection length/order and node identity for `scripts`, plugins,
  mime types and DOM collections. Keep `currentScript`, collection entries,
  insertion anchors, listener targets and dispatched-event targets connected to
  the same objects.
- Treat `document.currentScript`, `document.scripts` and
  `getElementsByTagName("script")` as one identity contract: the returned
  `HTMLCollection` must contain ordered script nodes whose `getAttribute("src")`,
  `src`, prototype and `parentNode` agree. Preserve record discriminator fields
  used to build that collection; dropping `type`/kind metadata can silently
  produce an empty collection.
- Execute a dynamically inserted script in the node's owning document and realm.
  Keep that exact node as `document.currentScript` while it executes and expose
  the same identity through script collections. Let the script's own query or
  property-based `load` callback fire once; the host must not invoke it again.
- Match `PerformanceObserver` delivery semantics, not just its constructor and
  callback shape. A normal `observe()` registration receives only later entries;
  historical entries are replayed only for an observed Firefox form that
  explicitly requests buffered delivery. `disconnect()` must unregister the
  observer so no later task can deliver to it.
- Preserve browser-native `Error.stack` and function-string formats separately in
  the main page, iframe and Worker realms. Probe the same Firefox build/profile
  before implementing them. Do not hide host leakage by returning an empty stack:
  remove Node, VM-wrapper and host-path frames while retaining the browser's
  observed frame syntax and ordering. Timer wrappers must not add synthetic host
  frames.
- Preserve typed return values and inner bytes for Canvas/WebGL/TextMetrics;
  correct outer brands with empty arrays or zeroed fields are still incomplete.
- Queue Worker-originated trace records onto the owning/main trace thread and
  retain task order. Do not write shared trace state directly from Worker hooks.
- Worker `blob:` script realms may inherit trace eligibility only from a
  captured inbound message task. Do not globally bypass the page URL filter;
  that mixes browser-internal Worker traffic into the target timeline.
- Compare Worker and iframe execution as ordered task streams. After each server
  response, record the exact `postMessage` payload sequence and locate the first
  browser/local divergence. A changed next-task list proves the decision occurred
  in the preceding computation or response handling; do not fabricate a missing
  downstream URL or message to make the later transport appear complete.
- Compare nested values, not only outer key sets, types, array lengths or encoded
  payload size. Inspect stack strings, `PerformanceEntry` fields, event
  `origin`/`source`/`isTrusted`, constructor realm identity and inner byte arrays.
  Similar request lengths are diagnostic context, never replay acceptance.
- Object preview must not recursively invoke page getters. Use a per-thread
  re-entry guard, bounded target-only expansion and a scalar fallback; diagnose a
  tab crash from the symbolized stack before blaming target-field count.

## 4. Missing-environment report

Every item emitted to the Agent report should use this shape:

```json
{
  "api": "Interface.member",
  "status": "missing-value|missing-shape|missing-causality",
  "source": "firefox-console-observed|trace|value-store|inference",
  "browser_observation": {"type": "object", "tag": "[object Object]"},
  "local_observation": {"type": "undefined"},
  "producer_link": {"request_id": "", "origin_call_id": "", "call_id": ""},
  "next_action": "patch the named object shape and rerun the same vector"
}
```

Use `missing-value` when the object exists but an inner value is absent,
`missing-shape` for prototype/descriptor/brand/realm differences, and
`missing-causality` when the value is known but its producer relation is not.
Only the last category normally needs another Trace.

## 5. When a new Trace is actually justified

Return to the UI only when one of these remains unresolved:

- the target request or field location is missing;
- the producer script/function/call relation is missing;
- the page action was not recorded or must be repeated with a new segment;
- the direct console cannot reach a Worker/iframe/closure state;
- a request/body/serialization order or raw transport byte needs a causal trace;
- an opcode/VM hotspot must be bounded after the producer is known.

Select the narrowest mode from `ui-parameter-catalog.md`. A missing built-in
object value alone uses the Firefox console route first, not a new full trace.

## 6. Repair and validation loop

```text
Firefox console object/contract observation
  -> local object-shape and value diff
  -> minimal native-like environment patch
  -> original script runs without new host errors
  -> same request vector / only target field candidate
  -> application-level response validation
  -> fixed-byte diff or pure calculation extraction if still divergent
```

Patch the smallest named browser surface. Preserve call order, task timing,
serialization, request routing, session state and unrelated APIs. Add a
regression probe and a rollback note for every browser patch; a patch is
accepted only when the original path still runs and the next request vector
remains unchanged outside the target field.
