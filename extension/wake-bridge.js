chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "touchscreen-wake-status") {
    fetch("http://127.0.0.1:8765/api/wake", { cache: "no-store" })
      .then((response) => response.json())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  }

  if (message?.type === "touchscreen-wake-ack") {
    fetch("http://127.0.0.1:8765/api/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ack",
        sequence: message.sequence,
      }),
    })
      .then((response) => response.json())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  }
});
