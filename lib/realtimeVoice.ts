export type InlineVoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type InlineVoiceTranscript = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
};

export type InlineVoiceCallbacks = {
  onStatus: (status: InlineVoiceStatus, detail?: string) => void;
  onInputLevel: (level: number) => void;
  onTranscript: (entry: InlineVoiceTranscript) => void;
  onIdleTimeout?: () => void;
};

type WebRtcSession = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
};

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  arguments?: string;
  error?: unknown;
  response?: { status?: string };
};

type ToolBuffer = {
  name: string;
  callId: string;
  args: string;
};

const CONSULT_TOOL = "openclaw_agent_consult";
const CONTROL_TOOL = "openclaw_agent_control";
const OFFER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 45_000;
const MAX_UTTERANCE_MS = 15_000;
const TURN_RESPONSE_TIMEOUT_MS = 8_000;
const TURN_COMPLETE_DELAY_MS = 900;
const RESPONSE_PLAYBACK_TIMEOUT_MS = 12_000;

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `Voice service request failed (${response.status})`,
    );
  }
  return result as T;
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function errorDetail(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "Realtime provider error";
  }
  const record = error as Record<string, unknown>;
  for (const key of ["message", "code", "type"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return "Realtime provider error";
}

class InputMeter {
  private context: AudioContext | null = null;
  private frame = 0;

  constructor(private readonly onLevel: (level: number) => void) {}

  start(stream: MediaStream): void {
    const AudioContextClass =
      window.AudioContext ||
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / samples.length);
      this.onLevel(Math.min(1, Math.max(0, rms * 5.5)));
      this.frame = window.requestAnimationFrame(measure);
    };
    this.context = context;
    this.frame = window.requestAnimationFrame(measure);
  }

  stop(): void {
    window.cancelAnimationFrame(this.frame);
    this.onLevel(0);
    void this.context?.close();
    this.context = null;
  }
}

export class InlineRealtimeVoice {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private meter: InputMeter | null = null;
  private closed = false;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCreatePending = false;
  private toolBuffers = new Map<string, ToolBuffer>();
  private offerAbort: AbortController | null = null;
  private idleTimer = 0;
  private sessionTimer = 0;
  private utteranceTimer = 0;
  private turnLocked = false;
  private outputAudioActive = false;
  private responseHasAssistantOutput = false;
  private responseCompleted = false;
  private userTranscriptSeen = false;
  private readonly toolAborts = new Set<AbortController>();
  private activeConsults = 0;

  constructor(private readonly callbacks: InlineVoiceCallbacks) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("This browser does not provide microphone WebRTC");
    }
    this.closed = false;
    this.callbacks.onStatus("connecting", "Connecting to OpenClaw");
    const session = await postJson<WebRtcSession>("/api/voice/session", {});
    if (this.closed) return;
    if (session.transport !== "webrtc" || !session.clientSecret) {
      throw new Error("OpenClaw did not return a browser voice session");
    }

    const peer = new RTCPeerConnection();
    this.peer = peer;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.hidden = true;
    document.body.append(audio);
    this.audio = audio;
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (!stream || !this.audio) return;
      this.audio.srcObject = stream;
      void this.audio.play().catch(() => undefined);
    });

    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (this.closed || this.peer !== peer) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    this.meter = new InputMeter(this.callbacks.onInputLevel);
    this.meter.start(media);
    for (const track of media.getAudioTracks()) peer.addTrack(track, media);

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("message", (event) => this.handleEvent(event.data));
    channel.addEventListener("open", () => {
      if (this.closed) return;
      this.callbacks.onStatus("listening", "I’m listening");
      this.scheduleIdleTimeout();
      this.sessionTimer = window.setTimeout(
        () => this.callbacks.onIdleTimeout?.(),
        SESSION_TIMEOUT_MS,
      );
    });
    channel.addEventListener("close", () => {
      if (!this.closed) this.callbacks.onStatus("error", "Realtime connection closed");
    });
    peer.addEventListener("connectionstatechange", () => {
      if (
        !this.closed &&
        (peer.connectionState === "failed" || peer.connectionState === "closed")
      ) {
        this.callbacks.onStatus("error", "Realtime connection closed");
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.offerAbort = new AbortController();
    const offerTimeout = window.setTimeout(
      () => this.offerAbort?.abort(new Error("Realtime connection timed out")),
      OFFER_TIMEOUT_MS,
    );
    try {
      const answer = await fetch(
        session.offerUrl || "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            ...session.offerHeaders,
            Authorization: `Bearer ${session.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          signal: this.offerAbort.signal,
        },
      );
      if (!answer.ok) throw new Error(`Realtime connection failed (${answer.status})`);
      if (this.closed || this.peer !== peer) return;
      await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    } finally {
      window.clearTimeout(offerTimeout);
      this.offerAbort = null;
    }
  }

  stop(): void {
    this.closed = true;
    this.offerAbort?.abort();
    this.offerAbort = null;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    window.clearTimeout(this.sessionTimer);
    this.sessionTimer = 0;
    window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = 0;
    for (const controller of this.toolAborts) controller.abort();
    this.toolAborts.clear();
    this.channel?.close();
    this.peer?.close();
    this.media?.getTracks().forEach((track) => track.stop());
    this.meter?.stop();
    this.audio?.remove();
    this.channel = null;
    this.peer = null;
    this.media = null;
    this.meter = null;
    this.audio = null;
    this.toolBuffers.clear();
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCreatePending = false;
    this.activeConsults = 0;
    this.turnLocked = false;
    this.outputAudioActive = false;
    this.responseHasAssistantOutput = false;
    this.responseCompleted = false;
    this.userTranscriptSeen = false;
    this.callbacks.onInputLevel(0);
    this.callbacks.onStatus("idle");
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private handleEvent(raw: unknown): void {
    if (this.closed) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(String(raw)) as RealtimeEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.userTranscriptSeen = true;
          this.callbacks.onTranscript({
            role: "user",
            text: event.delta,
            final: false,
          });
        }
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.userTranscriptSeen = true;
          this.callbacks.onTranscript({
            role: "user",
            text: event.transcript,
            final: true,
          });
          if (this.activeConsults > 0) void this.maybeControlActiveRun(event.transcript);
        }
        return;
      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.clearIdleTimeout();
          this.responseHasAssistantOutput = true;
          this.callbacks.onStatus("speaking", "Speaking");
          this.callbacks.onTranscript({
            role: "assistant",
            text: event.delta,
            final: false,
          });
        }
        return;
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text = event.transcript || event.text;
        if (text) this.callbacks.onTranscript({ role: "assistant", text, final: true });
        return;
      }
      case "response.function_call_arguments.delta":
        this.bufferTool(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleTool(event);
        return;
      case "input_audio_buffer.speech_started":
        this.clearIdleTimeout();
        if (!this.turnLocked) {
          window.clearTimeout(this.utteranceTimer);
          this.utteranceTimer = window.setTimeout(
            () => this.lockTurn(),
            MAX_UTTERANCE_MS,
          );
        }
        this.callbacks.onStatus("listening", "Speech detected");
        return;
      case "input_audio_buffer.speech_stopped":
        this.clearIdleTimeout();
        this.lockTurn();
        return;
      case "output_audio_buffer.started":
        this.outputAudioActive = true;
        this.clearIdleTimeout();
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.outputAudioActive = false;
        if (this.turnLocked && this.responseCompleted && this.responseHasAssistantOutput) {
          this.scheduleIdleTimeout(TURN_COMPLETE_DELAY_MS);
        }
        return;
      case "response.created":
        this.clearIdleTimeout();
        this.responseActive = true;
        this.responseCompleted = false;
        this.responseHasAssistantOutput = false;
        this.responseCreateInFlight = false;
        this.callbacks.onStatus("thinking", "Thinking");
        return;
      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCompleted = true;
        this.responseCreateInFlight = false;
        this.callbacks.onStatus("listening", "I’m listening");
        this.flushResponseCreate();
        if (this.turnLocked && this.responseHasAssistantOutput) {
          if (!this.outputAudioActive) {
            this.scheduleIdleTimeout(TURN_COMPLETE_DELAY_MS);
          } else {
            this.scheduleIdleTimeout(RESPONSE_PLAYBACK_TIMEOUT_MS);
          }
        } else if (this.turnLocked && event.type === "response.cancelled") {
          this.scheduleIdleTimeout(TURN_COMPLETE_DELAY_MS);
        } else {
          this.scheduleIdleTimeout();
        }
        return;
      case "error":
        this.responseCreateInFlight = false;
        this.callbacks.onStatus("error", errorDetail(event.error));
        return;
      default:
        return;
    }
  }

  private bufferTool(event: RealtimeEvent): void {
    const key = event.item_id || "unknown";
    const existing = this.toolBuffers.get(key);
    if (existing) {
      existing.args += event.delta || "";
      return;
    }
    this.toolBuffers.set(key, {
      name: event.name || "",
      callId: event.call_id || "",
      args: event.delta || "",
    });
  }

  private async handleTool(event: RealtimeEvent): Promise<void> {
    const key = event.item_id || "unknown";
    const buffered = this.toolBuffers.get(key);
    this.toolBuffers.delete(key);
    const name = buffered?.name || event.name || "";
    const callId = buffered?.callId || event.call_id || "";
    if (!callId) return;
    const args = parseArgs(buffered?.args || event.arguments || "{}");
    if (!this.userTranscriptSeen) {
      const inferredUserText =
        name === CONSULT_TOOL && typeof args.question === "string"
          ? args.question
          : name === CONTROL_TOOL && typeof args.text === "string"
            ? args.text
            : "";
      if (inferredUserText.trim()) {
        this.userTranscriptSeen = true;
        this.callbacks.onTranscript({
          role: "user",
          text: inferredUserText.trim(),
          final: true,
        });
      }
    }
    const controller = new AbortController();
    this.toolAborts.add(controller);
    try {
      this.clearIdleTimeout();
      let result: unknown;
      if (name === CONSULT_TOOL) {
        this.activeConsults += 1;
        this.callbacks.onStatus("thinking", "Checking with OpenClaw");
        result = await postJson("/api/voice/tool", { callId, name, args }, controller.signal);
      } else if (name === CONTROL_TOOL) {
        result = await postJson(
          "/api/voice/control",
          {
            text: typeof args.text === "string" ? args.text : "",
            mode: typeof args.mode === "string" ? args.mode : "",
          },
          controller.signal,
        );
      } else {
        result = { error: `Unsupported voice tool: ${name}` };
      }
      this.submitToolResult(callId, result);
    } catch (error) {
      if (!this.closed) {
        this.submitToolResult(callId, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (name === CONSULT_TOOL) this.activeConsults = Math.max(0, this.activeConsults - 1);
      this.toolAborts.delete(controller);
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.requestResponseCreate();
  }

  private requestResponseCreate(): void {
    if (this.responseActive || this.responseCreateInFlight) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.send({ type: "response.create" });
  }

  private flushResponseCreate(): void {
    if (!this.responseCreatePending) return;
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private async maybeControlActiveRun(transcript: string): Promise<void> {
    const normalized = transcript.trim().toLowerCase();
    let mode: "cancel" | "status" | "steer" | undefined;
    if (
      /^(?:ok(?:ay)?[,\s]+)?(?:please\s+)?(?:cancel|abort|stop|never mind|nevermind|forget it)\b/.test(
        normalized,
      )
    ) {
      mode = "cancel";
    } else if (
      /^(?:status|progress|update|what(?:'s| is) happening|are you still working)\b/.test(
        normalized,
      )
    ) {
      mode = "status";
    } else if (/^(?:actually|instead|change|switch|focus|use|try|redirect)\b/.test(normalized)) {
      mode = "steer";
    }
    if (!mode) return;
    try {
      const result = await postJson<Record<string, unknown>>("/api/voice/control", {
        text: transcript,
        mode,
      });
      if (
        this.responseActive &&
        result.ok === true &&
        (result.mode === "cancel" ||
          (result.suppress === true && result.mode !== "steer"))
      ) {
        this.send({ type: "response.cancel" });
      }
    } catch {
      // The provider's explicit control tool remains available as a fallback.
    }
  }

  private clearIdleTimeout(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
  }

  private lockTurn(): void {
    if (this.turnLocked) return;
    this.turnLocked = true;
    window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = 0;
    this.media?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    this.meter?.stop();
    this.meter = null;
    this.callbacks.onStatus("thinking", "Thinking");
    this.scheduleIdleTimeout(TURN_RESPONSE_TIMEOUT_MS);
  }

  private scheduleIdleTimeout(delay = IDLE_TIMEOUT_MS): void {
    this.clearIdleTimeout();
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0;
      if (!this.closed && !this.responseActive && this.activeConsults === 0) {
        this.callbacks.onIdleTimeout?.();
      }
    }, delay);
  }
}
