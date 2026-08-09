const target = document.querySelector("#target");
const result = document.querySelector("#result");

function readInteractionSurface(event) {
  const rect = target.getBoundingClientRect();
  return {
    type: event.type,
    clientX: event.clientX,
    clientY: event.clientY,
    pageX: event.pageX,
    pageY: event.pageY,
    pointerId: event.pointerId,
    pressure: event.pressure,
    width: rect.width,
    height: rect.height,
    element: document.elementFromPoint(event.clientX, event.clientY)?.id || "",
  };
}

let getterCallCount = 0;
function nestedGetterValue() {
  getterCallCount += 1;
  return "getter-value";
}

function readGetterFixture(value) {
  return value.scriptedGetter;
}

async function runSmoke() {
  const getterValue = readGetterFixture({
    get scriptedGetter() {
      return nestedGetterValue();
    },
  });
  const randomVector = [Math.random(), Math.random(), Math.random()];
  const interaction = readInteractionSurface(new PointerEvent("pointermove", {
    clientX: 12,
    clientY: 18,
    pointerId: 7,
    pressure: 0.5,
  }));

  const xhrText = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/trace-response.json?trace_token=xhr-query-token");
    xhr.setRequestHeader("content-type", "application/json");
    xhr.onload = () => resolve(xhr.responseText);
    xhr.onerror = reject;
    xhr.send(JSON.stringify({trace_token: "xhr-body-token"}));
  });

  const fetchResponse = await fetch("/trace-response.json?trace_token=fetch-query-token", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({trace_token: "fetch-body-token"}),
  });
  const fetchText = await fetchResponse.text();
  result.textContent = JSON.stringify({
    getterValue,
    getterCallCount,
    randomVector,
    interaction,
    xhrText,
    fetchText,
  });
  document.title = "trace-smoke-complete";
}

let runPromise;
target.addEventListener("click", () => {
  runPromise = runSmoke();
});
target.dispatchEvent(new MouseEvent("click", {bubbles: true, clientX: 12, clientY: 18}));
await runPromise;
