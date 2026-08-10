(() => {
  if (window.__creatorCapture?.installed) {
    return JSON.stringify({ installed: true, reused: true, events: window.__creatorCapture.events.length });
  }

  const state = window.__creatorCapture = {
    installed: true,
    installedAt: Date.now(),
    events: [],
  };
  const interesting = (url) => /(?:upload\/auth|upload\/v1|post_assistant|creator\/get\/url|user_declaration|create_v2)/.test(String(url));
  const keep = (event) => {
    state.events.push({ at: Date.now(), ...event });
    if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  };

  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    xhrMeta.set(this, { method: String(method), url: String(url), headers: {} });
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const meta = xhrMeta.get(this);
    if (meta) meta.headers[String(name)] = String(value);
    return nativeSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = xhrMeta.get(this);
    if (meta && interesting(meta.url)) {
      const bodyText = typeof body === "string" && body.length <= 65536 ? body : null;
      keep({ phase: "request", transport: "xhr", ...meta, body: bodyText });
      this.addEventListener("loadend", () => {
        let response = null;
        try {
          if (typeof this.responseText === "string" && this.responseText.length <= 131072) response = this.responseText;
        } catch {}
        keep({
          phase: "response",
          transport: "xhr",
          method: meta.method,
          url: this.responseURL || meta.url,
          status: this.status,
          response,
        });
      }, { once: true });
    }
    return nativeSend.call(this, body);
  };

  const nativeFetch = window.fetch;
  window.fetch = async function(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init.method || (input instanceof Request ? input.method : "GET"));
    if (!interesting(url)) return nativeFetch.apply(this, arguments);
    const body = typeof init.body === "string" && init.body.length <= 65536 ? init.body : null;
    keep({ phase: "request", transport: "fetch", method, url, body });
    try {
      const response = await nativeFetch.apply(this, arguments);
      let responseText = null;
      try {
        const text = await response.clone().text();
        if (text.length <= 131072) responseText = text;
      } catch {}
      keep({ phase: "response", transport: "fetch", method, url: response.url || url, status: response.status, response: responseText });
      return response;
    } catch (error) {
      keep({ phase: "error", transport: "fetch", method, url, error: String(error) });
      throw error;
    }
  };

  return JSON.stringify({ installed: true, reused: false, installed_at: state.installedAt });
})()
