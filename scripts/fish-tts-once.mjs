import { writeFile } from "node:fs/promises";

const outputPath =
  process.env.FISH_TTS_OUTPUT || "/private/tmp/pi-inline-voice-question.wav";
const text =
  process.env.FISH_TTS_TEXT ||
  "Please ask Open Claw which realtime model this touchscreen is using, then tell me the answer.";

async function readSecretFromStdin() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return await new Promise((resolve, reject) => {
      let value = "";
      const finish = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(value.trim());
      };
      const onData = (chunk) => {
        const textChunk = String(chunk);
        if (textChunk.includes("\u0003")) {
          process.stdin.setRawMode(false);
          reject(new Error("Fish Audio request cancelled"));
          return;
        }
        const newline = textChunk.search(/[\r\n]/);
        value += newline === -1 ? textChunk : textChunk.slice(0, newline);
        if (newline !== -1) finish();
      };
      process.stdin.on("data", onData);
    });
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const apiKey = await readSecretFromStdin();
if (!apiKey) throw new Error("Fish Audio API key was not provided on stdin");

const response = await fetch("https://api.fish.audio/v1/tts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    model: "s2-pro",
  },
  body: JSON.stringify({
    text,
    format: "wav",
    sample_rate: 44_100,
    normalize: true,
    prosody: {
      speed: 0.95,
      volume: 0,
      normalize_loudness: true,
    },
  }),
});
if (!response.ok) throw new Error(`Fish Audio TTS failed (${response.status})`);
const audio = Buffer.from(await response.arrayBuffer());
if (audio.length < 1_000) throw new Error("Fish Audio returned an empty response");
await writeFile(outputPath, audio, { mode: 0o600 });
console.log(
  JSON.stringify({
    ok: true,
    model: "s2-pro",
    format: "wav",
    bytes: audio.length,
    outputPath,
  }),
);
