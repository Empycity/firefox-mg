#!/usr/bin/env node
"use strict";

// Checks that the captured rly script can initialize with trace-derived host shape.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const inspector = require("inspector");
const { webcrypto, createHash } = require("crypto");
const { performance } = require("perf_hooks");
const compatibilityMode = process.env.PERMISSIVE_HOST === "1";
const compatibilityFallbacks = [];
const nativeSources = new WeakMap();
const binaryStageLog = process.env.TRACE_BINARY_STAGES === "1";
const binaryDebuggerEnabled = process.env.TRACE_BINARY_DEBUGGER === "1";
const binaryDebuggerTarget = Number(process.env.TRACE_BINARY_DEBUGGER_INDEX || "1");
const binaryDebuggerScript = process.env.TRACE_BINARY_DEBUGGER_SCRIPT || "";
const binaryDebuggerAnyScript = process.env.TRACE_BINARY_DEBUGGER_ANY_SCRIPT === "1";
const binaryDebuggerLine = Number(process.env.TRACE_BINARY_DEBUGGER_LINE || "-1");
const binaryDebuggerColumn = Number(process.env.TRACE_BINARY_DEBUGGER_COLUMN || "-1");
const binaryDebuggerExpression = process.env.TRACE_BINARY_DEBUGGER_EXPR || "";
const binaryDebuggerInput = process.env.TRACE_BINARY_DEBUGGER_INPUT || "";
const binaryDebuggerDelayMs = Number(process.env.TRACE_BINARY_DEBUGGER_DELAY_MS || "0");
const binaryDebuggerFrameIndex = Number(process.env.TRACE_BINARY_DEBUGGER_FRAME_INDEX || "0");
let binaryDebuggerSession = null;
let binaryDebuggerPauseCount = 0;

// Some retained traces are several gigabytes and contain JSONL streams larger
// than V8's maximum string length.  Keep the replay usable for those traces by
// decoding one line at a time instead of readFileSync(..., "utf8").split().
function* readJsonLinesSync(filePath, chunkBytes = 1024 * 1024) {
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let carry = "";
  try {
    while (true) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      carry += chunk.toString("utf8", 0, size);
      let newline;
      while ((newline = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, newline).trim();
        carry = carry.slice(newline + 1);
        if (!line) continue;
        yield JSON.parse(line);
      }
    }
    const line = carry.trim();
    if (line) yield JSON.parse(line);
  } finally {
    fs.closeSync(fd);
  }
}
function readDebuggerScopeProperties(objectId) {
  return new Promise((resolve) => {
    if (!objectId || !binaryDebuggerSession) return resolve([]);
    binaryDebuggerSession.post("Runtime.getProperties", { objectId, ownProperties: true }, (_error, result) => {
      resolve((result?.result || []).map((property) => ({
        name: property.name,
        type: property.value?.type || null,
        value: property.value?.value,
        description: property.value?.description || null,
      })).slice(0, 120));
    });
  });
}
if (binaryDebuggerEnabled) {
  binaryDebuggerSession = new inspector.Session();
  binaryDebuggerSession.connect();
  binaryDebuggerSession.post("Debugger.enable");
  if (binaryDebuggerScript && binaryDebuggerLine >= 0 && binaryDebuggerColumn >= 0) {
    binaryDebuggerSession.on("Debugger.scriptParsed", ({ params }) => {
      const url = String(params?.url || "");
      if (process.env.TRACE_BINARY_DEBUGGER_LOG_SCRIPTS === "1") {
        process.stderr.write(`${JSON.stringify({ binary_script: url, script_id: params?.scriptId, line_count: params?.lineCount || null, length: params?.length || null })}\n`);
      }
      if (!binaryDebuggerAnyScript && !url.endsWith(binaryDebuggerScript) && !url.includes(binaryDebuggerScript)) return;
      const install = () => binaryDebuggerSession.post("Debugger.setBreakpointByUrl", {
        url,
        lineNumber: binaryDebuggerLine,
        columnNumber: binaryDebuggerColumn,
      }, (_error, result) => {
          process.stderr.write(`${JSON.stringify({
            binary_breakpoint: "installed",
            url,
            line: binaryDebuggerLine,
            column: binaryDebuggerColumn,
            locations: result?.locations || [],
            error: _error?.message || null,
          })}\n`);
        });
      if (binaryDebuggerDelayMs > 0) setTimeout(install, binaryDebuggerDelayMs);
      else install();
    });
  }
  binaryDebuggerSession.on("Debugger.paused", (message) => {
    const frames = message.params.callFrames || [];
    binaryDebuggerPauseCount += 1;
    if (binaryDebuggerPauseCount !== binaryDebuggerTarget) {
      binaryDebuggerSession.post("Debugger.resume");
      return;
    }
    if (binaryDebuggerScript && frames[0]) {
      const selectedFrame = frames[binaryDebuggerFrameIndex] || frames[0];
      binaryDebuggerSession.post("Debugger.evaluateOnCallFrame", {
        callFrameId: selectedFrame.callFrameId,
        expression: binaryDebuggerExpression || "({ args: [...arguments].map(value => ({ type: typeof value, tag: Object.prototype.toString.call(value), length: value?.length ?? null, byteLength: value?.byteLength ?? null })) })",
        returnByValue: true,
      }, (_error, result) => {
        const report = {
          binary_breakpoint: "paused",
          reason: message.params.reason,
          function_name: selectedFrame.functionName,
          line: selectedFrame.location?.lineNumber,
          column: selectedFrame.location?.columnNumber,
          frame_index: binaryDebuggerFrameIndex,
          scopes: selectedFrame.scopeChain?.map((scope) => ({ type: scope.type, name: scope.name || null })),
          expression: result?.result?.value || result?.result?.description || null,
          error: _error?.message || result?.exceptionDetails?.text || null,
        };
        if (process.env.TRACE_BINARY_DEBUGGER_SCOPE === "1") {
          Promise.all((selectedFrame.scopeChain || []).map((scope) => readDebuggerScopeProperties(scope.object?.objectId)))
            .then((scope_properties) => {
              report.scope_properties = scope_properties;
              process.stderr.write(`${JSON.stringify(report)}\n`);
              binaryDebuggerSession.post("Debugger.resume");
            })
            .catch(() => binaryDebuggerSession.post("Debugger.resume"));
          return;
        }
        process.stderr.write(`${JSON.stringify(report)}\n`);
        binaryDebuggerSession.post("Debugger.resume");
      });
      return;
    }
    const inspect = (frame, expression) => new Promise((resolve) => {
      binaryDebuggerSession.post("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
      }, (error, result) => resolve({
        value: result?.result?.value,
        description: result?.result?.description,
        type: result?.result?.type,
        exception: result?.exceptionDetails?.text || error?.message || null,
      }));
    });
    (async () => {
      const frameReports = [];
      for (const frame of frames.slice(1, 4)) {
        const values = await inspect(frame, process.env.TRACE_BINARY_DEBUGGER_FRAME_EXPR || `(() => {
          const read = (name) => { try { const value = eval(name); return { ok: true, type: typeof value, tag: Object.prototype.toString.call(value), string: typeof value === "string" ? value.slice(0, 320) : null, number: typeof value === "number" ? value : null, keys: value && (typeof value === "object" || typeof value === "function") ? Object.keys(value).slice(0, 24) : [] }; } catch (error) { return { ok: false, error: String(error) }; } };
          const call = (name) => { try { const value = eval(name + "()"); return { ok: true, type: typeof value, tag: Object.prototype.toString.call(value), string: typeof value === "string" ? value.slice(0, 320) : null, number: typeof value === "number" ? value : null, keys: value && (typeof value === "object" || typeof value === "function") ? Object.keys(value).slice(0, 24) : [] }; } catch (error) { return { ok: false, error: String(error) }; } };
          const describeArgs = () => { try { return Array.from(arguments).map((value) => ({ type: typeof value, tag: Object.prototype.toString.call(value), string: typeof value === "string" ? value.slice(0, 320) : null, number: typeof value === "number" ? value : null, keys: value && (typeof value === "object" || typeof value === "function") ? Object.keys(value).slice(0, 24) : [] })); } catch (error) { return [{ error: String(error) }]; } };
          return { A: read("A"), A_source: read("String(A)"), A_call: call("A"), B: read("B"), B_source: read("String(B)"), B_call: call("B"), Q: read("Q"), Q_source: read("String(Q)"), Q_call: call("Q"), g: read("g"), E: read("E"), arguments: read("arguments"), argument_values: describeArgs(), this: read("this") };
        })()`);
        frameReports.push({ function_name: frame.functionName, url: frame.url, line: frame.location?.lineNumber, column: frame.location?.columnNumber, scopes: frame.scopeChain?.map((scope) => ({ type: scope.type, name: scope.name || null, object_id: scope.object?.objectId || null })), values });
      }
      let expressionResult = null;
      if (binaryDebuggerExpression && frames[0]) {
        expressionResult = await inspect(frames[0], binaryDebuggerExpression);
      }
      process.stderr.write(`${JSON.stringify({ binary_debugger: true, reason: message.params.reason, frames: frameReports, expression: expressionResult })}\n`);
      binaryDebuggerSession.post("Debugger.resume");
    })().catch(() => binaryDebuggerSession.post("Debugger.resume"));
  });
}
function summarizeBinary(value) {
  let bytes;
  if (typeof value === "string") bytes = Buffer.from(value, "utf8");
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else return { type: typeof value, value: String(value).slice(0, 120) };
  return {
    byte_length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    head_hex: bytes.subarray(0, 32).toString("hex"),
  };
}
function logBinaryStage(stage, input, output = undefined) {
  if (!binaryStageLog) return;
  const record = { stage, input: summarizeBinary(input) };
  if (output !== undefined) record.output = summarizeBinary(output);
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
const recordVmOperands = process.env.RECORD_VM_OPERANDS === "1";
const quietVmExceptions = process.env.QUIET_VM_EXCEPTIONS === "1";
function nativeHostFunction(name, implementation) {
  nativeSources.set(implementation, `function ${name}() { [native code] }`);
  return implementation;
}

if (process.env.RECORD_VM_EXCEPTIONS === "1") {
  const session = new inspector.Session();
  session.connect();
  session.post("Debugger.enable");
  session.post("Debugger.setPauseOnExceptions", { state: "all" });
  session.on("Debugger.paused", (message) => {
    const top = message.params.callFrames?.[0];
    const exception = message.params.data?.description || message.params.data?.value || "";
    const summary = { reason: message.params.reason, exception, function: top?.functionName, line: top?.location?.lineNumber, column: top?.location?.columnNumber };
    const functionCallError = String(exception).includes("is not a function");
    const constructorOrPrototypeError = /not a constructor|reading 'prototype'|reading 'rtt'|reading 'loadTimes'|contentWindow/.test(String(exception));
    const vmMemberCall = top?.location?.lineNumber === 0 && top?.location?.columnNumber === 689928;
    if (quietVmExceptions && !functionCallError && !(recordVmOperands && vmMemberCall)) {
      session.post("Debugger.resume");
      return;
    }
    if ([694451, 696997].includes(top?.location?.columnNumber) || functionCallError || constructorOrPrototypeError || (recordVmOperands && vmMemberCall)) {
      session.post("Debugger.evaluateOnCallFrame", {
        callFrameId: top.callFrameId,
        expression: "(() => { const read = source => { try { return {ok:true,value:eval(source)} } catch(error) { return {ok:false,error:String(error)} } }; const describe = value => { try { return {type:typeof value,tag:Object.prototype.toString.call(value),name:typeof value==='function'?value.name:null,keys:Object.keys(value).slice(0,30),own:value==null?[]:Object.getOwnPropertyNames(value).slice(0,30),constructor:value?.constructor?.name || null,prototype:value==null?null:Object.getPrototypeOf(value)?.constructor?.name || null} } catch(error) { return {error:String(error)} } }; const variables=['A','Q','B','E'].map(name=>({name,value:read(name),called:read(name+'()')})); const receiver=read('A()'); const member=read('Q()'); return {receiver:receiver.ok?describe(receiver.value):receiver, receiver_identity:receiver.ok?{canvas_constructor:receiver.value===HTMLCanvasElement,canvas_prototype:receiver.value===HTMLCanvasElement.prototype,canvas_to_data_url:receiver.value===HTMLCanvasElement.prototype.toDataURL}:null, member:member.ok?{value:String(member.value),details:receiver.ok?describe(receiver.value?.[member.value]):null}:member, variables:variables.map(item=>({name:item.name,value:item.value.ok?describe(item.value.value):item.value,called:item.called.ok?describe(item.called.value):item.called}))} })()",
        returnByValue: true,
      }, (_error, result) => {
        summary.operands = result?.result?.value || result?.result?.description;
        process.stderr.write(`${JSON.stringify(summary)}\\n`);
        session.post("Debugger.resume");
      });
      return;
    }
    if (top?.location?.lineNumber === 1 && top.location.columnNumber === 114404) {
      session.post("Debugger.evaluateOnCallFrame", {
        callFrameId: top.callFrameId,
        expression: "({receiver: (() => { try { const v=_0x3c6aea; return {type:typeof v, tag:Object.prototype.toString.call(v), keys:Object.keys(v).slice(0,30), prototype:v?.constructor?.name || null} } catch(e) { return String(e) } })(), decoder_source: (() => { try { return String(_0x113693).slice(0,400) } catch(e) { return String(e) } })()})",
        returnByValue: true,
      }, (_error, result) => {
        summary.operands = result?.result?.value || result?.result?.description;
        process.stderr.write(`${JSON.stringify(summary)}\\n`);
        session.post("Debugger.resume");
      });
      return;
    }
    process.stderr.write(`${JSON.stringify(summary)}\n`);
    session.post("Debugger.resume");
  });
}

const runtimeDataPath = process.env.REESE84_RUNTIME_DATA
  || path.join(__dirname, "reese84-runtime-data.js");
const runtimeData = require(runtimeDataPath);
const runtimeReplay = runtimeData.replay || {};

function traceCookiesBeforeRlyRequest() {
  const snapshot = runtimeReplay.cookieSnapshot || "";
  return new Map(snapshot.split(/;\s*/).flatMap((pair) => {
    const split = pair.indexOf("=");
    return split > 0 ? [[pair.slice(0, split), pair.slice(split + 1)]] : [];
  }));
}

const environmentContract = runtimeData.environmentContract;
const recordedCalls = new Map();
let recordedIframeLoadBudget = Number(runtimeReplay.iframeLoadBudget || 0);
// DOM events are global to the page.  The local rly host must replay only the
// API results caused by the captured rly program, otherwise an unrelated
// analytics/widget canvas call shifts every later Canvas/WebGL result.
const candidateDomEvents = runtimeReplay.domEvents || [];
const replayRandomValues = runtimeReplay.randomValues || [];
let replayRandomOffset = 0;
let replayRandomFallbacks = 0;
// Fixed-vector alignment replays the browser's Math.random sequence.  Live
// local generation opts into fresh randomness so per-run fields such as `cr`
// and the encrypted p payload are newly produced by the original challenge.
const useFreshRandom = process.env.REPLAY_FRESH_RANDOM === "1";
// Date.now() is consumed during the rly bootstrap before the first binary
// TextEncoder call. Keep the complete rly time window, just like random
// replay, so the local challenge does not fall through to host wall-clock time.
const replayTimeValues = runtimeReplay.timeValues || [];
let replayTimeOffset = 0;
let replayTimeFallbacks = 0;
function nextTraceTime() {
  if (replayTimeOffset < replayTimeValues.length) return replayTimeValues[replayTimeOffset++];
  replayTimeFallbacks += 1;
  return Date.now();
}
function nextTraceRandom() {
  if (useFreshRandom) {
    replayRandomFallbacks += 1;
    if (process.env.TRACE_RANDOM_STACKS === "1") {
      process.stderr.write(JSON.stringify({ random_index: replayRandomFallbacks, source: "fresh", stack: new Error().stack }) + "\n");
    }
    return Math.random();
  }
  if (replayRandomOffset < replayRandomValues.length) {
    const value = replayRandomValues[replayRandomOffset++];
    if (process.env.TRACE_RANDOM_STACKS === "1") {
      process.stderr.write(JSON.stringify({ random_index: replayRandomOffset, source: "trace", stack: new Error().stack }) + "\n");
    }
    return value;
  }
  replayRandomFallbacks += 1;
  if (process.env.TRACE_RANDOM_STACKS === "1") {
    process.stderr.write(JSON.stringify({ random_index: replayRandomOffset + replayRandomFallbacks, source: "fallback", stack: new Error().stack }) + "\n");
  }
  return Math.random();
}
for (const event of candidateDomEvents) {
  // Boundary JS capture can omit an interpreted inner-frame call id while the
  // DOM event retains it.  Keep the complete DOM/BOM sequence inside the rly
  // generation window as a fallback.  Restricting this exception to WebGL
  // drops critical unscoped inputs such as TextEncoder, btoa/atob, timers,
  // Navigator and Performance calls, which then changes the first encrypted
  // byte even though the trace has the evidence.
  if (!event.interface || !event.member) continue;
  const api = `${event.interface}.${event.member}`;
  const calls = recordedCalls.get(api) || [];
  calls.push(event);
  recordedCalls.set(api, calls);
}
for (const calls of recordedCalls.values()) {
  // New traces carry the hook-entry sequence, which remains exact when two
  // calls share a microsecond or an artifact is flushed later. Older traces
  // fall back to their timestamps.
  calls.sort((left, right) => {
    if (Number.isFinite(left.event_seq) && Number.isFinite(right.event_seq)) {
      return left.event_seq - right.event_seq;
    }
    return (left.ts_us || 0) - (right.ts_us || 0);
  });
}
const recordedOffsets = new Map();
function materializeRecordedResult(entry) {
  if (entry.value_kind === "undefined") return undefined;
  if (entry.value_kind === "null") return null;
  if (entry.value_kind === "boolean") return entry.value_preview === "true";
  if (entry.value_kind === "number") return Number(entry.value_preview);
  if (entry.value_kind === "string") {
    return entry.value_embedded ?? String(entry.value_preview ?? "");
  }
  return objectResult(entry.value_preview, entry.object_values);
}
function objectResult(kind, values = {}) {
  // A trace confirms an object's brand, not that its fields are zero or a
  // collection is empty. Exact fields are supplied only by trace/live data.
  const indexed = Object.entries(values || {})
    .filter(([key, descriptor]) => /^\d+$/.test(key) && descriptor &&
      ["number", "string", "boolean"].includes(descriptor.kind));
  if (kind === "Array") {
    const array = [];
    for (const [key, descriptor] of indexed) {
      array[Number(key)] = descriptor.kind === "number" ? Number(descriptor.preview)
        : descriptor.kind === "boolean" ? descriptor.preview === "true" : descriptor.preview;
    }
    return array;
  }
  const typed = { Float32Array, Int32Array, Uint8Array, Uint8ClampedArray }[kind];
  if (typed) {
    const length = Number(values?.length?.preview);
    if (Number.isInteger(length) && length >= 0 && length <= 256) {
      const array = new typed(length);
      for (const [key, descriptor] of indexed) array[Number(key)] = Number(descriptor.preview);
      return array;
    }
  }
  if (kind === "TextMetrics") {
    const object = Object.create(interfaces.TextMetrics);
    const state = {};
    for (const [key, descriptor] of Object.entries(values || {})) {
      if (!descriptor) continue;
      if (descriptor.kind === "number") state[key] = Number(descriptor.preview);
      else if (descriptor.kind === "boolean") state[key] = descriptor.preview === "true";
      else if (descriptor.kind === "string") state[key] = descriptor.preview;
    }
    textMetricsState.set(object, state);
    return object;
  }
  if (kind === "ImageData") {
    const object = Object.create(interfaces.ImageData);
    const state = {};
    for (const [key, descriptor] of Object.entries(values || {})) {
      if (!descriptor) continue;
      if (descriptor.kind === "number") state[key] = Number(descriptor.preview);
      else if (descriptor.kind === "object" && descriptor.object_values) {
        state[key] = objectResult(descriptor.preview, descriptor.object_values);
      }
    }
    imageDataState.set(object, state);
    return object;
  }
  if (kind === "WebGLShaderPrecisionFormat") {
    const object = Object.create(interfaces.WebGLShaderPrecisionFormat);
    const state = {};
    for (const [key, descriptor] of Object.entries(values || {})) {
      if (descriptor?.kind === "number") state[key] = Number(descriptor.preview);
    }
    webglShaderPrecisionState.set(object, state);
    return object;
  }
  if (kind === "EXT_texture_filter_anisotropic") {
    return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff };
  }
  if (kind === "WEBGL_debug_renderer_info") {
    return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
  }
  const object = Object.create(interfaces[kind] || Object.prototype);
  for (const [key, descriptor] of Object.entries(values || {})) {
    if (!descriptor) continue;
    const value = descriptor.kind === "number" ? Number(descriptor.preview)
      : descriptor.kind === "boolean" ? descriptor.preview === "true"
      : descriptor.kind === "string" ? descriptor.preview
      : descriptor.kind === "object" && descriptor.object_values
        ? objectResult(descriptor.preview, descriptor.object_values)
        : undefined;
    if (value === undefined) continue;
    Object.defineProperty(object, key, { configurable: true, enumerable: true, value });
  }
  return object;
}
function recordedResult(api) {
  const offset = recordedOffsets.get(api) || 0;
  const entry = recordedCalls.get(api)?.[offset];
  if (!entry) throw new Error(`Missing recorded browser API call: ${api}`);
  recordedOffsets.set(api, offset + 1);
  return materializeRecordedResult(entry);
}
function consumeRecorded(api, fallback) {
  const next = recordedCalls.get(api)?.[recordedOffsets.get(api) || 0];
  if (!next) return { found: false, value: fallback, entry: null };
  return { found: true, value: recordedResult(api), entry: next };
}
function consumeRecordedArgument(api, argument, fallback) {
  const entries = recordedCalls.get(api) || [];
  const offset = recordedOffsets.get(api) || 0;
  const expected = String(argument);
  const index = entries.findIndex((entry, entryIndex) =>
    entryIndex >= offset && String(entry.args?.[0]?.preview ?? "") === expected);
  if (index < 0) return { found: false, value: fallback, entry: null };
  recordedOffsets.set(api, index + 1);
  const entry = entries[index];
  return { found: true, value: materializeRecordedResult(entry), entry };
}
function replayGetter(target, property, api, fallback, materialize = (value) => value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  let currentValue = fallback;
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      const result = consumeRecorded(api, fallback);
      if (process.env.TRACE_HOST_ACCESS === "1") {
        hostApiCalls.push({ api, operation: "get", replayed: result.found, value_kind: result.entry?.value_kind || null, value_preview: result.entry?.value_preview ?? null });
      }
      return result.found ? materialize(result.value, result.entry) : currentValue;
    },
    set(value) {
      currentValue = value;
    },
  });
}
function replayCall(api, fallback, materialize = (value) => value) {
  const result = consumeRecorded(api, fallback);
  if (process.env.TRACE_HOST_ACCESS === "1") {
    hostApiCalls.push({
      api,
      operation: "call",
      replayed: result.found,
      value_kind: result.entry?.value_kind || null,
      value_preview: result.entry?.value_preview ?? null,
    });
  }
  return result.found ? materialize(result.value, result.entry) : fallback;
}
function replayConsumptionReport() {
  const apis = [...recordedCalls.entries()].map(([api, events]) => {
    const consumed = recordedOffsets.get(api) || 0;
    const firstUnconsumed = events[consumed];
    return {
      api,
      captured: events.length,
      consumed,
      unconsumed: Math.max(0, events.length - consumed),
      first_unconsumed: firstUnconsumed
        ? {
            type: firstUnconsumed.type,
            ts_us: firstUnconsumed.ts_us,
            origin_call_id: firstUnconsumed.origin_call_id || null,
            value_kind: firstUnconsumed.value_kind || null,
            value_preview: firstUnconsumed.value_preview ?? null,
          }
        : null,
    };
  }).sort((left, right) =>
    right.unconsumed - left.unconsumed || right.captured - left.captured || left.api.localeCompare(right.api));
  return {
    total_captured: apis.reduce((sum, item) => sum + item.captured, 0),
    total_consumed: apis.reduce((sum, item) => sum + item.consumed, 0),
    total_unconsumed: apis.reduce((sum, item) => sum + item.unconsumed, 0),
    apis,
  };
}
function firstRecordedResult(api, fallback) {
  const entry = recordedCalls.get(api)?.[0];
  return entry ? materializeRecordedResult(entry) : fallback;
}
function traceValue(interfaceName, member, fallback) {
  const entry = environmentContract.values[`${interfaceName}.${member}`];
  if (!entry?.restorable) return fallback;
  if (entry.value_kind === "number") return Number(entry.value);
  if (entry.value_kind === "boolean") return entry.value === "true";
  if (entry.value_kind === "string") {
    return entry.value_embedded ?? entry.value;
  }
  return entry.value;
}
const interfaces = {};
const hostConstructors = {};
let replayWindowProxy = null;
function defineInterface(name, parent = Object.prototype) {
  const prototype = Object.create(parent);
  const constructor = nativeHostFunction(name, function FirefoxTraceHostInterface() {});
  Object.defineProperty(constructor, "name", { value: name });
  Object.defineProperty(constructor, "prototype", { value: prototype });
  Object.defineProperty(prototype, "constructor", { value: constructor });
  Object.defineProperty(prototype, Symbol.toStringTag, { value: name });
  interfaces[name] = prototype;
  hostConstructors[name] = constructor;
}
defineInterface("EventTarget");
defineInterface("Node", interfaces.EventTarget);
defineInterface("Element", interfaces.Node);
defineInterface("HTMLElement", interfaces.Element);
defineInterface("CharacterData", interfaces.Node);
defineInterface("Text", interfaces.CharacterData);
defineInterface("HTMLCanvasElement", interfaces.HTMLElement);
defineInterface("HTMLIFrameElement", interfaces.HTMLElement);
defineInterface("HTMLAudioElement", interfaces.HTMLElement);
defineInterface("HTMLVideoElement", interfaces.HTMLElement);
defineInterface("HTMLDivElement", interfaces.HTMLElement);
defineInterface("HTMLScriptElement", interfaces.HTMLElement);
defineInterface("HTMLBodyElement", interfaces.HTMLElement);
defineInterface("HTMLHeadElement", interfaces.HTMLElement);
defineInterface("HTMLHtmlElement", interfaces.HTMLElement);
defineInterface("Document", interfaces.Node);
defineInterface("Event");
defineInterface("Attr");
defineInterface("DOMImplementation");
defineInterface("Window", interfaces.EventTarget);
defineInterface("Navigator");
defineInterface("LockManager");
defineInterface("PermissionStatus", interfaces.EventTarget);
defineInterface("PluginArray");
defineInterface("MimeTypeArray");
defineInterface("Plugin");
defineInterface("MimeType");
defineInterface("HTMLCollection");
defineInterface("CSS2Properties");
defineInterface("External");
defineInterface("BarProp");
defineInterface("CustomElementRegistry");
defineInterface("CanvasRenderingContext2D");
defineInterface("WebGL2RenderingContext");
defineInterface("TextMetrics");
defineInterface("ImageData");
defineInterface("WebGLShaderPrecisionFormat");
defineInterface("WebGLBuffer");
defineInterface("WebGLProgram");
defineInterface("WebGLShader");
defineInterface("WebGLUniformLocation");
defineInterface("VisualViewport");
defineInterface("Screen");
defineInterface("ScreenOrientation");
defineInterface("Location");
defineInterface("History");
defineInterface("Performance");
// TextMetrics fields are Firefox prototype accessors.  Keeping the values on
// the returned object itself hides missing fields such as actualBoundingBoxLeft
// and makes descriptor/brand probes observe a Node-shaped object.
const textMetricsState = new WeakMap();
const imageDataState = new WeakMap();
const webglShaderPrecisionState = new WeakMap();
const permissionStatusState = new WeakMap();
const htmlCollectionState = new WeakMap();
function defineTraceObjectAccessor(prototype, interfaceName, member, stateMap) {
  Object.defineProperty(prototype, member, {
    configurable: true,
    enumerable: true,
    get: nativeHostFunction(`get ${member}`, function traceObjectAccessor() {
      const state = stateMap.get(this) || {};
      const fallback = state[member];
      const result = consumeRecorded(`${interfaceName}.${member}`, fallback);
      return result.found ? result.value : fallback;
    }),
  });
}
const textMetricsMembers = [
  "width", "actualBoundingBoxAscent", "actualBoundingBoxDescent",
  "fontBoundingBoxAscent", "fontBoundingBoxDescent",
  "actualBoundingBoxLeft", "actualBoundingBoxRight",
];
for (const member of textMetricsMembers) {
  Object.defineProperty(interfaces.TextMetrics, member, {
    configurable: true,
    enumerable: true,
    get: nativeHostFunction(`get ${member}`, function textMetricsGetter() {
      const state = textMetricsState.get(this) || {};
      // measureText() returns a fresh object. Its object_values snapshot is
      // therefore a stronger association than the page-global getter queue:
      // the latter used to contain Trace's own snapshot reads interleaved with
      // page reads. Prefer the value bound to this exact result object and use
      // the getter stream only for fields absent from an older snapshot.
      if (Object.prototype.hasOwnProperty.call(state, member)) {
        return state[member];
      }
      const result = consumeRecorded(`TextMetrics.${member}`, undefined);
      return result.found ? result.value : undefined;
    }),
  });
}
for (const member of ["width", "height", "data"]) {
  defineTraceObjectAccessor(interfaces.ImageData, "ImageData", member, imageDataState);
}
for (const member of ["rangeMin", "rangeMax", "precision"]) {
  defineTraceObjectAccessor(interfaces.WebGLShaderPrecisionFormat, "WebGLShaderPrecisionFormat", member, webglShaderPrecisionState);
}
defineTraceObjectAccessor(interfaces.PermissionStatus, "PermissionStatus", "state", permissionStatusState);
defineTraceObjectAccessor(interfaces.HTMLCollection, "HTMLCollection", "length", htmlCollectionState);
// Firefox exposes these DOM members as prototype accessors.  Keep state on
// the reconstructed node so the host preserves the browser's descriptor
// shape instead of creating enumerable per-instance data properties.
const domAccessorState = new WeakMap();
const nativeDomAccessorKeys = new Set([
  "Element.childElementCount", "Element.firstElementChild", "Element.innerHTML",
  "Element.namespaceURI", "Element.outerHTML", "Element.shadowRoot",
  "HTMLElement.dir", "HTMLElement.innerText", "HTMLScriptElement.innerText",
]);
function domState(receiver) {
  let state = domAccessorState.get(receiver);
  if (!state) {
    state = { tagName: String(receiver?.tagName || "DIV").toLowerCase(), children: [], innerHTML: "", outerHTML: null, dir: "", innerText: "" };
    domAccessorState.set(receiver, state);
  }
  return state;
}
function defineNativeDomAccessor(prototype, member, read, write = null) {
  const descriptor = {
    configurable: true,
    enumerable: true,
    get: nativeHostFunction(`get ${member}`, function domAccessorGetter() { return read(this); }),
  };
  if (write) descriptor.set = nativeHostFunction(`set ${member}`, function domAccessorSetter(value) { write(this, value); });
  Object.defineProperty(prototype, member, descriptor);
}
defineNativeDomAccessor(interfaces.Element, "childElementCount", (receiver) => domState(receiver).children.length);
defineNativeDomAccessor(interfaces.Element, "firstElementChild", (receiver) => domState(receiver).children[0] ?? null);
defineNativeDomAccessor(interfaces.Element, "innerHTML", (receiver) => domState(receiver).innerHTML, (receiver, value) => {
  const state = domState(receiver);
  state.innerHTML = String(value ?? "");
  state.children = [];
});
defineNativeDomAccessor(interfaces.Element, "namespaceURI", () => "http://www.w3.org/1999/xhtml");
defineNativeDomAccessor(interfaces.Element, "outerHTML", (receiver) => {
  const state = domState(receiver);
  return state.outerHTML ?? `<${state.tagName}></${state.tagName}>`;
}, (receiver, value) => { domState(receiver).outerHTML = String(value ?? ""); });
defineNativeDomAccessor(interfaces.Element, "shadowRoot", () => null);
defineNativeDomAccessor(interfaces.HTMLElement, "dir", (receiver) => domState(receiver).dir, (receiver, value) => { domState(receiver).dir = String(value ?? ""); });
defineNativeDomAccessor(interfaces.HTMLElement, "innerText", (receiver) => domState(receiver).innerText, (receiver, value) => { domState(receiver).innerText = String(value ?? ""); });
defineNativeDomAccessor(interfaces.HTMLScriptElement, "innerText", (receiver) => domState(receiver).innerText, (receiver, value) => { domState(receiver).innerText = String(value ?? ""); });
// DOM calls are dispatched through the browser prototype, not as ad-hoc own
// methods on the reconstructed node. Keep the native brand and consume the
// recorded result so feature checks see Element.prototype.getAttribute.
interfaces.Element.getAttribute = nativeHostFunction("getAttribute", function getAttribute() {
  return consumeRecordedArgument("Element.getAttribute", arguments[0], null).value;
});
interfaces.Element.setAttribute = nativeHostFunction("setAttribute", function setAttribute(name, value) {
  replayCall("Element.setAttribute", undefined);
  if (this && typeof name === "string") this[name] = String(value ?? "");
});
function hydrateTrace(target, interfaceName) {
  if (interfaceName === "Navigator" && process.env.REPLAY_NAVIGATOR_SHAPE === "1") return target;
  for (const [key, entry] of Object.entries(environmentContract.values)) {
    if (entry.restorable && key.startsWith(`${interfaceName}.`) && !nativeDomAccessorKeys.has(key)) {
      target[entry.member] = traceValue(interfaceName, entry.member, target[entry.member]);
    }
  }
  return target;
}
function hydrateWindowSnapshot(target) {
  // The first rly call snapshots the top-level Window before it starts the
  // fingerprint chain.  Recreate the observed member shape so missing
  // functions do not turn into a different anti-automation branch.
  const snapshot = runtimeReplay.windowSnapshot;
  if (!snapshot?.props) return;
  const materialize = (key, descriptor) => {
    if (!descriptor) return undefined;
    const type = descriptor.type;
    if (type === "undefined") return undefined;
    if (type === "null") return null;
    if (type === "boolean") return descriptor.preview === "true";
    if (type === "number") return Number(descriptor.preview);
    if (type === "string") {
      return descriptor.value_embedded ?? String(descriptor.preview ?? "");
    }
    if (type !== "object") return undefined;
    if (descriptor.preview === "Function") {
      return nativeHostFunction(key, function windowSnapshotMember() {});
    }
    if (key === "clientInformation") return target.navigator;
    if (key === "self" || key === "frames" || key === "parent") return target;
    const interfaceName = descriptor.preview;
    const initial = Object.create(interfaces[interfaceName] || Object.prototype);
    return hostObject(`window.${key}`, initial, false);
  };
  for (const property of snapshot.props) {
    const key = property.key;
    if (!key || key in target) continue;
    const value = materialize(key, property.value);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
}
const challengeRecord = runtimeData.challengeRecord;
// Debugger captures may contain a fresh, per-session rly program.  Keeping the
// trace contract while swapping only that program lets us locate host drift.
const challengeSource = process.env.CHALLENGE_SOURCE || null;
if (!challengeSource && !runtimeData.challengeSource) {
  throw new Error("Embedded rly challenge script was not found.");
}
const challengeSourceLabel = challengeSource || challengeRecord.artifact_path || "embedded-rly.js";

const challengePath = new URL(challengeRecord.final_url || challengeRecord.url).pathname
  + new URL(challengeRecord.final_url || challengeRecord.url).search;
const missingHostAccesses = [];
const observedHostAccesses = [];
const hostEventRegistrations = [];
const hostEventDispatches = [];
const hostEventErrors = [];
const hostNodeInsertions = [];
const hostApiCalls = [];
let windowAccessLogCount = 0;
const performanceNowCalls = [];
let performanceNowCallCount = 0;
let deterministicPerformanceNow = null;
const deterministicPerformanceStart = Number(process.env.TRACE_PERFORMANCE_NOW_START || "2542");
const hostMutationObservations = [];
const mutationObservers = [];
function observeHost(label, value) {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (!(property in target)) observedHostAccesses.push(`${label}.${String(property)}`);
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
function hostObject(label, initial = {}, synthesizeMissing = true) {
  let proxy;
  const target = Object.create(Object.getPrototypeOf(initial));
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(initial));
  proxy = new Proxy(target, {
    get(object, property, receiver) {
      if (property in object) return Reflect.get(object, property, receiver);
      if (property === Symbol.toPrimitive) return () => "";
      if (property === Symbol.iterator) return function* iterator() {};
      if (property === "toString" || property === "valueOf") return () => "";
      const name = `${label}.${String(property)}`;
      missingHostAccesses.push(name);
      if (!synthesizeMissing) return undefined;
      const fallback = function hostMethod() { return proxy; };
      Object.defineProperty(object, property, { configurable: true, value: fallback });
      return fallback;
    },
    set(object, property, value) {
      if (process.env.DEBUG_DOM_HOOK === "1" && typeof property === "string" && property.includes("insertBefore")) {
        process.stderr.write(`${JSON.stringify({ host: label, property, value_type: typeof value, value: typeof value === "function" ? String(value).slice(0, 100) : value })}\n`);
      }
      if (typeof property === "string" && property.startsWith("insertBefore_") && typeof value !== "function") {
        return true;
      }
      let owner = object;
      while (owner) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, property);
        if (descriptor) {
          if (typeof descriptor.set === "function") {
            descriptor.set.call(proxy, value);
            return true;
          }
          break;
        }
        owner = Object.getPrototypeOf(owner);
      }
      Object.defineProperty(object, property, { configurable: true, enumerable: true, writable: true, value });
      return true;
    },
  });
  return proxy;
}
function makeCollection(label, entries = []) {
  const collection = hostObject(label, {
    item(index) { return entries[Number(index)] ?? null; },
    namedItem() { return null; },
    [Symbol.iterator]: function* iterator() { yield* entries; },
  }, false);
  htmlCollectionState.set(collection, { length: entries.length });
  entries.forEach((entry, index) => { collection[index] = entry; });
  Object.setPrototypeOf(collection, interfaces.HTMLCollection);
  return collection;
}
function traceRlyPrimitive(interfaceName, member, fallback) {
  for (const event of candidateDomEvents) {
    if (event.interface !== interfaceName || event.member !== member || !event.rly_origin) continue;
    if (event.value_kind === "string") return event.value_preview ?? fallback;
    if (event.value_kind === "number") return Number(event.value_preview);
    if (event.value_kind === "boolean") return event.value_preview === "true";
  }
  return fallback;
}
function parseBrowserLiveValues(evidencePath) {
  try {
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    return evidence && typeof evidence === "object" ? evidence : null;
  } catch {
    return null;
  }
}
function loadBrowserLiveValues() {
  const currentUA = environmentContract.values?.["Navigator.userAgent"]?.value;
  if (!currentUA) return { values: {}, source: null };
  if (runtimeData.browserLiveValues?.navigator_user_agent === currentUA) {
    return { values: runtimeData.browserLiveValues, source: "embedded-runtime-data" };
  }
  return { values: {}, source: null };
}
const browserLiveEvidence = loadBrowserLiveValues();
const browserLiveValues = browserLiveEvidence.values;

// Firefox exposes a stable, ordered Navigator.prototype surface.  The rly
// self-check enumerates this prototype before reading the navigator instance;
// a plain Node prototype therefore takes a different branch even when all
// scalar navigator values are correct.  Install only the members confirmed by
// the Firefox console sidecar, and keep the probe opt-in while comparing a
// trace.  Instance values continue to come from the trace/live-value replay.
function installNavigatorPrototypeShape() {
  if (process.env.REPLAY_NAVIGATOR_SHAPE !== "1") return;
  const keys = browserLiveValues.keysets?.navigatorPrototype;
  if (!Array.isArray(keys) || keys.length < 2 || !keys.includes("constructor")) return;
  const prototype = Object.create(Object.prototype);
  const methodKeys = new Set(keys.slice(0, 9));
  for (const key of keys) {
    if (key === "constructor") {
      Object.defineProperty(prototype, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: hostConstructors.Navigator,
      });
      continue;
    }
    if (methodKeys.has(key)) {
      Object.defineProperty(prototype, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: nativeHostFunction(key, function navigatorPrototypeMethod() {}),
      });
      continue;
    }
    // Firefox exposes the remaining members as accessors.  The rly shape
    // probe inspects the descriptor; instance reads are handled by the own
    // replay getters installed below, so this accessor does not invent a
    // value for the prototype receiver.
    Object.defineProperty(prototype, key, {
      configurable: true,
      enumerable: true,
      get: nativeHostFunction(`get ${key}`, function navigatorPrototypeGetter() {}),
    });
  }
  interfaces.Navigator = prototype;
  Object.defineProperty(hostConstructors.Navigator, "prototype", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: prototype,
  });
}

installNavigatorPrototypeShape();

function installWindowApiShape() {
  if (process.env.REPLAY_WINDOW_API_SHAPE !== "1") return null;
  const configured = process.env.REPLAY_WINDOW_API_KEYS
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const keys = Array.isArray(browserLiveValues.window_api_keys) && browserLiveValues.window_api_keys.length
    ? browserLiveValues.window_api_keys
    : configured;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const api = hostObject("window.api", {}, false);
  for (const key of keys) {
    Object.defineProperty(api, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: hostObject(`window.api.${key}`, {}, false),
    });
  }
  return api;
}

const windowApiShape = installWindowApiShape();

const scriptElement = hostObject("script", {
  src: challengePath,
  className: "", id: "", tagName: "SCRIPT",
  clientHeight: 0, clientWidth: 0, scrollLeft: 0, scrollTop: 0,
  scrollWidth: 0, offsetHeight: 0, offsetWidth: 0,
  getAttribute: (name) => name === "src" ? challengePath : null,
  setAttribute() {},
  addEventListener() {},
  removeEventListener() {},
  parentNode: { removeChild() {} },
});
Object.setPrototypeOf(scriptElement, interfaces.HTMLScriptElement);
hydrateTrace(scriptElement, "Element");
hydrateTrace(scriptElement, "HTMLElement");
const traceScriptURLs = Array.isArray(runtimeData.scriptUrls)
  ? runtimeData.scriptUrls
  : [challengeRecord.final_url || challengeRecord.url];
function traceScriptNode(src, index) {
  if (src === challengeRecord.final_url || src === challengeRecord.url) return scriptElement;
  const node = hostObject(`document.scripts[${index}]`, {
    src, async: false, defer: false, type: "", noModule: false,
    id: "", className: "", tagName: "SCRIPT",
    getAttribute(name) { return String(name).toLowerCase() === "src" ? src : null; },
  }, false);
  Object.setPrototypeOf(node, interfaces.HTMLScriptElement);
  return node;
}
const traceScriptNodes = traceScriptURLs.map(traceScriptNode);
function recordedContext(api, interfaceName) {
  const target = Object.create(interfaces[interfaceName] || Object.prototype);
  return new Proxy(target, {
    get: (object, property, receiver) => {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (process.env.RECORD_WEBGL_MEMBERS === "1" && api === "WebGL2RenderingContext") {
        process.stderr.write(`${JSON.stringify({ host: api, missing_member: String(property) })}\n`);
      }
      const memberApi = `${api}.${String(property)}`;
      const next = recordedCalls.get(memberApi)?.[recordedOffsets.get(memberApi) || 0];
      if (next?.type === "dom.get") return recordedResult(memberApi);
      if (api === "WebGL2RenderingContext" && property === "getContextAttributes") {
        return () => Object.assign({}, browserLiveValues.webgl2?.contextAttributes || {});
      }
      if (api === "WebGL2RenderingContext" && property === "getExtension") {
        return (name) => Object.assign({}, browserLiveValues.webgl2?.extensions?.[String(name)] || {});
      }
      return (..._args) => recordedResult(memberApi);
    },
  });
}
const canvas2d = recordedContext("CanvasRenderingContext2D", "CanvasRenderingContext2D");
const webgl2 = recordedContext("WebGL2RenderingContext", "WebGL2RenderingContext");
Object.assign(interfaces.WebGL2RenderingContext, {
  ALIASED_LINE_WIDTH_RANGE: 33902, ALIASED_POINT_SIZE_RANGE: 33901,
  ALPHA_BITS: 3413, BLUE_BITS: 3412, DEPTH_BITS: 3414, GREEN_BITS: 3411,
  RED_BITS: 3410, STENCIL_BITS: 3415, ARRAY_BUFFER: 34962, STATIC_DRAW: 35044,
  FLOAT: 5126, RGBA: 6408, UNSIGNED_BYTE: 5121, TRIANGLE_STRIP: 5,
  VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
  LOW_FLOAT: 36336, MEDIUM_FLOAT: 36337, HIGH_FLOAT: 36338,
  LOW_INT: 36339, MEDIUM_INT: 36340, HIGH_INT: 36341,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661, MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
  MAX_FRAGMENT_UNIFORM_VECTORS: 36349, MAX_RENDERBUFFER_SIZE: 34024,
  MAX_TEXTURE_IMAGE_UNITS: 34930, MAX_TEXTURE_SIZE: 3379,
  MAX_VARYING_VECTORS: 36348, MAX_VERTEX_ATTRIBS: 34921,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660, MAX_VERTEX_UNIFORM_VECTORS: 36347,
  MAX_VIEWPORT_DIMS: 3386, RENDERER: 7937, SHADING_LANGUAGE_VERSION: 35724,
  VENDOR: 7936, VERSION: 7938,
});
// The rly program probes methods through both an instance and its prototype.
// A Proxy-only fallback passes direct calls but fails native prototype checks.
for (const member of [
  "getParameter", "getSupportedExtensions", "getShaderPrecisionFormat",
  "createBuffer", "bindBuffer", "bufferData", "createProgram", "createShader",
  "shaderSource", "compileShader", "attachShader", "linkProgram", "useProgram",
  "getAttribLocation", "getUniformLocation", "enableVertexAttribArray",
  "vertexAttribPointer", "uniform2f", "drawArrays", "readPixels",
]) {
  interfaces.WebGL2RenderingContext[member] = nativeHostFunction(member, function webglTraceMethod() {
    hostApiCalls.push({ api: `WebGL2RenderingContext.${member}`, args: [...arguments].map((value) =>
      typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : Object.prototype.toString.call(value)) });
    if (member === "getParameter" && arguments.length === 0 && process.env.RECORD_WEBGL_STACKS === "1") {
      process.stderr.write(JSON.stringify({ api: "WebGL2RenderingContext.getParameter", args: [], stack: new Error().stack }) + "\n");
    }
    if (member === "getParameter" && !recordedCalls.get("WebGL2RenderingContext.getParameter")?.[recordedOffsets.get("WebGL2RenderingContext.getParameter") || 0]) {
      return null;
    }
    return recordedResult(`WebGL2RenderingContext.${member}`);
  });
}
interfaces.WebGL2RenderingContext.getContextAttributes = nativeHostFunction("getContextAttributes", function getContextAttributes() {
  return Object.assign({}, browserLiveValues.webgl2?.contextAttributes || {});
});
interfaces.WebGL2RenderingContext.getExtension = nativeHostFunction("getExtension", function getExtension(name) {
  const value = Object.assign({}, browserLiveValues.webgl2?.extensions?.[String(name)] || {});
  hostApiCalls.push({ api: "WebGL2RenderingContext.getExtension", args: [String(name)], result_keys: Object.keys(value) });
  return value;
});
interfaces.HTMLCanvasElement.getContext = nativeHostFunction("getContext", function getContext(kind) {
  recordedResult("HTMLCanvasElement.getContext");
  const context = kind === "2d" ? canvas2d : (kind === "webgl2" || kind === "webgl") ? webgl2 : null;
  if (context) context.canvas = this;
  return context;
});
interfaces.HTMLCanvasElement.toDataURL = nativeHostFunction("toDataURL", function toDataURL() {
  return recordedResult("HTMLCanvasElement.toDataURL");
});
function attachEventTarget(target, label = "object") {
  const listeners = new Map();
  target.addEventListener = (type, listener) => {
    replayCall("EventTarget.addEventListener", undefined);
    hostEventRegistrations.push({ label, type: String(type) });
    if (typeof listener !== "function") return;
    const entries = listeners.get(type) || [];
    entries.push(listener);
    listeners.set(type, entries);
    // The current trace contains one native iframe load after its listener is
    // registered.  Drive that recorded event even when the lightweight host
    // cannot preserve the browser's internal insertion identity.
    if (label.includes("createElement(iframe)") && type === "load" && recordedIframeLoadBudget > 0) {
      recordedIframeLoadBudget -= 1;
      setTimeout(() => target.dispatchEvent({ type: "load" }), 0);
    }
  };
  target.removeEventListener = (type, listener) => {
    replayCall("EventTarget.removeEventListener", undefined);
    const entries = listeners.get(type) || [];
    listeners.set(type, entries.filter((entry) => entry !== listener));
  };
  target.dispatchEvent = (event) => {
    const payload = typeof event === "string" ? { type: event, target } : { target, ...event };
    const entries = listeners.get(payload.type) || [];
    hostEventDispatches.push({ label, type: payload.type, listener_count: entries.length });
    for (const listener of entries) {
      try { listener.call(target, payload); } catch (error) { hostEventErrors.push({ label, type: payload.type, name: error.name, message: error.message }); }
    }
    if (typeof target[`on${payload.type}`] === "function") {
      try { target[`on${payload.type}`].call(target, payload); } catch (error) { hostEventErrors.push({ label, type: payload.type, name: error.name, message: error.message }); }
    }
    return true;
  };
  return target;
}
function dispatchIframeLoad(node) {
  if (String(node?.tagName || "").toUpperCase() !== "IFRAME") return node;
  setTimeout(() => node.dispatchEvent?.({ type: "load" }), 0);
  return node;
}
function insertNode(container, node, parentNode = null) {
  const member = String(container).endsWith(".insertBefore") ? "insertBefore" : "appendChild";
  replayCall(`Node.${member}`, node);
  hostNodeInsertions.push({
    container,
    node_type: String(node?.tagName || node?.data || typeof node),
  });
  // Keep the log label separate from the DOM relationship.  The challenge
  // removes its temporary iframe through `iframe.parentNode.removeChild(...)`.
  // Assigning the label string here turns that native DOM operation into a
  // String method lookup and causes the first stable-error path.
  if (node && typeof node === "object") node.parentNode = parentNode;
  if (parentNode && node && typeof node.tagName === "string") {
    const children = domState(parentNode).children;
    if (!children.includes(node)) children.push(node);
  }
  return dispatchIframeLoad(node);
}
const hostBridge = {
  elementGetAttribute(_receiver, name) {
    return consumeRecordedArgument("Element.getAttribute", name, null).value;
  },
  elementSetAttribute(receiver, name, value) {
    replayCall("Element.setAttribute", undefined);
    if (receiver && typeof name === "string") receiver[name] = String(value ?? "");
  },
  toBase64(value) {
    hostApiCalls.push({ api: "Uint8Array.toBase64", byte_length: value?.byteLength ?? null });
    logBinaryStage("Uint8Array.toBase64", value);
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  },
  textEncoderEncode(input) {
    // TextEncoder output is part of the binary collection stream.  Replaying
    // the exact recorded Uint8Array keeps the local probe on the same host
    // contract (including any realm/brand-sensitive branch) instead of
    // silently switching to Node's encoder after the first call.
    const text = String(input);
    const recorded = consumeRecordedArgument("TextEncoder.encode", text, null);
    if (recorded.found && recorded.value &&
        (ArrayBuffer.isView(recorded.value) || recorded.value instanceof ArrayBuffer)) {
      const bytes = recorded.value instanceof ArrayBuffer
        ? new Uint8Array(recorded.value)
        : new Uint8Array(recorded.value.buffer, recorded.value.byteOffset,
                         recorded.value.byteLength);
      return [...bytes];
    }
    return [...new TextEncoder().encode(text)];
  },
  canvasGetContext(kind, canvas) {
    hostApiCalls.push({ api: "HTMLCanvasElement.getContext", kind: String(kind) });
    recordedResult("HTMLCanvasElement.getContext");
    const context = kind === "2d" ? canvas2d : (kind === "webgl2" || kind === "webgl") ? webgl2 : null;
    if (context) context.canvas = canvas;
    return context;
  },
  canvasToDataURL() {
    hostApiCalls.push({ api: "HTMLCanvasElement.toDataURL" });
    return recordedResult("HTMLCanvasElement.toDataURL");
  },
  removeChild(receiver, node) {
    replayCall("Node.removeChild", node);
    hostApiCalls.push({ api: "Node.removeChild", receiver: receiver?.constructor?.name || null });
    if (node && typeof node === "object") node.parentNode = null;
    if (receiver && node) {
      const children = domState(receiver).children;
      const index = children.indexOf(node);
      if (index >= 0) children.splice(index, 1);
    }
    return node;
  },
};
function createElement(tagName) {
  const tag = String(tagName).toLowerCase();
  replayCall("Document.createElement", null);
  hostApiCalls.push({ api: "Document.createElement", tag });
  const interfacePrototype = tag === "canvas" ? interfaces.HTMLCanvasElement : tag === "iframe" ? interfaces.HTMLIFrameElement : tag === "audio" ? interfaces.HTMLAudioElement : tag === "video" ? interfaces.HTMLVideoElement : tag === "div" ? interfaces.HTMLDivElement : tag === "script" ? interfaces.HTMLScriptElement : interfaces.HTMLElement;
  const element = hostObject(`document.createElement(${tag})`, attachEventTarget({
    tagName: tag.toUpperCase(), style: {}, dataset: {}, width: 120, height: 150,
    id: "", className: "", clientWidth: 1269, clientHeight: 0, scrollWidth: 386, scrollTop: 0, scrollLeft: 0,
    offsetWidth: 950, checked: false, value: "", firstChild: null, parentNode: null,
    setAttribute(...args) { replayCall("Element.setAttribute", undefined); this[String(args[0])] = String(args[1] ?? ""); },
    getAttribute(...args) { return interfaces.Element.getAttribute.apply(this, args); },
    appendChild(node) { return insertNode(`document.createElement(${tag}).appendChild`, node, this); },
    insertBefore(node) { return insertNode(`document.createElement(${tag}).insertBefore`, node, this); },
    matches: () => false, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 950, height: 250, top: 0, left: 0, right: 950, bottom: 250 }),
  }, `document.createElement(${tag})`));
  Object.setPrototypeOf(element, interfacePrototype);
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    get: () => {
      const next = recordedCalls.get("HTMLElement.offsetHeight")?.[recordedOffsets.get("HTMLElement.offsetHeight") || 0];
      return next ? recordedResult("HTMLElement.offsetHeight") : 0;
    },
  });
  Object.setPrototypeOf(element.style, interfaces.CSS2Properties);
  hydrateTrace(element, "Element");
  hydrateTrace(element, "HTMLElement");
  if (tag === "canvas") {
    element.getContext = interfaces.HTMLCanvasElement.getContext;
    element.toDataURL = interfaces.HTMLCanvasElement.toDataURL;
  }
  if (tag === "iframe") {
    element.contentDocument = documentHost;
    Object.defineProperty(element, "contentWindow", {
      configurable: true,
      enumerable: true,
      get: () => replayWindowProxy || windowHost,
    });
  }
  if (tag === "video" || tag === "audio") {
    // Firefox BiDi confirms the normal rly codec probes return "maybe" and
    // the empty MIME probe returns "".
    element.canPlayType = (mime) => String(mime || "") ? "maybe" : "";
  }
  return element;
}
function createTextNode(data = "") {
  let content = String(data);
  replayCall("Document.createTextNode", null);
  const text = hostObject("document.createTextNode", {
    parentNode: null, tagName: undefined,
    remove() {},
  });
  const setContent = (value) => {
    content = String(value);
    for (const observer of mutationObservers) {
      if (observer.target === text && observer.options?.characterData) {
        queueMicrotask(() => observer.callback([{ type: "characterData", target: text }], observer.instance));
      }
    }
  };
  Object.defineProperties(text, {
    data: { configurable: true, get: () => content, set: setContent },
    textContent: { configurable: true, get: () => content, set: setContent },
    nodeValue: { configurable: true, get: () => content, set: setContent },
  });
  Object.setPrototypeOf(text, interfaces.Text);
  return text;
}
const tracePerformanceTimeOrigin = traceValue("Performance", "timeOrigin", 0);
const traceNavigationStart = traceValue("PerformanceTiming", "navigationStart", tracePerformanceTimeOrigin);
const history = { length: traceValue("History", "length", 1), state: null, replaceState() {} };
Object.setPrototypeOf(history, interfaces.History);
hydrateTrace(history, "History");
const unresolvedBrowserApi = (api) => () => { throw new Error(`Missing recorded browser API result: ${api}`); };
const performanceHost = {
  timeOrigin: tracePerformanceTimeOrigin,
  timing: { navigationStart: traceNavigationStart },
  now: () => {
    const recorded = recordedCalls.get("Performance.now")?.[recordedOffsets.get("Performance.now") || 0];
    const value = recorded ? recordedResult("Performance.now") : (() => {
      // The challenge performs a timing micro-loop. Trace records its observable
      // sample points, not every iteration, so use a fixed monotonic clock once
      // those points are consumed instead of leaking Node scheduler jitter.
      deterministicPerformanceNow = (deterministicPerformanceNow ?? deterministicPerformanceStart) + 0.005;
      return deterministicPerformanceNow;
    })();
    performanceNowCallCount += 1;
    if (performanceNowCalls.length < 16) performanceNowCalls.push({ source: recorded ? "trace" : "deterministic", value });
    return value;
  },
  mark() {}, getEntriesByType: unresolvedBrowserApi("Performance.getEntriesByType"),
};
Object.setPrototypeOf(performanceHost, interfaces.Performance);
hydrateTrace(performanceHost, "Performance");
// The trace records Permissions.query returning a Promise.  The trace profile
// has no moz_perms override for this origin, so Firefox's default permission
// state is prompt.  Keep the result asynchronous like the native API.
const permissions = {
  query: async () => {
    // Consume the captured Promise-returning call while keeping the local
    // settlement asynchronous.  The contract records the object brand but
    // not the resolved `state` value, so the Firefox default remains prompt.
    consumeRecorded("Permissions.query", null);
    const status = { onchange: null };
    Object.setPrototypeOf(status, interfaces.PermissionStatus);
    permissionStatusState.set(status, { state: "prompt" });
    return status;
  },
};
// Cookie state is session-specific.  Use the browser snapshot immediately
// before rly rather than inventing a durable placeholder value.
const cookies = traceCookiesBeforeRlyRequest();
const stored = new Map();
const document = {
  referrer: traceValue("Document", "referrer", ""),
  visibilityState: traceValue("Document", "visibilityState", "visible"),
  hidden: traceValue("Document", "hidden", false),
  characterSet: traceValue("Document", "characterSet", "UTF-8"),
  compatMode: traceValue("Document", "compatMode", "CSS1Compat"),
  readyState: traceRlyPrimitive("Document", "readyState", "interactive"),
  currentScript: scriptElement,
  body: hostObject("document.body", attachEventTarget({
    appendChild(node) { return insertNode("document.body.appendChild", node, this); }, insertBefore(node) { return insertNode("document.body.insertBefore", node, this); },
    insertBefore_e421bb29(node) { return this.insertBefore(node, null); },
    style: {}, firstChild: null, tagName: "BODY", children: null, addBehavior: undefined,
  }, "document.body")),
  head: hostObject("document.head", attachEventTarget({ appendChild(node) { return insertNode("document.head.appendChild", node, this); }, style: {}, tagName: "HEAD", children: null }, "document.head")),
  documentElement: hostObject("document.documentElement", attachEventTarget({ appendChild(node) { return insertNode("document.documentElement.appendChild", node, this); }, insertBefore(node) { return insertNode("document.documentElement.insertBefore", node, this); }, style: {}, tagName: "HTML", children: null }, "document.documentElement")),
  createElement,
  createElementNS: (_namespace, tagName) => createElement(tagName),
  createTextNode,
  createEvent() {
    replayCall("Document.createEvent", null);
    const event = {
      type: "", bubbles: false, cancelable: false, isTrusted: false,
      initEvent(eventType, bubbles = false, cancelable = false) {
        this.type = String(eventType);
        this.bubbles = Boolean(bubbles);
        this.cancelable = Boolean(cancelable);
      },
    };
    Object.setPrototypeOf(event, interfaces.Event);
    return event;
  },
  createAttribute(name) {
    replayCall("Document.createAttribute", null);
    const attribute = { name: String(name), value: "", specified: true };
    Object.setPrototypeOf(attribute, interfaces.Attr);
    return attribute;
  },
  implementation: Object.assign(Object.create(interfaces.DOMImplementation), {
    hasFeature: () => true,
    createHTMLDocument: () => Object.create(interfaces.Document),
  }),
  getElementsByTagName: (name) => { replayCall("Document.getElementsByTagName", null); return makeCollection(`document.getElementsByTagName(${name})`, String(name).toLowerCase() === "script" ? traceScriptNodes : []); },
  getElementById: () => { replayCall("Document.getElementById", null); return null; },
  querySelector: (selector) => { replayCall("Document.querySelector", null); return selector.includes("rly-") ? scriptElement : null; },
  querySelectorAll: () => { replayCall("Document.querySelectorAll", null); return makeCollection("document.querySelectorAll"); }, hasFocus: unresolvedBrowserApi("Document.hasFocus"),
  activeElement: null, fonts: { ready: Promise.resolve(), check: unresolvedBrowserApi("FontFaceSet.check") },
  addEventListener() {},
  removeEventListener() {},
};
attachEventTarget(document, "document");
// The rly loader inserts its iframe relative to document.currentScript.
// Trace shows the native receiver is HTMLBodyElement.
scriptElement.parentNode = document.body;
Object.setPrototypeOf(document.body, interfaces.HTMLBodyElement);
Object.setPrototypeOf(document.head, interfaces.HTMLHeadElement);
Object.setPrototypeOf(document.documentElement, interfaces.HTMLHtmlElement);
Object.setPrototypeOf(document.body.style, interfaces.CSS2Properties);
Object.setPrototypeOf(document.head.style, interfaces.CSS2Properties);
Object.setPrototypeOf(document.documentElement.style, interfaces.CSS2Properties);
document.body.children = makeCollection("document.body.children");
document.head.children = makeCollection("document.head.children");
document.documentElement.children = makeCollection("document.documentElement.children");
document.scripts = makeCollection("document.scripts", traceScriptNodes);
// The rly initialization trace reads body.firstChild and receives a Text node
// used only as the insertBefore anchor.  The trace has no string payload for
// that layout whitespace, so retain the confirmed node kind without inventing
// text content.
const bodyInsertionAnchor = createTextNode("");
bodyInsertionAnchor.parentNode = document.body;
document.body.firstChild = bodyInsertionAnchor;
Object.setPrototypeOf(document, interfaces.Document);
hydrateTrace(document, "Document");
Object.defineProperty(document, "cookie", {
  // The ordered trace replay replaces this getter after documentHost is
  // created. Keep the local host descriptor configurable just like the
  // browser-facing replay properties.
  configurable: true,
  enumerable: true,
  get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
  set: (value) => {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  },
});
document.activeElement = document.body;
// A browser anti-automation probe distinguishes a missing document property
// from a callable synthetic placeholder.  Keep the host closed by default;
// add a member only when trace or Firefox BiDi establishes it.
const documentHost = hostObject("document", document, false);
const livePlugins = Array.isArray(browserLiveValues.plugins) ? browserLiveValues.plugins : null;
const pluginEntries = livePlugins ? livePlugins.map((plugin, pluginIndex) => {
  const liveMimes = Array.isArray(plugin.mimeTypes) ? plugin.mimeTypes : [];
  const mimeEntries = liveMimes.map((mime, mimeIndex) => {
    const entry = hostObject(`navigator.plugins[${pluginIndex}][${mimeIndex}]`, {
      type: String(mime.type || ""), suffixes: String(mime.suffixes || ""), description: String(mime.description || ""),
    }, false);
    Object.setPrototypeOf(entry, interfaces.MimeType);
    return entry;
  });
  const entry = hostObject(`navigator.plugins[${pluginIndex}]`, {
    name: String(plugin.name || ""), filename: String(plugin.filename || ""), description: String(plugin.description || ""),
    length: mimeEntries.length, item(index) { return mimeEntries[Number(index)] ?? null; }, namedItem(name) { return mimeEntries.find((mime) => mime.type === name) ?? null; },
  }, false);
  mimeEntries.forEach((mime, mimeIndex) => { entry[mimeIndex] = mime; });
  Object.setPrototypeOf(entry, interfaces.Plugin);
  return entry;
}) : [];
// The trace confirms only the object brands.  Populate entries solely from a
// Firefox console evidence file; absent evidence remains unknown, never zero.
const pluginArray = hostObject("navigator.plugins", livePlugins ? {
  length: pluginEntries.length,
  item(index) { return pluginEntries[Number(index)] ?? null; },
  namedItem(name) { return pluginEntries.find((plugin) => plugin.name === name) ?? null; },
  refresh() {},
} : {}, false);
pluginEntries.forEach((plugin, pluginIndex) => { pluginArray[pluginIndex] = plugin; });
const mimeTypeArray = hostObject("navigator.mimeTypes", {}, false);
Object.setPrototypeOf(pluginArray, interfaces.PluginArray);
Object.setPrototypeOf(mimeTypeArray, interfaces.MimeTypeArray);
const lockManager = hostObject("navigator.locks", {
  async query() { return { held: [], pending: [] }; },
  async request(name, optionsOrCallback, callback) {
    const fn = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    return typeof fn === "function" ? fn({ name: String(name), mode: "exclusive" }) : undefined;
  },
}, false);
Object.setPrototypeOf(lockManager, interfaces.LockManager);
const externalHost = hostObject("window.external", {}, false);
Object.setPrototypeOf(externalHost, interfaces.External);
const storage = {
  getItem: (key) => {
    const fallback = stored.get(key) ?? null;
    const value = replayCall("Storage.getItem", fallback);
    return value === undefined ? fallback : value;
  },
  setItem: (key, value) => { replayCall("Storage.setItem", undefined); stored.set(key, String(value)); },
  removeItem: (key) => { replayCall("Storage.removeItem", undefined); return stored.delete(key); },
  clear: () => { replayCall("Storage.clear", undefined); stored.clear(); },
};
const interceptedRequests = [];
const cryptoRandomCalls = [];
const traceCrypto = Object.create(webcrypto);
Object.defineProperty(traceCrypto, "getRandomValues", {
  configurable: true,
  value(value) {
    cryptoRandomCalls.push({ byte_length: value?.byteLength ?? null, type: value?.constructor?.name || null });
    return webcrypto.getRandomValues(value);
  },
});
const browserTimers = new Map();
let syntheticTimerId = Math.max(1, ...((recordedCalls.get("Window.setTimeout") || [])
  .map((event) => Number(event.value_preview)).filter(Number.isFinite)));
let syntheticTimerCount = 0;
function browserSetTimeout(callback, delay, ...args) {
  const offset = recordedOffsets.get("Window.setTimeout") || 0;
  const recorded = recordedCalls.get("Window.setTimeout")?.[offset];
  const id = recorded ? recordedResult("Window.setTimeout") : (++syntheticTimerId, syntheticTimerCount++, syntheticTimerId);
  if (process.env.TRACE_SYNC_ZERO_TIMERS === "1" && Number(delay) === 0) {
    callback(...args);
    return id;
  }
  browserTimers.set(id, setTimeout(() => callback(...args), Number(delay) || 0));
  return id;
}
function browserClearTimeout(id) {
  const handle = browserTimers.get(id);
  if (handle) clearTimeout(handle);
  browserTimers.delete(id);
}
function TraceMutationObserver(callback) {
  const instance = {
    callback,
    observe(target, options) {
      hostMutationObservations.push({ target: String(target?.data || target?.tagName || "object"), options });
      mutationObservers.push({ instance, callback, target, options });
    },
    disconnect() {},
    takeRecords() { return []; },
  };
  return new Proxy(instance, {
    get(target, property, receiver) {
      if (process.env.RECORD_HOST_MEMBER_READS === "1") {
        process.stderr.write(`${JSON.stringify({ host: "MutationObserver", operation: "get", member: String(property) })}\n`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
function TraceAudio() {
  return createElement("audio");
}
const nativeAtob = atob;
const nativeBtoa = btoa;
let traceBtoaCallCount = 0;
const traceAtob = nativeHostFunction("atob", function atob(input) {
  const fallback = nativeAtob(String(input));
  const result = consumeRecorded("Window.atob", fallback);
  if (process.env.TRACE_ATOB_VALUES === "1") {
    const bytes = Buffer.from([...fallback].map((char) => char.charCodeAt(0) & 0xff));
    process.stderr.write(JSON.stringify({
      api: "Window.atob",
      count: recordedOffsets.get("Window.atob") || 0,
      input_length: String(input).length,
      input_head: String(input).slice(0, 32),
      replayed: result.found,
      trace_size: result.entry?.value_size ?? null,
      fallback_length: fallback.length,
      fallback_head_hex: bytes.subarray(0, 32).toString("hex"),
      value_kind: result.entry?.value_kind || null,
    }) + "\n");
  }
  // Keep the existing native atob result. The trace is used for ordering and
  // diagnostics here; this branch intentionally does not synthesize bytes.
  return fallback;
});
const traceBtoa = nativeHostFunction("btoa", function btoa(input) {
  traceBtoaCallCount += 1;
  if (process.env.TRACE_BTOA_STACKS === "1" &&
      (traceBtoaCallCount <= 8 || traceBtoaCallCount % 5000 === 0)) {
    const replaySnapshot = {};
    for (const api of [
      "Window.btoa", "Window.atob", "Window.setTimeout", "Performance.now",
      "Document.createElement", "HTMLCanvasElement.getContext",
      "WebGL2RenderingContext.getParameter", "Navigator.plugins",
      "PluginArray.length", "Document.cookie",
    ]) {
      replaySnapshot[api] = recordedOffsets.get(api) || 0;
    }
    process.stderr.write(JSON.stringify({
      api: "Window.btoa",
      count: traceBtoaCallCount,
      input_length: String(input).length,
      input_head: String(input).slice(0, 48),
      host_api_count: hostApiCalls.length,
      missing_host_count: missingHostAccesses.length,
      replay_snapshot: replaySnapshot,
      stack: new Error().stack,
    }) + "\n");
  }
  const fallback = nativeBtoa(String(input));
  return replayCall("Window.btoa", fallback, () => fallback);
});
const sandbox = {
  console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, File, FormData,
  DOMException, Headers, Request, Response,
  AbortController, atob: traceAtob, btoa: traceBtoa, setTimeout: browserSetTimeout, clearTimeout: browserClearTimeout, setInterval, clearInterval,
  // Do not inject ECMAScript intrinsics here.  A fresh context supplies its
  // own Object/Function/Promise/typed-array realm, which anti-tamper checks
  // distinguish from the outer Node process.
  crypto: traceCrypto, performance: performanceHost, history,
  location: observeHost("location", {
    href: traceValue("Location", "href", "https://www.globalsources.com/searchList/products?keyWord=shoe&pageNum=2"),
    origin: traceValue("Location", "origin", "https://www.globalsources.com"),
    protocol: traceValue("Location", "protocol", "https:"), host: traceValue("Location", "host", ""),
    hostname: traceValue("Location", "hostname", ""), port: traceValue("Location", "port", ""),
    pathname: traceValue("Location", "pathname", "/"), search: traceValue("Location", "search", ""),
    hash: traceValue("Location", "hash", ""), reload() {},
  }),
  document: documentHost,
  name: traceValue("Window", "name", ""),
  origin: traceValue("Window", "origin", ""),
  pageXOffset: traceValue("Window", "pageXOffset", 0),
  pageYOffset: traceValue("Window", "pageYOffset", 0),
  visualViewport: Object.assign(Object.create(interfaces.VisualViewport), browserLiveValues.visualViewport || {}),
  localStorage: storage,
  sessionStorage: storage,
  navigator: observeHost("navigator", {
    userAgent: traceValue("Navigator", "userAgent", "Mozilla/5.0 Firefox/142.0"),
    platform: traceValue("Navigator", "platform", "MacIntel"), language: traceValue("Navigator", "language", "en-US"),
    languages: Array.isArray(browserLiveValues.languages) ? browserLiveValues.languages.slice() : hostObject("navigator.languages", {}, false), hardwareConcurrency: traceValue("Navigator", "hardwareConcurrency", 8),
    maxTouchPoints: traceValue("Navigator", "maxTouchPoints", 0), cookieEnabled: traceValue("Navigator", "cookieEnabled", true),
    onLine: traceValue("Navigator", "onLine", true), product: traceValue("Navigator", "product", "Gecko"),
    vendor: traceValue("Navigator", "vendor", ""), buildID: traceValue("Navigator", "buildID", browserLiveValues.navigator?.buildID),
    doNotTrack: traceValue("Navigator", "doNotTrack", browserLiveValues.navigator?.doNotTrack),
    productSub: browserLiveValues.navigator?.productSub, webdriver: browserLiveValues.navigator?.webdriver,
    appName: browserLiveValues.navigator?.appName,
    // The BiDi evidence records these as properties whose actual value is
    // undefined.  Define them explicitly to preserve the browser shape.
    cpuClass: undefined, userAgentData: undefined, connection: undefined, duckduckgo: undefined, getBattery: undefined,
    plugins: pluginArray, mimeTypes: mimeTypeArray, locks: lockManager, permissions,
  }),
  screen: observeHost("screen", {
    width: traceValue("Screen", "width", 1440), height: traceValue("Screen", "height", 900),
    availWidth: traceValue("Screen", "availWidth", 1440), availHeight: traceValue("Screen", "availHeight", 860),
    availLeft: traceValue("Screen", "availLeft", browserLiveValues.screen?.availLeft),
    availTop: traceValue("Screen", "availTop", browserLiveValues.screen?.availTop),
    pixelDepth: traceValue("Screen", "pixelDepth", 24), colorDepth: traceValue("Screen", "colorDepth", traceValue("Screen", "pixelDepth", 24)),
    orientation: Object.assign(Object.create(interfaces.ScreenOrientation), browserLiveValues.screen?.orientation || {}),
  }),
  innerWidth: traceValue("Window", "innerWidth", 1440), innerHeight: traceValue("Window", "innerHeight", 860),
  outerWidth: traceValue("Window", "outerWidth", 1440), outerHeight: traceValue("Window", "outerHeight", 900),
  screenX: traceValue("Window", "screenX", 0), screenY: traceValue("Window", "screenY", 0),
  devicePixelRatio: traceValue("Window", "devicePixelRatio", 1),
  getComputedStyle: (element) => hostObject("window.getComputedStyle", {
    getPropertyValue: (name) => String(element?.style?.[name] ?? ""),
    getPropertyPriority: () => "",
    item: () => "",
    length: 0,
    // CSS initial value, used only by the opt-in compatibility execution pass.
    opacity: compatibilityMode ? "1" : undefined,
  }),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: unresolvedBrowserApi("Window.matchMedia"),
  PerformanceObserver: class PerformanceObserver { static supportedEntryTypes = firstRecordedResult("PerformanceObserver.supportedEntryTypes", []); observe() {} disconnect() {} takeRecords() { return []; } },
  fetch: async (input, init = {}) => {
    interceptedRequests.push({
      url: String(input), method: init.method || "GET", body: String(init.body || ""),
      synthetic_timer_count_at_request: syntheticTimerCount,
    });
    // The body is fully constructed before fetch is awaited. A non-success response
    // terminates the server exchange without using recorded response data.
    return { ok: false, status: 599, text: async () => "", json: async () => ({}) };
  },
  XMLHttpRequest: function XMLHttpRequest() { throw new Error("XMLHttpRequest invoked in environment probe."); },
  MutationObserver: TraceMutationObserver,
  Audio: TraceAudio,
  external: externalHost,
  __firefoxTraceHostBridge: hostBridge,
};
if (windowApiShape) sandbox.api = windowApiShape;
Object.assign(sandbox, hostConstructors);
if (compatibilityMode) {
  // These are script self-check fallbacks.  They are isolated from the
  // trace-derived host and reported with the generated request.
  hostConstructors.HTMLCanvasElement.toDataURL = (...args) => {
    compatibilityFallbacks.push("HTMLCanvasElement.toDataURL");
    return interfaces.HTMLCanvasElement.toDataURL(...args);
  };
  for (const member of ["removeChild", "baseRemoveChild_e421bb29"]) {
    if (typeof String.prototype[member] !== "function") {
      Object.defineProperty(String.prototype, member, {
        configurable: true,
        value(...args) {
          compatibilityFallbacks.push(`String.prototype.${member}`);
          return args[0] ?? null;
        },
      });
    }
  }
}
attachEventTarget(sandbox, "window");
Object.setPrototypeOf(sandbox.navigator, interfaces.Navigator);
Object.setPrototypeOf(sandbox.screen, interfaces.Screen);
Object.setPrototypeOf(sandbox.location, interfaces.Location);
if (process.env.REPLAY_NAVIGATOR_SHAPE === "1") {
  // Firefox exposes Navigator values through its prototype accessors. Keeping
  // the literal replay fields as own properties makes the challenge enumerate
  // scalar names before the confirmed prototype surface.
  for (const key of Object.keys(sandbox.navigator)) delete sandbox.navigator[key];
}
hydrateTrace(sandbox.navigator, "Navigator");
hydrateTrace(sandbox.screen, "Screen");
hydrateTrace(sandbox.location, "Location");
const windowHost = sandbox;
Object.setPrototypeOf(windowHost, interfaces.Window);
windowHost.window = windowHost;
windowHost.self = windowHost;
windowHost.globalThis = windowHost;
windowHost.top = windowHost;
windowHost.parent = windowHost;
windowHost.frames = windowHost;
hydrateWindowSnapshot(windowHost);
// The page installs an own Window getter for this lifecycle callback.  It is
// outside the compact 231-member Window preview, but the rly self-check reads
// the name before collecting Navigator members.  Keep this evidence-driven
// shape opt-in while comparing a trace; the getter returns undefined until the
// page itself assigns a callback.
function installWindowCallbackShape() {
  if (process.env.REPLAY_WINDOW_CALLBACK_SHAPE !== "1") return;
  if (Object.prototype.hasOwnProperty.call(windowHost, "onProtectionInitialized")) return;
  if (process.env.REPLAY_WINDOW_CALLBACK_FUNCTION === "1") {
    Object.defineProperty(windowHost, "onProtectionInitialized", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: nativeHostFunction("onProtectionInitialized", function onProtectionInitialized() {}),
    });
    return;
  }
  const getter = nativeHostFunction("get onProtectionInitialized", function onProtectionInitializedGetter() {
    return undefined;
  });
  Object.defineProperty(windowHost, "onProtectionInitialized", {
    configurable: true,
    enumerable: true,
    get: getter,
    set() {},
  });
}
installWindowCallbackShape();
documentHost.defaultView = windowHost;
Object.defineProperty(documentHost, "location", {
  configurable: true,
  get: () => windowHost.location,
});

// Scalar BOM/DOM members are part of the fingerprint just as much as canvas
// and WebGL results.  Replay them in access order so a property read cannot
// silently fall back to a value from an older browser session.
function installTraceOrderedHostReplay() {
  const customElementsHost = windowHost.customElements || hostObject("window.customElements", {}, false);
  const barProps = ["locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar"];
  const barFallbacks = Object.fromEntries(barProps.map((member) => [member, windowHost[member] || hostObject(`window.${member}`, {}, false)]));
  const windowObjects = {
    history,
    customElements: customElementsHost,
    navigator: sandbox.navigator,
    clientInformation: sandbox.navigator,
    frames: windowHost,
    parent: windowHost,
    top: windowHost,
    self: windowHost,
    location: windowHost.location,
    document: documentHost,
    screen: sandbox.screen,
    external: externalHost,
    performance: performanceHost,
    crypto: traceCrypto,
    localStorage: storage,
    sessionStorage: storage,
    visualViewport: sandbox.visualViewport,
    opener: null,
    frameElement: null,
    event: undefined,
  };
  for (const [member, fallback] of Object.entries(windowObjects)) {
    const api = `Window.${member}`;
    replayGetter(windowHost, member, api, fallback, (_value) => {
      if (["navigator", "clientInformation"].includes(member)) return sandbox.navigator;
      if (["frames", "parent", "top", "self"].includes(member)) return windowHost;
      if (member === "location") return windowHost.location;
      if (member === "document") return documentHost;
      if (member === "screen") return sandbox.screen;
      if (member === "performance") return performanceHost;
      if (member === "crypto") return traceCrypto;
      if (["localStorage", "sessionStorage"].includes(member)) return storage;
      if (member === "visualViewport") return sandbox.visualViewport;
      return fallback;
    });
  }
  for (const member of barProps) replayGetter(windowHost, member, `Window.${member}`, barFallbacks[member], () => barFallbacks[member]);
  const windowScalars = {
    name: "", status: "", closed: false, length: 0, innerWidth: 1280, innerHeight: 891,
    outerWidth: 1280, outerHeight: 975, screenX: 0, screenY: 0, pageXOffset: 0,
    pageYOffset: 0, scrollX: 0, scrollY: 0, devicePixelRatio: 2, origin: "https://www.globalsources.com",
  };
  for (const [member, fallback] of Object.entries(windowScalars)) {
    replayGetter(windowHost, member, `Window.${member}`, fallback);
  }

  const navigatorScalars = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
    platform: "MacIntel", language: "en-US", hardwareConcurrency: 12, maxTouchPoints: 0,
    cookieEnabled: true, onLine: true, product: "Gecko", vendor: "", buildID: "20181001000000",
    doNotTrack: "unspecified", productSub: "20100101", webdriver: false, appName: "Netscape",
  };
  const navigatorReplayTarget = process.env.REPLAY_NAVIGATOR_SHAPE === "1" ? interfaces.Navigator : sandbox.navigator;
  for (const [member, fallback] of Object.entries(navigatorScalars)) {
    replayGetter(navigatorReplayTarget, member, `Navigator.${member}`, fallback);
  }
  replayGetter(navigatorReplayTarget, "languages", "Navigator.languages", browserLiveValues.languages || ["en-US", "en"], () =>
    Array.isArray(browserLiveValues.languages) ? browserLiveValues.languages.slice() : ["en-US", "en"]);
  replayGetter(navigatorReplayTarget, "plugins", "Navigator.plugins", pluginArray, () => pluginArray);
  replayGetter(navigatorReplayTarget, "mimeTypes", "Navigator.mimeTypes", mimeTypeArray, () => mimeTypeArray);
  replayGetter(navigatorReplayTarget, "permissions", "Navigator.permissions", permissions, () => permissions);
  replayGetter(navigatorReplayTarget, "locks", "Navigator.locks", lockManager, () => lockManager);
  replayGetter(pluginArray, "length", "PluginArray.length", pluginEntries.length, () => pluginEntries.length);

  const screenScalars = { width: 1728, height: 1117, availWidth: 1728, availHeight: 1084, availLeft: 0, availTop: 33, pixelDepth: 30, colorDepth: 30 };
  for (const [member, fallback] of Object.entries(screenScalars)) replayGetter(sandbox.screen, member, `Screen.${member}`, fallback);
  // `window.visualViewport` is returned as an object by the Window shape
  // probe, then its scalar members are read directly.  Those reads do not
  // produce a separate DOM event in every Firefox build, so use the live
  // same-UA sidecar when it contains the confirmed values.  Leaving the
  // members absent turns them into undefined and changes the fingerprint
  // branch before the binary payload is assembled.
  const visualViewportValues = browserLiveValues.visualViewport;
  if (visualViewportValues && typeof visualViewportValues === "object") {
    for (const member of ["width", "height", "offsetLeft", "offsetTop", "pageLeft", "pageTop", "scale"]) {
      const value = visualViewportValues[member];
      if (Number.isFinite(value)) replayGetter(sandbox.visualViewport, member, `VisualViewport.${member}`, value);
    }
  }
  const locationScalars = {
    href: "https://www.globalsources.com/searchList/products?keyWord=shoe&pageNum=2&tsCode=HK",
    origin: "https://www.globalsources.com", protocol: "https:", host: "www.globalsources.com",
    hostname: "www.globalsources.com", port: "", pathname: "/searchList/products",
    search: "?keyWord=shoe&pageNum=2&tsCode=HK", hash: "",
  };
  for (const [member, fallback] of Object.entries(locationScalars)) replayGetter(sandbox.location, member, `Location.${member}`, fallback);
  replayGetter(history, "length", "History.length", 1);
  replayGetter(performanceHost, "timeOrigin", "Performance.timeOrigin", tracePerformanceTimeOrigin);
  replayGetter(documentHost, "readyState", "Document.readyState", "interactive");
  // Keep the wired host node for object-valued DOM getters. Re-materializing
  // the trace descriptor creates a brand-only object and drops methods such as
  // documentElement.getAttribute, which changes the challenge branch.
  const preserveDomObject = (fallback) => (value, entry) =>
    entry?.value_kind === "object" ? fallback : value;
  replayGetter(documentHost, "body", "Document.body", document.body, preserveDomObject(document.body));
  replayGetter(documentHost, "head", "Document.head", document.head, preserveDomObject(document.head));
  replayGetter(documentHost, "documentElement", "Document.documentElement", document.documentElement, preserveDomObject(document.documentElement));
  replayGetter(documentHost, "cookie", "Document.cookie", document.cookie, (value) => String(value ?? ""));
  replayGetter(documentHost, "location", "HTMLDocument.location", windowHost.location, () => windowHost.location);
  const allWindowKeys = browserLiveValues.keysets?.windowOwn;
  const windowKeyStart = Array.isArray(allWindowKeys) ? allWindowKeys.indexOf("close") : -1;
  const windowShapeKeys = windowKeyStart >= 0 ? allWindowKeys.slice(windowKeyStart, windowKeyStart + 231) : [];
  // The compact JS preview is capped at 231 properties.  A Firefox console
  // sidecar can contain the complete own-key set; expose it only for an
  // explicit A/B run because page globals are site-specific and their values
  // are not inferred from names alone.
  const replayFullWindowShape = process.env.REPLAY_WINDOW_FULL_SHAPE === "1" &&
    Array.isArray(allWindowKeys) && allWindowKeys.length > 0;
  const activeWindowShapeKeys = replayFullWindowShape ? allWindowKeys : windowShapeKeys;
  const windowShapeReady = activeWindowShapeKeys.length > 0 &&
    (replayFullWindowShape || activeWindowShapeKeys.length === 231);
  // The captured Window preview exposes the first 231 enumerable members.  A
  // plain Node object otherwise has a much smaller shape and the challenge's
  // early self-test takes a different branch before it reaches the fingerprint
  // collectors.  Hydrate only missing names here; existing replay getters keep
  // consuming their recorded values in access order.
  if (windowShapeReady && process.env.REPLAY_WINDOW_HYDRATE === "1") {
    const shapeMethods = new Set(windowShapeKeys.slice(0, 44));
    const shapeObjects = new Set([
      "self", "history", "customElements", "locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar",
      "frames", "parent", "navigator", "clientInformation", "external", "screen", "performance", "visualViewport",
      "cookieStore", "indexedDB", "caches", "scheduler", "sessionStorage", "localStorage", "window", "document", "location", "crypto",
    ]);
    const shapeScalars = new Map([
      ["name", ""], ["status", ""], ["closed", false], ["event", undefined], ["length", 0],
      ["opener", null], ["frameElement", null], ["innerWidth", 1280], ["innerHeight", 891],
      ["scrollX", 0], ["pageXOffset", 0], ["scrollY", 0], ["pageYOffset", 0],
      ["screenLeft", 287], ["screenTop", 88], ["screenX", 287], ["screenY", 88],
      ["outerWidth", 1280], ["outerHeight", 975], ["devicePixelRatio", 2],
      ["mozInnerScreenX", 287], ["mozInnerScreenY", 88], ["scrollMaxX", 0], ["scrollMaxY", 0],
      ["fullScreen", false], ["originAgentCluster", false], ["crossOriginIsolated", false], ["isSecureContext", true],
    ]);
    for (const key of activeWindowShapeKeys) {
      if (Object.prototype.hasOwnProperty.call(windowHost, key)) continue;
      let value;
      if (shapeScalars.has(key)) value = shapeScalars.get(key);
      else if (shapeMethods.has(key)) value = nativeHostFunction(key, function windowShapeMethod() {});
      else if (shapeObjects.has(key)) value = hostObject(`window.${key}`, {}, false);
      else if (key.startsWith("on")) value = null;
      // Page scripts may install their own constructors after the Window
      // snapshot.  A truthy placeholder here makes feature-detection branches
      // skip that initialization, so keep constructor slots writable/empty by
      // default.  Synthetic constructors remain available for an explicit A/B
      // run when a trace proves the page never assigns them.
      else if (replayFullWindowShape && process.env.REPLAY_WINDOW_SYNTHETIC_CONSTRUCTORS === "1" && /constructor$/i.test(key)) {
        value = nativeHostFunction(key, function windowShapeConstructor() {});
      }
      else if (replayFullWindowShape && key in globalThis) value = globalThis[key];
      else value = undefined;
      Object.defineProperty(windowHost, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    }
  }
  const replayWindowShape = process.env.REPLAY_WINDOW_SHAPE === "1" || process.env.REPLAY_WINDOW_WINDOW_ONLY === "1";
  if (windowShapeReady) {
    const shapeValues = new Map();
    const methodKeys = new Set(windowShapeKeys.slice(0, 44));
    const objectKeys = new Set([
      "self", "history", "customElements", "locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar",
      "frames", "parent", "navigator", "clientInformation", "external", "screen", "performance", "visualViewport",
      "cookieStore", "indexedDB", "caches", "scheduler", "sessionStorage", "localStorage", "window", "document", "location", "crypto",
    ]);
    const scalarShapeValues = new Map([
      ["name", ""], ["status", ""], ["closed", false], ["event", undefined], ["length", 0],
      ["opener", null], ["frameElement", null], ["innerWidth", 1280], ["innerHeight", 891],
      ["scrollX", 0], ["pageXOffset", 0], ["scrollY", 0], ["pageYOffset", 0],
      ["screenLeft", 287], ["screenTop", 88], ["screenX", 287], ["screenY", 88],
      ["outerWidth", 1280], ["outerHeight", 975], ["devicePixelRatio", 2],
      ["mozInnerScreenX", 287], ["mozInnerScreenY", 88], ["scrollMaxX", 0], ["scrollMaxY", 0],
      ["fullScreen", false], ["originAgentCluster", false], ["crossOriginIsolated", false], ["isSecureContext", true],
    ]);
    const intrinsicShapeValues = new Map([
      ["Math", Math], ["JSON", JSON], ["Object", Object], ["Function", Function],
      ["Array", Array], ["String", String], ["Number", Number], ["Boolean", Boolean],
      ["Date", Date], ["RegExp", RegExp], ["Promise", Promise], ["Symbol", Symbol],
      ["Map", Map], ["Set", Set], ["WeakMap", WeakMap], ["WeakSet", WeakSet],
      ["Reflect", Reflect], ["Proxy", Proxy], ["BigInt", BigInt], ["parseInt", parseInt],
      ["parseFloat", parseFloat], ["isNaN", isNaN], ["isFinite", isFinite],
    ]);
    for (const key of activeWindowShapeKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(windowHost, key);
      if (intrinsicShapeValues.has(key)) {
        shapeValues.set(key, intrinsicShapeValues.get(key));
      } else if (scalarShapeValues.has(key)) {
        shapeValues.set(key, scalarShapeValues.get(key));
      } else if (descriptor && "value" in descriptor) {
        shapeValues.set(key, descriptor.value);
      } else if (methodKeys.has(key)) {
        shapeValues.set(key, nativeHostFunction(key, function windowShapeMethod() {}));
      } else if (objectKeys.has(key)) {
        shapeValues.set(key, hostObject(`window.${key}`, {}, false));
      } else if (key.startsWith("on")) {
        shapeValues.set(key, null);
      } else if (replayFullWindowShape && process.env.REPLAY_WINDOW_SYNTHETIC_CONSTRUCTORS === "1" && /constructor$/i.test(key)) {
        // The sidecar records names, not constructor bodies.  Keep this opt-in
        // because page code may populate the slot during challenge startup.
        shapeValues.set(key, nativeHostFunction(key, function windowShapeConstructor() {}));
      } else if (replayFullWindowShape) {
        // Preserve the property key without inventing a value.  A later
        // targeted DOM/BOM replay can still provide a concrete member.
        shapeValues.set(key, undefined);
      } else {
        shapeValues.set(key, undefined);
      }
    }
    shapeValues.set("self", windowHost);
    shapeValues.set("frames", windowHost);
    shapeValues.set("parent", windowHost);
    shapeValues.set("window", windowHost);
    shapeValues.set("document", documentHost);
    shapeValues.set("navigator", sandbox.navigator);
    shapeValues.set("clientInformation", sandbox.navigator);
    shapeValues.set("history", history);
    shapeValues.set("location", windowHost.location);
    shapeValues.set("screen", sandbox.screen);
    shapeValues.set("visualViewport", sandbox.visualViewport);
    shapeValues.set("performance", performanceHost);
    shapeValues.set("external", externalHost);
    shapeValues.set("crypto", traceCrypto);
    shapeValues.set("localStorage", storage);
    shapeValues.set("sessionStorage", storage);
    const windowShapeProxy = new Proxy(windowHost, {
      ownKeys: () => activeWindowShapeKeys,
      getOwnPropertyDescriptor: (target, property) => {
        if (typeof property === "string" && activeWindowShapeKeys.includes(property)) {
          return { configurable: true, enumerable: true, writable: true, value: shapeValues.get(property) };
        }
        return Object.getOwnPropertyDescriptor(target, property);
      },
      get: (target, property, receiver) => {
        if (process.env.TRACE_WINDOW_ACCESSES === "1" && typeof property === "string") {
          windowAccessLogCount += 1;
          if (windowAccessLogCount <= 400) process.stderr.write(`${JSON.stringify({ window_get: property, present: shapeValues.has(property) || property in target })}\n`);
        }
        if (typeof property === "string" && shapeValues.has(property)) return shapeValues.get(property);
        return Reflect.get(target, property, receiver);
      },
      // The sidecar gives us names, but page code is still allowed to install
      // the corresponding globals during challenge startup.  Keep the proxy's
      // shape map in sync with ordinary assignment/defineProperty writes so a
      // placeholder cannot hide the newly installed constructor or function.
      set: (target, property, value, receiver) => {
        if (typeof property === "string" && shapeValues.has(property)) {
          shapeValues.set(property, value);
        }
        return Reflect.set(target, property, value, receiver);
      },
      defineProperty: (target, property, descriptor) => {
        if (typeof property === "string" && shapeValues.has(property) && "value" in descriptor) {
          shapeValues.set(property, descriptor.value);
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    });
    replayWindowProxy = windowShapeProxy;
    // `window` is the value explicitly passed to the challenge's shape probe;
    // keep the self/parent/frame identity checks on the same proxy.
    if (replayWindowShape) {
      windowHost.window = windowShapeProxy;
    }
    if (replayWindowShape && process.env.REPLAY_WINDOW_WINDOW_ONLY !== "1") {
      windowHost.self = windowShapeProxy;
      windowHost.globalThis = windowShapeProxy;
      windowHost.top = windowShapeProxy;
      windowHost.parent = windowShapeProxy;
      windowHost.frames = windowShapeProxy;
      documentHost.defaultView = windowShapeProxy;
    }
    if (process.env.TRACE_HOST_SHAPE === "1") {
      process.stderr.write(JSON.stringify({ window_shape_count: Object.getOwnPropertyNames(windowShapeProxy).length, window_shape_keys: activeWindowShapeKeys }) + "\n");
    }
  }
  // Keep ordinary Window data members observable as browser getters.  The
  // challenge's shape probe reads these members directly; leaving Node-side
  // values as plain own properties skips the corresponding trace events and
  // changes the subsequent branch before canvas/WebGL collection.
  const installedWindowMembers = new Set([
    ...Object.keys(windowObjects), ...barProps, ...Object.keys(windowScalars),
  ]);
  const replayWindowMembers = [...recordedCalls.keys()]
    .filter((api) => api.startsWith("Window."))
    .map((api) => api.slice("Window.".length))
    .filter((member) => recordedCalls.get(`Window.${member}`)?.some((entry) => entry.type === "dom.get"));
  for (const member of new Set(replayWindowMembers)) {
    if (installedWindowMembers.has(member)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(windowHost, member);
    if (descriptor && descriptor.configurable === false) continue;
    const fallback = descriptor && "value" in descriptor ? descriptor.value : undefined;
    replayGetter(windowHost, member, `Window.${member}`, fallback, (value, entry) => {
      return entry?.value_kind === "object" ? fallback : value;
    });
  }
  // Keep the browser-facing function brand consistent for every installed
  // host callable.  A few helpers are ordinary Node closures rather than
  // `nativeHostFunction` wrappers; the challenge explicitly checks
  // Function#toString on the Window surface before collecting the payload.
  for (const key of Object.getOwnPropertyNames(windowHost)) {
    const value = windowHost[key];
    if (typeof value === "function" && !nativeSources.has(value)) {
      nativeSources.set(value, `function ${key}() { [native code] }`);
    }
  }
  for (const [name, constructor] of Object.entries(hostConstructors)) {
    if (typeof constructor === "function" && !nativeSources.has(constructor)) {
      nativeSources.set(constructor, `function ${name}() { [native code] }`);
    }
  }
  if (process.env.TRACE_HOST_SHAPE === "1") {
    process.stderr.write(JSON.stringify({
      own_count: Object.getOwnPropertyNames(windowHost).length,
      own_keys: Object.getOwnPropertyNames(windowHost),
      navigator_keys: Object.getOwnPropertyNames(sandbox.navigator),
      document_keys: Object.getOwnPropertyNames(document),
    }) + "\n");
  }
}
installTraceOrderedHostReplay();

(async () => {
try {
  // Node's context has fresh intrinsics, but `window` is our host object rather
  // than the context proxy.  Mirror browser global members onto it without
  // importing outer-realm constructors.
  Object.assign(windowHost, vm.runInNewContext(
    "({ Object, Array, Function, Promise, ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, WebAssembly, JSON, Math, Date, RegExp, Error, TypeError, RangeError, String, Number, Boolean, Symbol, BigInt, Reflect, Proxy, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent })",
    windowHost,
    { filename: "firefox-trace-realm-intrinsics.js" },
  ));
  // Firefox 142 exposes the static Uint8Array.fromBase64 fast path. Node 22
  // does not, so the rly helper otherwise falls back to Window.atob for each
  // embedded WASM blob. Keep this opt-in while comparing a trace; it is an
  // evidence-driven compatibility probe, not a synthetic environment value.
  if (process.env.REPLAY_FIREFOX_BASE64 === "1" &&
      typeof windowHost.Uint8Array?.fromBase64 !== "function") {
    const nativeFromBase64 = nativeHostFunction("fromBase64", function fromBase64(input) {
      if (process.env.TRACE_BASE64_SHIM === "1") {
        process.stderr.write(`${JSON.stringify({
          base64_shim: "called",
          input_length: String(input).length,
          window_uint8array_same: windowHost.Uint8Array === Uint8Array,
          window_identity: windowHost.window === windowHost,
        })}\n`);
      }
      const binary = nativeAtob(String(input));
      const output = new windowHost.Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
      return output;
    });
    Object.defineProperty(windowHost.Uint8Array, "fromBase64", {
      configurable: true,
      writable: true,
      value: nativeFromBase64,
    });
    if (process.env.TRACE_BASE64_SHIM === "1") {
      const descriptor = Object.getOwnPropertyDescriptor(windowHost.Uint8Array, "fromBase64");
      process.stderr.write(`${JSON.stringify({
        base64_shim: "installed",
        window_type: typeof windowHost,
        window_is_self: windowHost.window === windowHost,
        constructor_name: windowHost.Uint8Array?.name || null,
        constructor_same_realm: windowHost.Uint8Array === Uint8Array,
        descriptor: descriptor ? { configurable: descriptor.configurable, writable: descriptor.writable, value_type: typeof descriptor.value } : null,
        from_base64_type: typeof windowHost.Uint8Array?.fromBase64,
      })}\n`);
    }
  }
  // The final p starts with an encrypted stream. Use the random values observed
  // inside the captured rly call domain so a local run can be compared before
  // encryption rather than diverging after the four-byte bin1 header.
  Object.defineProperty(windowHost, "__firefoxTraceNextRandom", {
    configurable: true,
    value: nativeHostFunction("random", nextTraceRandom),
  });
  Object.defineProperty(windowHost, "__firefoxTraceNextTime", {
    configurable: true,
    value: nativeHostFunction("now", nextTraceTime),
  });
  if (process.env.REPLAY_TEXT_ENCODER_SHAPE === "1") {
    // TextEncoder must belong to the challenge realm.  The outer Node
    // constructor produces correct UTF-8 bytes but exposes the wrong
    // constructor/prototype identity to browser self-checks.
    vm.runInNewContext(`(() => {
      const bridge = globalThis.__firefoxTraceHostBridge;
      class TextEncoder {
        constructor() {}
        encode(input = "") {
          return Uint8Array.from(bridge.textEncoderEncode(String(input)));
        }
        encodeInto(input, destination) {
          const bytes = Uint8Array.from(bridge.textEncoderEncode(String(input)));
          const count = Math.min(bytes.length, destination?.byteLength || 0);
          if (destination && count) destination.set(bytes.subarray(0, count));
          return { read: String(input).length, written: count };
        }
        get encoding() { return "utf-8"; }
      }
      Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, { value: "TextEncoder" });
      for (const fn of [TextEncoder, TextEncoder.prototype.encode, TextEncoder.prototype.encodeInto]) {
        try { Object.defineProperty(fn, "__firefoxTraceNative", { configurable: false, value: true }); } catch {}
      }
      globalThis.TextEncoder = TextEncoder;
      if (globalThis.window && globalThis.window !== globalThis) globalThis.window.TextEncoder = TextEncoder;
    })()`, windowHost, { filename: "firefox-trace-textencoder-shape.js" });
    if (replayWindowProxy) replayWindowProxy.TextEncoder = windowHost.TextEncoder;
  }
  vm.runInNewContext("Math.random = function random() { return globalThis.__firefoxTraceNextRandom(); };", windowHost, {
    filename: "firefox-trace-random-replay.js",
  });
  if (process.env.REPLAY_TRACE_TIME === "1") {
    vm.runInNewContext("(() => { const NativeDate = Date; const next = () => { const value = globalThis.__firefoxTraceNextTime(); if (globalThis.__firefoxTraceDateDiagnostics) globalThis.__firefoxTraceDateDiagnostics({ operation: 'now', value, stack: new Error().stack }); return value; }; function TraceDate(...args) { if (!new.target) return NativeDate(); const values = args.length ? args : [next()]; if (globalThis.__firefoxTraceDateDiagnostics) globalThis.__firefoxTraceDateDiagnostics({ operation: 'construct', argc: args.length, value: values[0], stack: new Error().stack }); return new NativeDate(...values); } TraceDate.prototype = NativeDate.prototype; Object.setPrototypeOf(TraceDate, NativeDate); TraceDate.now = next; TraceDate.parse = NativeDate.parse; TraceDate.UTC = NativeDate.UTC; Object.defineProperty(globalThis, 'Date', { configurable: true, writable: true, value: TraceDate }); Date = TraceDate; try { if (globalThis.window && globalThis.window !== globalThis) globalThis.window.Date = TraceDate; if (globalThis.globalThis && globalThis.globalThis !== globalThis) globalThis.globalThis.Date = TraceDate; } catch {} })()", windowHost, {
      filename: "firefox-trace-time-replay.js",
    });
    if (process.env.TRACE_DATE_CALLS === "1") {
      Object.defineProperty(windowHost, "__firefoxTraceDateDiagnostics", {
        configurable: true,
        value: nativeHostFunction("dateDiagnostics", (record) => {
          process.stderr.write(`${JSON.stringify({ date_replay: record })}\n`);
        }),
      });
      vm.runInNewContext("globalThis.__firefoxTraceDateDiagnostics({ operation: 'shape', bare: Date === globalThis.Date, window_date: !!globalThis.window && globalThis.window.Date === Date, global_this_date: !!globalThis.globalThis && globalThis.globalThis.Date === Date, date_name: Date && Date.name, window_is_proxy: !!globalThis.window && globalThis.window !== globalThis })", windowHost, {
        filename: "firefox-trace-time-shape.js",
      });
    }
  }
  // Browser APIs exposed to a challenge must be functions from its own realm.
  // Outer-realm closures fail both identity and prototype checks in self-tests.
  vm.runInNewContext(
    "(() => { const bridge = globalThis.__firefoxTraceHostBridge; const markNative = (fn) => { try { Object.defineProperty(fn, '__firefoxTraceNative', { configurable: false, value: true }); } catch {} return fn; }; if (typeof Uint8Array.prototype.toBase64 !== 'function') Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: markNative(function toBase64() { return bridge.toBase64(this); }) }); Object.defineProperties(Element.prototype, { getAttribute: { configurable: true, writable: true, value: markNative(function getAttribute(name) { return bridge.elementGetAttribute(this, name); }) }, setAttribute: { configurable: true, writable: true, value: markNative(function setAttribute(name, value) { return bridge.elementSetAttribute(this, name, value); }) } }); Object.defineProperties(HTMLCanvasElement.prototype, { getContext: { configurable: true, writable: true, value: markNative(function getContext(kind) { return bridge.canvasGetContext(kind, this); }) }, toDataURL: { configurable: true, writable: true, value: markNative(function toDataURL() { return bridge.canvasToDataURL(); }) } }); Object.defineProperty(Node.prototype, 'removeChild', { configurable: true, writable: true, value: markNative(function removeChild(node) { return bridge.removeChild(this, node); }) }); })()",
    windowHost,
    { filename: "firefox-trace-realm-host.js" },
  );
  if (process.env.TRACE_TYPED_ARRAYS === "1") {
    vm.runInNewContext(`(() => {
      const log = (kind, value, extra = {}) => {
        if (globalThis.__firefoxTraceTypedArrayCount >= 200) return;
        globalThis.__firefoxTraceTypedArrayCount = (globalThis.__firefoxTraceTypedArrayCount || 0) + 1;
        try { console.error(JSON.stringify({ kind, value, ...extra })); } catch {}
      };
      for (const [name, proto] of [["ArrayBuffer", ArrayBuffer.prototype], ["DataView", DataView.prototype], ["Uint8Array", Uint8Array.prototype], ["Uint16Array", Uint16Array.prototype], ["Int32Array", Int32Array.prototype]]) {
        for (const key of ["byteLength", "byteOffset", "length"]) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          if (!descriptor?.get) continue;
          Object.defineProperty(proto, key, { configurable: true, get() {
            const value = descriptor.get.call(this);
            log(name + "." + key, value, { ctor: this?.constructor?.name || null });
            return value;
          }});
        }
      }
    })()`, windowHost, { filename: "firefox-trace-typed-array-diagnostics.js" });
  }
  for (const [prototype, member] of [
    [interfaces.HTMLCanvasElement, "getContext"],
    [interfaces.HTMLCanvasElement, "toDataURL"],
    [interfaces.Node, "removeChild"],
  ]) {
    nativeSources.set(prototype[member], `function ${member}() { [native code] }`);
  }
  Object.defineProperty(windowHost, "__firefoxTraceNativeSource", {
    configurable: true,
    value: (fn) => nativeSources.get(fn) || "",
  });
  if (process.env.TRACE_TOSTRING === "1") {
    let toStringCount = 0;
    Object.defineProperty(windowHost, "__firefoxTraceDebug", {
      configurable: true,
      value: nativeHostFunction("debug", (record) => {
        if (toStringCount >= 300) return;
        toStringCount += 1;
        process.stderr.write(`${JSON.stringify({ kind: "Function.prototype.toString", count: toStringCount, ...record })}\n`);
      }),
    });
  }
  vm.runInNewContext(
    "(() => { const sourceOf = globalThis.__firefoxTraceNativeSource; const debug = globalThis.__firefoxTraceDebug; delete globalThis.__firefoxTraceNativeSource; delete globalThis.__firefoxTraceDebug; const original = Function.prototype.toString; Function.prototype.toString = function toString() { const source = sourceOf(this); const native = this && this.__firefoxTraceNative ? `function ${this.name || ''}() { [native code] }` : ''; if (debug) { try { debug({ type: typeof this, name: this?.name || null, source: source || native || String(this).slice(0, 120) }); } catch {} } return source || native || original.call(this); }; })()",
    windowHost,
    { filename: "firefox-trace-native-brand.js" },
  );
  if (binaryStageLog) {
    const NativeTextEncoder = windowHost.TextEncoder;
    if (typeof NativeTextEncoder === "function") {
      const skippedEncoderInputs = new Set(String(process.env.TRACE_SKIP_ENCODER_INPUTS || "")
        .split(",").map((value) => value.trim()).filter(Boolean));
      class TraceTextEncoder extends NativeTextEncoder {
        encode(input = "") {
          if (binaryDebuggerEnabled &&
              (!binaryDebuggerInput || String(input) === binaryDebuggerInput)) debugger;
          if (skippedEncoderInputs.has(String(input))) return super.encode("");
          const output = super.encode(input);
          if (process.env.TRACE_BINARY_STACKS === "1") {
            const record = { stage: "TextEncoder.encode", input: String(input), stack: new Error().stack };
            process.stderr.write(`${JSON.stringify(record)}\n`);
          }
          logBinaryStage("TextEncoder.encode", String(input), output);
          return output;
        }
      }
      Object.defineProperty(TraceTextEncoder, "name", { value: NativeTextEncoder.name || "TextEncoder" });
      windowHost.TextEncoder = TraceTextEncoder;
      // When the Window shape is represented by a proxy, update its shape map
      // too; otherwise `window.TextEncoder` keeps the pre-wrapper constructor
      // and stage diagnostics disappear from the actual challenge realm.
      if (replayWindowProxy) replayWindowProxy.TextEncoder = TraceTextEncoder;
    }
    // Wrapping atob/btoa changes the native-function branch in the challenge;
    // their call counts are therefore left untouched during stage tracing.
  }
  let challengeText = challengeSource
    ? fs.readFileSync(challengeSource, "utf8")
    : runtimeData.challengeSource;
  if (process.env.TRACE_WRAP_VM_OPS === "1") {
    const opcodeTable = ["g", "E"].find((name) =>
      challengeText.includes(`];${name}[0]=${name};`));
    if (!opcodeTable) throw new Error("VM opcode table marker not found");
    const marker = `];${opcodeTable}[0]=${opcodeTable};`;
    const targetIndices = String(process.env.TRACE_WRAP_VM_OP_INDEX || "12,45,52,55")
      .split(",").map((value) => Number(value.trim())).filter(Number.isInteger);
    const limit = Number(process.env.TRACE_WRAP_VM_OP_LIMIT || "200");
    const replacement = `];${opcodeTable}=${opcodeTable}.map((fn,index)=>{if(![${targetIndices.join(",")}].includes(index)||typeof fn!=="function")return fn;let count=0;const describe=value=>({type:typeof value,tag:Object.prototype.toString.call(value),length:value?.length??null,byteLength:value?.byteLength??null,value:typeof value==="number"||typeof value==="string"||typeof value==="boolean"?value:null});const wrapInput=(value,depth)=>{if(typeof value!=="function"||depth>4)return value;return new Proxy(value,{apply(target,thisArg,args){let result;try{result=Reflect.apply(target,thisArg,args);if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmOpLog({index,role:"input",depth,args:args.map(describe),result:describe(result)});return result}catch(error){if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmLog({index,role:"input",depth,error:String(error)});throw error}}})};const wrapResult=(value,depth)=>{if(typeof value!=="function"||depth>4)return value;return new Proxy(value,{apply(target,thisArg,args){let result;try{result=Reflect.apply(target,thisArg,args.map(value=>wrapInput(value,depth)));if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmOpLog({index,depth,args:args.map(describe),result:describe(result)});return wrapResult(result,depth+1)}catch(error){if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmLog({index,depth,error:String(error)});throw error}}})};return new Proxy(fn,{apply(target,thisArg,args){let result;try{result=Reflect.apply(target,thisArg,args.map(value=>wrapInput(value,0)));if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmOpLog({index,depth:0,args:args.map(describe),result:describe(result)});return wrapResult(result,1)}catch(error){if(count++<${limit}&&globalThis.__firefoxTraceVmOpLog)globalThis.__firefoxTraceVmOpLog({index,depth:0,error:String(error)});throw error}}})});${opcodeTable}[0]=${opcodeTable};`;
    challengeText = challengeText.replace(marker, replacement);
    // Keep the error path on the same bounded logger as normal VM calls.
    challengeText = challengeText.replaceAll("__firefoxTraceVmLog", "__firefoxTraceVmOpLog");
    Object.defineProperty(windowHost, "__firefoxTraceVmOpLog", {
      configurable: true,
      value: nativeHostFunction("vmOpLog", (record) => {
        const minimum = Number(process.env.TRACE_WRAP_VM_OP_MIN_VALUE || "-Infinity");
        if (Number.isFinite(minimum) && (!Number.isFinite(record?.result?.value) || record.result.value < minimum) && !record?.error) return;
        process.stderr.write(`${JSON.stringify({ vm_op: record })}\n`);
      }),
    });
  }
  vm.runInNewContext(challengeText, windowHost, {
    filename: path.basename(challengeSourceLabel),
    timeout: Number(process.env.TRACE_RUNTIME_TIMEOUT_MS || "20000"),
  });
  const runtime = windowHost.reese84;
  console.log(JSON.stringify({
    status: "script_initialized",
    script: path.basename(challengeSourceLabel),
    exports: runtime && typeof runtime === "object" ? Object.keys(runtime).sort() : [],
    network: "disabled",
  }, null, 2));
  const protection = runtime.initializeProtection();
  let interrogation = { state: "pending" };
  Promise.resolve(protection.interrogate()).then(
    (value) => { interrogation = { state: "fulfilled", value }; },
    (error) => { interrogation = { state: "rejected", name: error.name, message: error.message }; },
  );
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const challengeCandidates = interceptedRequests
    .filter((request) => /\/rly-/.test(request.url))
    .map((request) => {
      try { return { request, body: JSON.parse(request.body) }; }
      catch { return { request, body: null }; }
    });
  // Reese sends a token/bootstrap POST before the interrogation POST. Select
  // the request carrying `solution.interrogation.p`, rather than whichever
  // rly request happened to be appended first.
  const challengeEntry = challengeCandidates
    .filter(({ body }) => typeof body?.solution?.interrogation?.p === "string")
    .sort((left, right) => right.body.solution.interrogation.p.length - left.body.solution.interrogation.p.length)[0]
    || challengeCandidates.at(-1)
    || { request: null, body: null };
  const challenge = challengeEntry.request;
  const body = challengeEntry.body;
  console.log(JSON.stringify({
    status: challenge ? "generated" : "no_challenge_request",
    compatibility_mode: compatibilityMode,
    compatibility_fallbacks: [...new Set(compatibilityFallbacks)],
    protection_type: typeof protection,
    interrogation_state: interrogation,
    request_count: interceptedRequests.length,
    url: challenge?.url || null,
    body_length: challenge?.body.length || 0,
    p_length: body?.solution?.interrogation?.p?.length || 0,
    p: body?.solution?.interrogation?.p || null,
    interrogation: body?.solution?.interrogation
      ? { st: body.solution.interrogation.st, sr: body.solution.interrogation.sr, cr: body.solution.interrogation.cr, og: body.solution.interrogation.og }
      : null,
    request_body: body,
    requests: interceptedRequests.map((request) => ({
      url: request.url,
      method: request.method,
      body_length: request.body.length,
      body_preview: request.body.slice(0, 400),
      synthetic_timer_count_at_request: request.synthetic_timer_count_at_request,
    })),
    missing_host_accesses: [...new Set(missingHostAccesses)].slice(0, 100),
    observed_host_accesses: [...new Set(observedHostAccesses)].slice(0, 100),
    event_registrations: hostEventRegistrations,
    event_dispatches: hostEventDispatches,
    event_errors: hostEventErrors,
    node_insertions: hostNodeInsertions,
    host_api_calls: hostApiCalls,
    trace_dom_replay: replayConsumptionReport(),
    mutation_observations: hostMutationObservations,
    environment_contract: {
      source: "embedded-runtime-data",
      restorable_members: environmentContract.coverage.restorable_members,
    },
    browser_live_value_source: browserLiveEvidence.source,
    synthetic_timer_count: syntheticTimerCount,
    trace_random_values_available: replayRandomValues.length,
    trace_random_values_consumed: replayRandomOffset,
    trace_random_fallbacks: replayRandomFallbacks,
    trace_time_values_available: replayTimeValues.length,
    trace_time_values_consumed: replayTimeOffset,
    trace_time_fallbacks: replayTimeFallbacks,
    crypto_random_calls: cryptoRandomCalls,
    performance_now_calls: performanceNowCalls,
    performance_now_call_count: performanceNowCallCount,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    status: "host_dependency_missing_or_runtime_failed",
    name: error.name,
    message: error.message,
    missing_host_accesses: [...new Set(missingHostAccesses)].slice(0, 100),
  }, null, 2));
  process.exitCode = 1;
}
})();
