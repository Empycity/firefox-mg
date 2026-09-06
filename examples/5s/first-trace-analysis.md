# 5s / simple.ripley.com.pe first trace review

Historical source: `firefox-trace-20260816-122142`. The external trace directory
is disposable; retained runtime evidence lives under `examples/5s/log/trace-fixture`.

## Network sequence observed

1. `GET https://simple.ripley.com.pe/` -> Cloudflare challenge page.
2. `GET /cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=...` -> main challenge script, artifact `e6c09e...js`, 227713 bytes.
3. `GET https://challenges.cloudflare.com/turnstile/.../api.js?...` -> Turnstile script, artifact `73eae66...js`, 82465 bytes.
4. First-party `POST /cdn-cgi/challenge-platform/h/g/fo/.../<cf-chl>` with headers `cf-chl`, `cf-chl-ra`, `Idempotency-Key`, text/plain body 2274 then 8780 bytes.
5. Turnstile iframe `POST https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/fo/.../<cf-chl>` with text/plain body 4503 then 87426 bytes.
6. PAT/peek fetches: `/pat/...` returned 401 with `www-authenticate: PrivateToken ...`; `hagen.challenges.cloudflare.com/.../i/...` returned 204.
7. After `cf_clearance` appears, browser posts back to `https://simple.ripley.com.pe/` and then loads `/home` assets.
8. Later JS detection script `https://simple.ripley.com.pe/cdn-cgi/challenge-platform/h/g/scripts/jsd/aae2b9a1c261/main.js?` posts `POST /cdn-cgi/challenge-platform/h/g/jsd/oneshot/...` with content length about 14200.

## Important fields for next capture

- Query: `__cf_chl_rt_tk`, `__cf_chl_tk`
- Headers: `cf-chl`, `cf-chl-ra`, `Idempotency-Key`
- Cookies: `__cf_bm`, `cf_clearance`, `_cfuvid`, `productlistpage_bff_token`
- Body: Cloudflare uses opaque `text/plain` challenge blobs, so there is no named body field; keep full XHR body capture instead.

## Producer evidence from first trace

- First-party `cf-chl`: producer matched by value SHA to function `O` in `/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=...`, line 3 column 67499; parent chain `O -> bm`.
- First-party `cf-chl-ra`: same script, function `O`, parent `bm`.
- Turnstile iframe `cf-chl`: producer matched by value SHA to function `O` in the Turnstile iframe page, line 1 column 144883; parent chain `O -> Ov` and later `O -> Ov -> bZ`.
- `__cf_bm` / `cf_clearance` are server-set lifecycle values; producer is HTTP Set-Cookie, not local JS.

## Browser improvement gap

The current trace records final parent-channel request headers even with raw HTTP off, and captures XHR/Fetch bodies fully. The navigation/form `POST https://simple.ripley.com.pe/` after clearance only has final headers in this run; request body bytes for non-XHR/non-Fetch navigation/form POST are the main browser-trace gap to verify or implement.

## Next config

The historical next-trace configuration targeted a fresh active full-chain run
with Cloudflare fields enabled, VM/WASM off, Cloudflare script filtering, value
spooling, full XHR/Fetch bodies, and HTTP raw response chunks for one short window.
