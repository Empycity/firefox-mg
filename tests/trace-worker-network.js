self.onmessage = async () => {
  const fetchResponse = await fetch("/worker-fetch?source=dedicated-worker", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trace-worker-test": "fetch",
    },
    body: JSON.stringify({transport: "fetch", marker: "worker-fetch-body"}),
  });
  const fetchResult = await fetchResponse.json();

  const xhrResult = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/worker-xhr?source=dedicated-worker");
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("x-trace-worker-test", "xhr");
    xhr.onload = () => resolve(JSON.parse(xhr.responseText));
    xhr.onerror = () => reject(new Error("worker XHR failed"));
    xhr.send(JSON.stringify({transport: "xhr", marker: "worker-xhr-body"}));
  });

  self.postMessage({fetchResult, xhrResult});
};
