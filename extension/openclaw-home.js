(() => {
  if (document.getElementById("touchscreen-launcher-return")) return;

  const host = document.createElement("div");
  host.id = "touchscreen-launcher-return";
  host.style.position = "fixed";
  host.style.top = "18px";
  host.style.right = "18px";
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "closed" });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "⌂  Home";
  button.setAttribute("aria-label", "Return to touchscreen home");
  button.style.cssText = [
    "appearance:none",
    "border:1px solid rgba(16,76,61,.22)",
    "border-radius:999px",
    "background:rgba(247,245,237,.96)",
    "box-shadow:0 8px 24px rgba(12,51,42,.16)",
    "color:#17342d",
    "cursor:pointer",
    "font:700 14px/1 system-ui,sans-serif",
    "letter-spacing:.08em",
    "padding:14px 18px",
    "text-transform:uppercase"
  ].join(";");
  button.addEventListener("click", () => {
    window.location.assign("http://127.0.0.1:8765/");
  });

  shadow.append(button);
  document.documentElement.append(host);

  let wakeStarting = false;
  const watchWakeWord = window.setInterval(() => {
    if (wakeStarting) return;
    chrome.runtime.sendMessage(
      { type: "touchscreen-wake-status" },
      (status) => {
        if (chrome.runtime.lastError || !status?.pending || wakeStarting) return;

        const buttons = [...document.querySelectorAll("button")];
        buttons
          .find(
            (candidate) =>
              candidate.getAttribute("aria-label") ===
              "Dismiss voice input error",
          )
          ?.click();

        const stopButton = buttons.find(
          (candidate) =>
            candidate.getAttribute("aria-label") === "Stop voice input",
        );
        const startButton = buttons.find(
          (candidate) =>
            candidate.getAttribute("aria-label") === "Start voice input",
        );
        if (!stopButton && !startButton) return;

        wakeStarting = true;
        startButton?.click();
        window.setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "touchscreen-wake-ack",
            sequence: status.sequence,
          });
          wakeStarting = false;
        }, 1_500);
      },
    );
  }, 800);

  window.addEventListener(
    "pagehide",
    () => window.clearInterval(watchWakeWord),
    { once: true },
  );
})();
