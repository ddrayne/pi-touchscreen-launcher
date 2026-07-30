import WebSocket from "ws";

const debuggerOrigin =
  process.env.TOUCHSCREEN_CDP_ORIGIN || "http://127.0.0.1:9223";
const launcherUrl =
  process.env.TOUCHSCREEN_LAUNCHER_URL || "http://127.0.0.1:8765/";

const pages = await fetch(`${debuggerOrigin}/json/list`).then((response) =>
  response.json(),
);
const page = pages.find((entry) => entry.type === "page");
if (!page) throw new Error("No Chromium page target found");

const socketUrl = page.webSocketDebuggerUrl.replace(
  "127.0.0.1:9222",
  new URL(debuggerOrigin).host,
);
const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

let nextId = 0;
const pending = new Map();
socket.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(
      response.result.exceptionDetails.exception?.description ||
        response.result.exceptionDetails.text,
    );
  }
  return response.result?.result?.value;
}

await call("Runtime.enable");
await call("Page.enable");

await evaluate(`(() => {
  [...document.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === "End voice conversation")
    ?.click();
})()`);
await new Promise((resolve) => setTimeout(resolve, 1_000));

await call("Page.navigate", { url: launcherUrl });
await new Promise((resolve) => setTimeout(resolve, 2_000));

const result = await evaluate(
  `(async () => {
    const withTimeout = (promise, label, milliseconds = 10_000) =>
      Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(label + " timed out after " + milliseconds + "ms")),
            milliseconds,
          ),
        ),
      ]);
    const summary = {
      page: location.href,
      microphone: null,
      camera: null,
      speaker: null,
    };

    let audioStream;
    let audioContext;
    try {
      audioStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        "microphone capture",
      );
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let peak = 0;
      let sumSquares = 0;
      let sampleCount = 0;
      const deadline = performance.now() + 3_000;
      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) {
          peak = Math.max(peak, Math.abs(sample));
          sumSquares += sample * sample;
          sampleCount += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const audioTrack = audioStream.getAudioTracks()[0];
      summary.microphone = {
        live: audioTrack?.readyState === "live",
        enabled: audioTrack?.enabled === true,
        peak: Number(peak.toFixed(5)),
        rms: Number(Math.sqrt(sumSquares / sampleCount).toFixed(5)),
        settings: audioTrack?.getSettings(),
      };
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0.035;
      oscillator.frequency.value = 523.25;
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.25);
      await new Promise((resolve) => {
        oscillator.addEventListener("ended", resolve, { once: true });
      });
      summary.speaker = {
        rendered: true,
        sampleRate: audioContext.sampleRate,
        testToneHz: 523.25,
      };
    } catch (error) {
      summary.audioError = String(error?.stack || error);
    } finally {
      audioStream?.getTracks().forEach((track) => track.stop());
      await audioContext?.close();
    }

    try {
      const response = await withTimeout(
        fetch("/api/camera.jpg?diagnostic=" + Date.now(), {
          cache: "no-store",
        }),
        "native camera capture",
      );
      if (!response.ok) throw new Error("camera HTTP " + response.status);
      const imageBlob = await response.blob();
      const imageUrl = URL.createObjectURL(imageBlob);
      const image = new Image();
      image.src = imageUrl;
      await withTimeout(image.decode(), "camera image decode");
      summary.camera = {
        live: true,
        width: image.naturalWidth,
        height: image.naturalHeight,
        bytes: imageBlob.size,
        type: imageBlob.type,
      };
      URL.revokeObjectURL(imageUrl);
    } catch (error) {
      summary.cameraError = String(error?.stack || error);
    }
    return summary;
  })()`,
  true,
);

console.log(JSON.stringify(result, null, 2));
socket.close();
