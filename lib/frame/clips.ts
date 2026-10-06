/**
 * Plays a bird's own recording through the Pi's speaker and reports its level
 * so the song ribbon can move to the sound.
 */

export type ClipHandle = {
  stop: () => void;
};

type ClipCallbacks = {
  onStart?: (durationSeconds: number) => void;
  onLevel?: (level: number) => void;
  onEnd?: () => void;
};

let current: ClipHandle | null = null;

export function stopClip(): void {
  current?.stop();
  current = null;
}

export function playClip(url: string, callbacks: ClipCallbacks = {}): ClipHandle {
  stopClip();
  const audio = new Audio(url);
  audio.preload = "auto";
  let context: AudioContext | null = null;
  let frame = 0;
  let stopped = false;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(frame);
    audio.pause();
    audio.src = "";
    void context?.close();
    callbacks.onLevel?.(0);
    callbacks.onEnd?.();
    if (current === handle) current = null;
  };

  const handle: ClipHandle = { stop: finish };
  current = handle;

  audio.addEventListener("loadedmetadata", () => {
    callbacks.onStart?.(Number.isFinite(audio.duration) ? audio.duration : 10);
  });
  audio.addEventListener("ended", finish);
  audio.addEventListener("error", finish);

  const meter = () => {
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass || !callbacks.onLevel) return;
    context = new AudioContextClass();
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(context.destination);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      callbacks.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      frame = window.requestAnimationFrame(measure);
    };
    frame = window.requestAnimationFrame(measure);
  };

  try {
    meter();
  } catch {
    // Without a meter the clip still plays; the ribbon simply pulses.
  }
  void audio.play().catch(finish);
  return handle;
}
