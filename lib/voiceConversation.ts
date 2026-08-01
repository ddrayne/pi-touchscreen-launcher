export type VoiceConversationEntry = {
  id: number;
  transcriptId?: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  revealFrom?: number;
};

export type VoiceTranscriptUpdate = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
};

function comparableTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-GB")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function updateVoiceConversation(
  entries: VoiceConversationEntry[],
  update: VoiceTranscriptUpdate,
  createId = () => Date.now() + Math.floor(Math.random() * 1000),
): VoiceConversationEntry[] {
  const next = [...entries];
  let targetIndex = update.id
    ? next.findIndex((entry) => entry.transcriptId === update.id)
    : -1;

  if (targetIndex < 0) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const candidate = next[index];
      if (candidate.role === update.role && candidate.streaming) {
        targetIndex = index;
        break;
      }
    }
  }

  // Realtime deltas are incremental and frequently begin with the space that
  // belongs before the next word. Preserve that whitespace once a transcript
  // exists; trimming every fragment briefly creates one long unbroken string.
  const text = update.final ? update.text.trim() : update.text;
  if (!text.trim() && (update.final || targetIndex < 0)) return entries;

  if (targetIndex >= 0) {
    const target = next[targetIndex];
    const settledTarget = { ...target };
    delete settledTarget.revealFrom;
    next[targetIndex] = {
      ...settledTarget,
      ...(update.id ? { transcriptId: update.id } : {}),
      // A completed transcript is authoritative. Replacing the streamed
      // fragments also repairs duplicate compatibility deltas. Realtime item
      // ids let late input finals merge even after assistant output has begun.
      text: update.final ? text : `${target.text}${text}`,
      streaming: !update.final,
      ...(!update.final ? { revealFrom: target.text.length } : {}),
    };
  } else {
    if (update.final) {
      const duplicate = next.findLast(
        (entry) =>
          entry.role === update.role &&
          comparableTranscript(entry.text) === comparableTranscript(text),
      );
      if (duplicate) return entries;
    }
    next.push({
      id: createId(),
      ...(update.id ? { transcriptId: update.id } : {}),
      role: update.role,
      text: update.final ? text : text.trimStart(),
      streaming: !update.final,
      ...(!update.final ? { revealFrom: 0 } : {}),
    });
  }
  return next.slice(-6);
}
