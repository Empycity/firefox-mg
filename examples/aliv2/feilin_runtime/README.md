# FeiLin005 Browser Runtime

This directory is an isolated copy of the browser shim used to execute the
real FeiLin script from the 2026-09-02 trace.

The script is loaded as `feilin.js`; the runtime input is the decrypted
`deviceConfig` object from the current `InitCaptchaV2` response.

## Run

```bash
node run_feilin005.js device-config.json
```

The runner forwards the real FeiLin execution result as a
`__FEILIN_RESULT__` JSON line. `deviceConfig.version`, `timestamp`, `ip`, and
`certifyId` are per-Init values and must come from that same session.

No baseline file is loaded. The runner resolves the FeiLin script from the
current Init response and keeps all environment/runtime values dynamic.

The shim emits FeiLin005's 127-field device string. `rawJoined` remains
available as a diagnostic-only 142-field object, while `zhiw` is the value to
feed into the downstream device-token builder. Per-run fields (collector
bitmap, token pair, timestamps, certifyId, Init timestamp, IP and timing
markers) are generated from the current invocation; no baseline file is read
unless explicitly requested.
